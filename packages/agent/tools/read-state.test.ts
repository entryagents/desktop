import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  checkReadGate,
  createReadFileState,
  ensureReadFileState,
  rebuildReadFileState,
} from "./read-state";

function toolResultMessage(
  toolName: string,
  output: Record<string, unknown>,
): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-result",
        toolCallId: `call-${toolName}-${Math.random()}`,
        toolName,
        output,
      } as never,
    ],
  } as never;
}

describe("rebuildReadFileState", () => {
  test("empty messages produce an empty store", () => {
    const state = rebuildReadFileState([]);
    expect(state.size).toBe(0);
  });

  test("folds only read outputs into the store", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("read", {
        success: true,
        path: "a.txt",
        contentHash: "h-a-1",
      }),
      toolResultMessage("edit", {
        success: true,
        path: "a.txt",
        contentHash: "h-a-2",
      }),
      toolResultMessage("write", {
        success: true,
        path: "b.txt",
        contentHash: "h-b-1",
      }),
    ];
    const state = rebuildReadFileState(messages);
    expect(state.get("a.txt")).toBe("h-a-1"); // writes are not read evidence
    expect(state.has("b.txt")).toBe(false);
  });

  test("skips failed outputs, foreign tools, and malformed entries", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("read", {
        success: false,
        error: "boom",
        path: "a.txt",
        contentHash: "h-a",
      }),
      toolResultMessage("bash", {
        success: true,
        path: "a.txt",
        contentHash: "h-a",
      }),
      toolResultMessage("read", { success: true, path: "no-hash.txt" }),
      toolResultMessage("read", { success: true, contentHash: "orphan" }),
      toolResultMessage("read", {
        success: true,
        path: "",
        contentHash: "empty-path",
      }),
    ];
    const state = rebuildReadFileState(messages);
    expect(state.size).toBe(0);
  });

  test("clears and refills a reused store instance", () => {
    const state = createReadFileState();
    state.set("old.txt", "stale-hash");
    rebuildReadFileState(
      [
        toolResultMessage("read", {
          success: true,
          path: "new.txt",
          contentHash: "h-new",
        }),
      ],
      state,
    );
    expect(state.has("old.txt")).toBe(false);
    expect(state.get("new.txt")).toBe("h-new");
  });
  test("folds toModelOutput wrapped json into the store", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            output: {
              type: "json",
              value: {
                success: true,
                path: "src/main.ts",
                contentHash: "hash-main",
              },
            },
          } as never,
        ],
      } as never,
    ];
    const state = rebuildReadFileState(messages);
    expect(state.get("src/main.ts")).toBe("hash-main");
    expect(checkReadGate(state, "./src/main.ts", "hash-main", "edit").ok).toBe(
      true,
    );
  });

  test("folds result property format into the store", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "read",
            result: {
              success: true,
              path: "src/api.ts",
              contentHash: "hash-api",
            },
          } as never,
        ],
      } as never,
    ];
    const state = rebuildReadFileState(messages);
    expect(state.get("src/api.ts")).toBe("hash-api");
    expect(checkReadGate(state, "src/api.ts", "hash-api", "write").ok).toBe(
      true,
    );
  });
});

describe("ensureReadFileState", () => {
  test("lazily attaches one shared store and reuses it", () => {
    const context: { readFileState?: unknown } = {};
    const first = ensureReadFileState(context);
    first.set("a.txt", "h");
    const second = ensureReadFileState(context);
    expect(second).toBe(first);
    expect(second.get("a.txt")).toBe("h");
  });
});

describe("checkReadGate", () => {
  test("unread file is rejected with a recovery message", () => {
    const state = createReadFileState();
    const result = checkReadGate(state, "a.txt", "h-now", "edit");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unread");
      expect(result.message).toContain("File has not been read yet");
      expect(result.message).toContain("read tool");
    }
  });

  test("changed file is rejected as stale", () => {
    const state = createReadFileState();
    state.set("a.txt", "h-old");
    const result = checkReadGate(state, "a.txt", "h-now", "edit");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stale");
      expect(result.message).toContain("changed since it was last read");
    }
  });

  test("matching hash passes", () => {
    const state = createReadFileState();
    state.set("a.txt", "h-now");
    expect(checkReadGate(state, "a.txt", "h-now", "write")).toEqual({
      ok: true,
    });
  });
});
