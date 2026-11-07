import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { taskTool } from "./task";

describe("taskTool.toModelOutput", () => {
  test("returns text from last assistant message with summary and answer", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "**Summary**: All 7 files reviewed.\n\n**Answer**: Clean.",
          },
        ],
      } as never,
    ];
    const out = (
      taskTool as unknown as {
        toModelOutput: (arg: unknown) => { type: string; value: string };
      }
    ).toModelOutput({ output: { final: messages } });
    expect(out.value).toContain("All 7 files reviewed");
    expect(out.value).toContain("Clean");
  });

  test("prioritizes message with Summary and Answer over intermediate thought", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "**Summary**: Completed implementation.\n\n**Answer**: Added 3 files.",
          },
        ],
      } as never,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running quick check now..." },
          { type: "tool-call", toolCallId: "c1", toolName: "read", args: {} },
        ],
      } as never,
    ];
    const out = (
      taskTool as unknown as {
        toModelOutput: (arg: unknown) => { type: string; value: string };
      }
    ).toModelOutput({ output: { final: messages } });
    expect(out.value).toContain("**Summary**: Completed implementation.");
    expect(out.value).toContain("**Answer**: Added 3 files.");
  });

  test("reconstructs executed actions when no text was produced at all", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read",
            input: { path: "src/solver.ts" },
          },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "grep",
            input: { query: "cube" },
          },
        ],
      } as never,
    ];
    const out = (
      taskTool as unknown as {
        toModelOutput: (arg: unknown) => { type: string; value: string };
      }
    ).toModelOutput({ output: { final: messages } });
    expect(out.value).toContain(
      "Subagent completed without emitting a final text summary",
    );
    expect(out.value).toContain("2 tool calls executed");
    expect(out.value).toContain("Executed actions:");
    expect(out.value).toContain("src/solver.ts");
    expect(out.value).toContain("cube");
  });

  test("surfaces error notices explicitly", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: "[Subagent error: Gateway rate limit exceeded]",
      } as never,
    ];
    const out = (
      taskTool as unknown as {
        toModelOutput: (arg: unknown) => { type: string; value: string };
      }
    ).toModelOutput({ output: { final: messages } });
    expect(out.value).toBe("[Subagent error: Gateway rate limit exceeded]");
  });

  test("surfaces budget limit notices explicitly", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content:
          "[Budget limit reached: this subagent was stopped by the user's usage window. The work above is partial -- the remaining steps were not run.]",
      } as never,
    ];
    const out = (
      taskTool as unknown as {
        toModelOutput: (arg: unknown) => { type: string; value: string };
      }
    ).toModelOutput({ output: { final: messages } });
    expect(out.value).toContain("[Budget limit reached");
  });

  test("surfaces error notices with partial executed actions when available", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read",
            input: { path: "src/broken.ts" },
          },
        ],
      } as never,
      {
        role: "assistant",
        content:
          "[Subagent error: Repetitive tool call loop detected: `read` was invoked 3 consecutive times with identical input without progress.]",
      } as never,
    ];
    const out = (
      taskTool as unknown as {
        toModelOutput: (arg: unknown) => { type: string; value: string };
      }
    ).toModelOutput({ output: { final: messages } });
    expect(out.value).toContain(
      "[Subagent error: Repetitive tool call loop detected",
    );
    expect(out.value).toContain(
      "Partial actions completed before failure (1):",
    );
    expect(out.value).toContain("src/broken.ts");
  });

  test("handles empty messages gracefully", () => {
    const out = (
      taskTool as unknown as {
        toModelOutput: (arg: unknown) => { type: string; value: string };
      }
    ).toModelOutput({ output: { final: [] } });
    expect(out.value).toContain("without producing messages");
  });
});
