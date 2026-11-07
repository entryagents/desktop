import { describe, expect, test } from "bun:test";
import { sanitizeCommandOutput } from "./bash";

describe("sanitizeCommandOutput", () => {
  test("preserves normal stdout and stderr", () => {
    const input =
      "Build passed successfully with 0 errors.\n4 packages bundled.";
    expect(sanitizeCommandOutput(input)).toBe(input);
  });

  test("truncates long data URL module dumps", () => {
    const fakeBase64 = "A".repeat(400);
    const input = `Error: Failed to import data:text/javascript;base64,${fakeBase64} into worker`;
    const sanitized = sanitizeCommandOutput(input);
    expect(sanitized).toContain(
      "data:text/javascript;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA...[truncated 368 base64 chars]",
    );
    expect(sanitized.length).toBeLessThan(input.length);
  });

  test("truncates massive unbroken base64 tokens", () => {
    const runawayBase64 = "B".repeat(600);
    const input = `Uncaught base64 bundle dump: ${runawayBase64} end of trace`;
    const sanitized = sanitizeCommandOutput(input);
    expect(sanitized).toContain(
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB...[truncated 552 chars]",
    );
  });
});
