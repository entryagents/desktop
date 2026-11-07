/**
 * Entry Desktop sidecar — local agent runtime.
 *
 * Adapted from apps/desktop-spike/src/desktop-host.ts (Phase 5/6, tested):
 * LocalSandbox (contained to the project root) + the REAL openAgent loop +
 * per-call gateway transport (session token via gatewayConfig — never env).
 *
 * The desktop app talks to the Entry API with the paired session token:
 *   baseURL = <api-base>/api/desktop   →  POST <api-base>/api/desktop/chat
 * (the AI SDK appends /chat/completions to the base URL).
 */
import { randomUUID } from "node:crypto";
import { connectSandbox } from "@entry-agents/sandbox";
import type { Sandbox, SandboxState } from "@entry-agents/sandbox";
import { openAgent, type OpenAgentCallOptions } from "@entry-agents/agent";

export interface DesktopBackendConfig {
  /** e.g. https://entry-agents.dev/api/desktop (SDK appends /chat/completions) */
  baseURL: string;
  /** Paired user session token (device-code flow). */
  sessionToken: string;
}

export interface EntryAgentHostOptions {
  projectRoot: string;
  backend: DesktopBackendConfig;
  modelId: string;
  allowedRoots?: string[];
  extraTools?: OpenAgentCallOptions["extraTools"];
  appName?: string;
  appUrl?: string;
}

export type DesktopIpcRequest =
  | { type: "send"; text: string; messageId?: string }
  | { type: "approval"; approvalId: string; approved: boolean; reason?: string }
  | { type: "stop" };

export type DesktopIpcEvent =
  | { type: "turn-started"; turnId: string }
  | { type: "text-delta"; turnId: string; text: string }
  | { type: "reasoning-delta"; turnId: string; text: string }
  | { type: "tool-call"; turnId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; turnId: string; toolCallId: string; output: unknown }
  | { type: "tool-error"; turnId: string; toolCallId: string; errorText: string }
  | { type: "approval-request"; turnId: string; approvalId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "usage"; turnId: string; inputTokens: number; cachedInputTokens: number; outputTokens: number }
  | { type: "error"; turnId: string; message: string }
  | { type: "turn-finished"; turnId: string; finishReason: string }
  | { type: "stopped"; turnId: string };

/** Maps ONE AI SDK UI message chunk to zero or more IPC events. Pure. */
export function mapChunkToIpcEvents(
  chunk: Record<string, unknown>,
  turnId: string,
): DesktopIpcEvent[] {
  const type = chunk.type as string | undefined;
  switch (type) {
    case "text-delta": {
      const text = (chunk.delta ?? chunk.textDelta ?? "") as string;
      return text ? [{ type: "text-delta", turnId, text }] : [];
    }
    case "reasoning-delta": {
      const text = (chunk.delta ?? chunk.textDelta ?? "") as string;
      return text ? [{ type: "reasoning-delta", turnId, text }] : [];
    }
    case "tool-input-available":
      return [{
        type: "tool-call",
        turnId,
        toolCallId: String(chunk.toolCallId),
        toolName: String(chunk.toolName),
        input: chunk.input,
      }];
    case "tool-output-available":
      return [{ type: "tool-result", turnId, toolCallId: String(chunk.toolCallId), output: chunk.output }];
    case "tool-output-error":
      return [{ type: "tool-error", turnId, toolCallId: String(chunk.toolCallId), errorText: String(chunk.errorText ?? "tool failed") }];
    case "tool-approval-request":
      return [{
        type: "approval-request",
        turnId,
        approvalId: String(chunk.approvalId),
        toolCallId: String(chunk.toolCallId),
        toolName: String(chunk.toolName ?? ""),
        input: chunk.input,
      }];
    case "error":
      return [{ type: "error", turnId, message: String(chunk.errorText ?? "unknown error") }];
    default:
      return [];
  }
}

export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function accumulateUsage(
  current: TurnUsage,
  stepUsage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    cachedInputTokens?: number;
  } | null | undefined,
): TurnUsage {
  if (!stepUsage) return current;
  return {
    inputTokens: current.inputTokens + (stepUsage.inputTokens ?? 0),
    cachedInputTokens:
      current.cachedInputTokens +
      (stepUsage.inputTokenDetails?.cacheReadTokens ?? stepUsage.cachedInputTokens ?? 0),
    outputTokens: current.outputTokens + (stepUsage.outputTokens ?? 0),
  };
}

const MAX_TURN_STEPS = 50;

/**
 * Desktop harness toolset (OpenCode-informed, 2026): 10 of the agent's 17
 * tools — deterministic order, cloud/gateway CLI tools and MCP dropped for
 * beta. Fewer schemas = fewer tokens + a more focused model.
 */
export const DESKTOP_TOOLSET = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "todo_write",
  "task",
  "web_fetch",
  "web_search",
] as const;

export class EntryAgentHost {
  private sandbox: Sandbox | null = null;
  private activeTurn: { turnId: string; abort: AbortController } | null = null;
  private turnInFlight: Promise<{ messages: unknown[]; usage: TurnUsage }> | null = null;
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (d: { approved: boolean; reason?: string }) => void }
  >();
  private stopped = false;

  constructor(private readonly options: EntryAgentHostOptions) {}

  /** Boots LocalSandbox — only. An unknown provider type throws; no fallback. */
  async start(): Promise<{ sandboxState: SandboxState; workingDirectory: string }> {
    const state: SandboxState = {
      type: "local",
      rootDir: this.options.projectRoot,
    } as SandboxState;
    this.sandbox = await connectSandbox(state, {
      allowedRoots: this.options.allowedRoots,
    });
    return { sandboxState: state, workingDirectory: this.options.projectRoot };
  }

  get sandboxInstance(): Sandbox | null {
    return this.sandbox;
  }

  /** Runs one user turn end-to-end, streaming events through `emit`. */
  async send(
    text: string,
    emit: (event: DesktopIpcEvent) => void,
    history: unknown[] = [],
  ): Promise<{ messages: unknown[]; usage: TurnUsage }> {
    if (!this.sandbox) throw new Error("EntryAgentHost.start() was not called");
    if (this.stopped) throw new Error("EntryAgentHost has been stopped");
    if (this.turnInFlight) throw new Error("A turn is already in progress");

    const turnId = randomUUID();
    const abort = new AbortController();
    this.activeTurn = { turnId, abort };
    emit({ type: "turn-started", turnId });

    // Secure boundary: no token in env (agent-run bash inherits this env) —
    // transport goes per-call through the gatewayConfig seam.
    const messages = [...history, { role: "user", content: text } as never];
    let usage: TurnUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let finishReason = "unknown";

    this.turnInFlight = (async () => {
      try {
        const sandboxState = {
          type: "local",
          rootDir: this.options.projectRoot,
        } as SandboxState;
        const workingDirectory = this.options.projectRoot;

        for (let step = 0; step < MAX_TURN_STEPS; step++) {
          const stream = await openAgent.stream({
            messages: messages as never,
            options: {
              sandbox: { state: sandboxState, workingDirectory },
              model: {
                id: this.options.modelId,
                gatewayConfig: {
                  baseURL: this.options.backend.baseURL,
                  apiKey: this.options.backend.sessionToken,
                },
                // Desktop harness: compact at 80% of the window (web uses 95%).
                compactionThreshold: 0.8,
              },
              toolset: [...DESKTOP_TOOLSET],
              permissionMode: "ask",
              ...(this.options.extraTools ? { extraTools: this.options.extraTools } : {}),
            } as OpenAgentCallOptions,
            abortSignal: abort.signal,
          });

          let stepFinishReason = "unknown";
          let approvalRequest: {
            approvalId: string;
            toolCallId: string;
            toolName: string;
            input: unknown;
          } | null = null;

          for await (const chunk of stream.toUIMessageStream()) {
            const c = chunk as Record<string, unknown>;
            if (c.type === "tool-approval-request") {
              approvalRequest = {
                approvalId: String(c.approvalId),
                toolCallId: String(c.toolCallId),
                toolName: String(c.toolName ?? ""),
                input: c.input,
              };
            }
            for (const event of mapChunkToIpcEvents(c, turnId)) {
              if (event.type !== "approval-request") emit(event);
            }
            if (typeof c.type === "string" && c.type.startsWith("finish")) {
              stepFinishReason = String(c.finishReason ?? stepFinishReason);
            }
          }

          const total = await stream.totalUsage;
          usage = accumulateUsage(usage, total as never);

          const response = await stream.response;
          messages.push(...(response.messages as never[]));

          if (approvalRequest) {
            emit({ type: "approval-request", turnId, ...approvalRequest });
            const decision = await this.waitForApproval(approvalRequest.approvalId, abort.signal);
            messages.push({
              role: "tool",
              content: [{
                type: "tool-approval-response",
                approvalId: approvalRequest.approvalId,
                approved: decision.approved,
                ...(decision.reason ? { reason: decision.reason } : {}),
              }],
            } as never);
            finishReason = "tool-calls";
            continue;
          }

          finishReason = stepFinishReason;
          if (stepFinishReason !== "tool-calls") break;
        }

        emit({ type: "usage", turnId, ...usage });
        emit({ type: "turn-finished", turnId, finishReason });
        return { messages, usage };
      } catch (error) {
        if (abort.signal.aborted) {
          emit({ type: "stopped", turnId });
        } else {
          emit({ type: "error", turnId, message: error instanceof Error ? error.message : String(error) });
        }
        return { messages, usage };
      } finally {
        this.activeTurn = null;
        this.turnInFlight = null;
      }
    })();
    return this.turnInFlight;
  }

  private waitForApproval(approvalId: string, abort: AbortSignal): Promise<{ approved: boolean; reason?: string }> {
    return new Promise((resolve, reject) => {
      const pending = {
        resolve: (d: { approved: boolean; reason?: string }) => {
          abort.removeEventListener("abort", onAbort);
          resolve(d);
        },
      };
      const onAbort = () => {
        this.pendingApprovals.delete(approvalId);
        reject(new Error("Turn aborted while awaiting approval"));
      };
      this.pendingApprovals.set(approvalId, pending);
      if (abort.aborted) {
        onAbort();
        return;
      }
      abort.addEventListener("abort", onAbort, { once: true });
    });
  }

  respondToApproval(approvalId: string, decision: { approved: boolean; reason?: string }): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.pendingApprovals.delete(approvalId);
    pending.resolve(decision);
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.activeTurn?.abort.abort();
    this.activeTurn = null;
    await this.sandbox?.stop?.();
  }
}
