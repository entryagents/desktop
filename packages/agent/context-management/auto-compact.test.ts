import { describe, expect, test } from "bun:test";
import type { LanguageModel, ModelMessage } from "ai";
import { maybeCompactMessages } from "./auto-compact";

describe("maybeCompactMessages gateway parameter support", () => {
  test("does not trigger compaction early at 48k when gateway contextWindowOverride is 400k", () => {
    // 60k tokens (~240k chars) is above the old 48k ceiling, but well below 95% of 400k (380k tokens)
    const largeText = "a".repeat(240_000);
    const messages: ModelMessage[] = Array.from({ length: 16 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: i === 0 ? largeText : `msg-${i}`,
    }));

    const result = maybeCompactMessages({
      messages,
      model: "openai/gpt-5.3-codex" as unknown as LanguageModel,
      contextWindowOverride: 400_000,
    });

    expect(result).toBe(messages);
  });

  test("honors custom compactionThresholdOverride from gateway", () => {
    const text = "a".repeat(80_000);
    const messages: ModelMessage[] = Array.from({ length: 16 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: i === 0 ? text : `msg-${i}`,
    }));

    const result = maybeCompactMessages({
      messages,
      model: "openai/gpt-5.3-codex" as unknown as LanguageModel,
      contextWindowOverride: 100_000,
      compactionThresholdOverride: 0.8,
    });

    expect(result).toBe(messages);
  });
});
