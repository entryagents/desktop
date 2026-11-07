import {
  type LanguageModelUsage,
  type ModelMessage,
  tool,
  type UIToolInvocation,
} from "ai";
import { z } from "zod";
import {
  buildSubagentSummaryLines,
  SUBAGENT_REGISTRY,
  SUBAGENT_TYPES,
} from "../subagents/registry";
import { SUBAGENT_STEP_LIMIT } from "../subagents/constants";
import { sumLanguageModelUsage } from "../usage";
import { getSandboxContext, getSubagentModel } from "./utils";
import type { AgentContext, SubagentBudgetGuard } from "../types";

const subagentTypeSchema = z.enum(SUBAGENT_TYPES);

const subagentSummaryLines = buildSubagentSummaryLines();

const taskInputSchema = z.object({
  subagentType: subagentTypeSchema.describe(
    `Subagent to launch. Available options:\n${subagentSummaryLines}`,
  ),
  task: z
    .string()
    .describe("Short description of the task (displayed to user)"),
  instructions: z.string().describe(
    `Detailed instructions for the subagent. Include:
- Goal and deliverables
- Step-by-step procedure
- Constraints and patterns to follow
- How to verify the work`,
  ),
});

const taskPendingToolCallSchema = z.object({
  name: z.string(),
  input: z.unknown(),
});

export type TaskPendingToolCall = z.infer<typeof taskPendingToolCallSchema>;

export const taskOutputSchema = z.object({
  pending: taskPendingToolCallSchema.optional(),
  toolCallCount: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  modelId: z.string().optional(),
  final: z.custom<ModelMessage[]>().optional(),
  usage: z.custom<LanguageModelUsage>().optional(),
});

export type TaskToolOutput = z.infer<typeof taskOutputSchema>;

export const taskTool = tool({
  needsApproval: false,
  description: `Launch a specialized subagent to handle complex tasks autonomously.

AVAILABLE SUBAGENTS:
${subagentSummaryLines}

WHEN TO USE:
- Clearly-scoped work that can be delegated with explicit instructions
- Work where focused execution would clutter the main conversation
- Tasks that match one of the available subagent descriptions above

WHEN NOT TO USE (do it yourself):
- Simple, single-file or single-change edits
- Tasks where you already have all the context you need
- Ambiguous work that requires back-and-forth clarification

BEHAVIOR:
- Subagents work AUTONOMOUSLY without asking follow-up questions
- They run up to ${SUBAGENT_STEP_LIMIT} tool steps and then return
- They return ONLY a concise summary - their internal steps are isolated from the parent

HOW TO USE:
- Choose the appropriate subagentType based on the subagent descriptions above
- Provide a short task string (for display) summarizing the goal
- Provide detailed instructions including goals, steps, constraints, and verification criteria

IMPORTANT:
- Be explicit and concrete - subagents cannot ask clarifying questions
- Include critical context (APIs, function names, file paths) in the instructions
- The parent agent will not see the subagent's internal tool calls, only its final summary`,
  inputSchema: taskInputSchema,
  outputSchema: taskOutputSchema,
  execute: async function* (
    { subagentType, task, instructions },
    { experimental_context, abortSignal },
  ) {
    const sandboxContext = getSandboxContext(experimental_context, "task");
    const model = getSubagentModel(experimental_context, "task");
    const subagentModelId = typeof model === "string" ? model : model.modelId;

    const subagent = SUBAGENT_REGISTRY[subagentType].agent;

    // Real-time subagent budget enforcement (host-injected billing
    // guard, 2026-09-15): subagent usage previously landed in the
    // ledger only at the END of the whole turn, so a subagent could
    // spend past an Entry window mid-turn. The guard shares the parent
    // turn's in-memory window/balance counters.
    const billingGuard: SubagentBudgetGuard | undefined = (
      experimental_context as AgentContext | undefined
    )?.billingGuard;

    const startedAt = Date.now();
    let toolCallCount = 0;

    if (billingGuard) {
      const plan = billingGuard.planSubagent(subagentModelId);
      if (plan.stop) {
        // Even a first subagent step doesn't fit the remaining budget --
        // refuse the launch with zero spend. Wording mirrors the main
        // model's window/credit exhaustion notices.
        const reasonText =
          plan.reason === "window"
            ? "usage window exhausted"
            : "credit balance exhausted";
        const refused: ModelMessage[] = [
          {
            role: "assistant",
            content: `Task not started: the user's ${reasonText}. Ask them to wait for the window to refill or top up, then re-invoke this task.`,
          },
        ];
        yield {
          final: refused,
          toolCallCount,
          startedAt,
          modelId: subagentModelId,
        };
        return;
      }
    }

    // The subagent gets its own abort controller so the BUDGET guard
    // can stop just the subagent without killing the parent turn --
    // the parent's signal is forwarded so user-initiated stops still
    // abort everything.
    const localAbort = new AbortController();
    const forwardParentAbort = () => localAbort.abort();
    if (abortSignal?.aborted) {
      localAbort.abort();
    } else {
      abortSignal?.addEventListener("abort", forwardParentAbort);
    }

    let budgetStopped = false;
    let budgetStopReason: "window" | "credit" | undefined;

    const userPrompt = `Task: ${task}\n\nInstructions:\n${instructions}\n\nPlease complete this task thoroughly. When finished, your final turn MUST be a text message containing both **Summary** and **Answer** detailing what you found or changed. Do not end your execution on a tool call without a final summary.`;

    let streamError: string | undefined;
    let result: Awaited<ReturnType<typeof subagent.stream>> | undefined;

    try {
      result = await subagent.stream({
        prompt: userPrompt,
        options: {
          task,
          instructions,
          sandbox: sandboxContext.sandbox,
          model,
          ...(billingGuard
            ? (() => {
                const plan = billingGuard.planSubagent(subagentModelId);
                return plan.maxOutputTokens
                  ? { maxOutputTokens: plan.maxOutputTokens }
                  : {};
              })()
            : {}),
        },
        abortSignal: localAbort.signal,
      });
    } catch (err) {
      streamError = err instanceof Error ? err.message : String(err);
    }

    let pending: TaskPendingToolCall | undefined;
    let usage: LanguageModelUsage | undefined;
    let consecutiveRepeatedCalls = 0;
    let lastCallSignature = "";

    // Emit an initial state so UIs can show elapsed time from a stable timestamp.
    yield { toolCallCount, startedAt, modelId: subagentModelId };

    if (streamError || !result) {
      const errorMsg: ModelMessage[] = [
        {
          role: "assistant",
          content: `[Subagent error: ${streamError ?? "Failed to initialize subagent stream"}]`,
        },
      ];
      yield {
        final: errorMsg,
        toolCallCount,
        startedAt,
        modelId: subagentModelId,
      };
      return;
    }

    try {
      for await (const part of result.fullStream) {
        if (part.type === "error") {
          streamError =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
        }

        if (part.type === "tool-call") {
          toolCallCount += 1;
          pending = { name: part.toolName, input: part.input };

          try {
            const signature = `${part.toolName}:${JSON.stringify(part.input)}`;
            if (signature === lastCallSignature) {
              consecutiveRepeatedCalls += 1;
              if (consecutiveRepeatedCalls >= 3) {
                streamError = `Repetitive tool call loop detected: \`${part.toolName}\` was invoked 3 consecutive times with identical input without progress.`;
                localAbort.abort();
              }
            } else {
              consecutiveRepeatedCalls = 1;
              lastCallSignature = signature;
            }
          } catch {
            // Ignore serialization errors
          }

          yield {
            pending,
            toolCallCount,
            usage,
            startedAt,
            modelId: subagentModelId,
          };
        }

        if (part.type === "finish-step") {
          usage = sumLanguageModelUsage(usage, part.usage);
          if (billingGuard) {
            const plan = billingGuard.noteSubagentStepUsage(
              subagentModelId,
              part.usage,
            );
            if (plan.stop) {
              budgetStopped = true;
              budgetStopReason = plan.reason;
              localAbort.abort();
            }
          }
          yield {
            pending,
            toolCallCount,
            usage,
            startedAt,
            modelId: subagentModelId,
          };
        }
      }
    } catch (err) {
      streamError = err instanceof Error ? err.message : String(err);
    }

    abortSignal?.removeEventListener("abort", forwardParentAbort);

    let response: Awaited<typeof result.response> | undefined;
    try {
      response = await result.response;
    } catch (err) {
      if (!streamError) {
        streamError = err instanceof Error ? err.message : String(err);
      }
    }

    let finalUsage = usage;
    if (!finalUsage && result) {
      try {
        finalUsage = await result.usage;
      } catch {
        finalUsage = undefined;
      }
    }
    const baseMessages = response?.messages ?? [];

    if (streamError) {
      const messagesWithError: ModelMessage[] = [
        ...baseMessages,
        {
          role: "assistant",
          content: `[Subagent error: ${streamError}]`,
        },
      ];
      yield {
        final: messagesWithError,
        toolCallCount,
        usage: finalUsage,
        startedAt,
        modelId: subagentModelId,
      };
      return;
    }

    if (budgetStopped) {
      const reasonText =
        budgetStopReason === "window"
          ? "usage window"
          : budgetStopReason === "credit"
            ? "credit balance"
            : "usage limit";
      const truncated: ModelMessage[] = [
        ...baseMessages,
        {
          role: "assistant",
          content: `[Budget limit reached: this subagent was stopped by the user's ${reasonText}. The work above is partial -- the remaining steps were not run.]`,
        },
      ];
      yield {
        final: truncated,
        toolCallCount,
        usage: finalUsage,
        startedAt,
        modelId: subagentModelId,
      };
      return;
    }

    yield {
      final: baseMessages,
      toolCallCount,
      usage: finalUsage,
      startedAt,
      modelId: subagentModelId,
    };
  },
  toModelOutput: ({ output: { final: messages } }) => {
    if (!messages || messages.length === 0) {
      return {
        type: "text",
        value: "Subagent completed without producing messages.",
      };
    }

    // Extract all executed tool calls for diagnostics
    const executedActions: string[] = [];
    for (const m of messages) {
      const content = (m as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as {
            type?: string;
            toolName?: string;
            args?: unknown;
            input?: unknown;
          };
          if (p.type === "tool-call") {
            const input = (p.input ?? p.args) as
              | Record<string, unknown>
              | undefined;
            const target =
              input?.path ??
              input?.command ??
              input?.pattern ??
              input?.query ??
              "";
            const targetStr = target
              ? `: \`${String(target).slice(0, 80)}\``
              : "";
            executedActions.push(`- \`${p.toolName}\`${targetStr}`);
          }
        }
      }
    }

    // 1. Check for explicit error messages or budget abort notices
    const errorNotice = messages.findLast((m) => {
      const c = (m as { content?: unknown }).content;
      return (
        typeof c === "string" &&
        (c.startsWith("[Budget limit reached:") ||
          c.startsWith("[Subagent error:"))
      );
    });
    if (errorNotice && typeof errorNotice.content === "string") {
      const executed =
        executedActions.length > 0
          ? `\n\nPartial actions completed before failure (${executedActions.length}):\n${executedActions.slice(-10).join("\n")}`
          : "";
      return { type: "text", value: `${errorNotice.content}${executed}` };
    }

    // 2. Search assistant messages backwards for substantive text content
    const assistantMessages = messages.filter((p) => p.role === "assistant");

    // First pass: search backwards for an assistant message with structured **Summary** or **Answer**
    let substantiveText: string | undefined;
    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      const msg = assistantMessages[i];
      const content = msg?.content;
      if (typeof content === "string") {
        if (content.includes("**Summary**") || content.includes("**Answer**")) {
          substantiveText = content;
          break;
        }
      } else if (Array.isArray(content)) {
        const textParts = content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .filter((t) => t.trim().length > 0);
        const combined = textParts.join("\n\n");
        if (
          combined.includes("**Summary**") ||
          combined.includes("**Answer**")
        ) {
          substantiveText = combined;
          break;
        }
      }
    }

    // Second pass: fallback to the last non-empty assistant text
    if (!substantiveText) {
      for (let i = assistantMessages.length - 1; i >= 0; i--) {
        const msg = assistantMessages[i];
        const content = msg?.content;
        if (typeof content === "string" && content.trim().length > 0) {
          substantiveText = content;
          break;
        }
        if (Array.isArray(content)) {
          const textParts = content
            .filter(
              (p): p is { type: "text"; text: string } => p.type === "text",
            )
            .map((p) => p.text)
            .filter((t) => t.trim().length > 0);
          if (textParts.length > 0) {
            substantiveText = textParts.join("\n\n");
            break;
          }
        }
      }
    }

    if (substantiveText) {
      return { type: "text", value: substantiveText };
    }

    // 3. If no text was produced, return reconstructed actions and clear diagnostics
    const actionDetails =
      executedActions.length > 0
        ? `\n\nExecuted actions:\n${executedActions.slice(-15).join("\n")}`
        : "";

    return {
      type: "text",
      value: `Subagent completed without emitting a final text summary (${executedActions.length} tool call${executedActions.length === 1 ? "" : "s"} executed).${actionDetails}\n\nCheck the affected files directly to verify the outcome.`,
    };
  },
});

export type TaskToolUIPart = UIToolInvocation<typeof taskTool>;
