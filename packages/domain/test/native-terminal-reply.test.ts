import { describe, expect, it } from "vitest";
import {
  NATIVE_ASSISTANT_TEXT_MAX,
  providerNativeTerminalActivitySchema,
  truncateNativeAssistantText,
} from "../src/native-terminal.js";
describe("native transcript replies", () => {
  const rule = { match: { equals: { role: "assistant" } }, text: "content" };
  const activity = (reply: unknown) => ({
    transcript: { working: [], idle: [], prompt: [], reply },
  });
  it("accepts up to eight reply rules and old declarations", () => {
    expect(
      providerNativeTerminalActivitySchema.parse(activity([rule])).transcript
        ?.reply,
    ).toEqual([rule]);
    expect(
      providerNativeTerminalActivitySchema.safeParse(
        activity(Array(8).fill(rule)),
      ).success,
    ).toBe(true);
    expect(
      providerNativeTerminalActivitySchema.safeParse(
        activity(Array(9).fill(rule)),
      ).success,
    ).toBe(false);
    expect(
      providerNativeTerminalActivitySchema.safeParse(
        activity([{ ...rule, text: "bad path" }]),
      ).success,
    ).toBe(false);
    expect(
      providerNativeTerminalActivitySchema.safeParse({
        transcript: { working: [], idle: [], prompt: [] },
      }).success,
    ).toBe(true);
  });
});

describe("native assistant text truncation", () => {
  it.each([
    {
      label: "emoji split at the UTF-16 tail boundary",
      input: "x" + "🙂" + "a".repeat(4095),
      expected: "a".repeat(4095),
    },
    {
      label: "emoji fully inside the UTF-8 tail",
      input: "x" + "🙂" + "a".repeat(4092),
      expected: "🙂" + "a".repeat(4092),
    },
  ])("keeps a code-point suffix without replacement characters ($label)", ({ input, expected }) => {
    const result = truncateNativeAssistantText(input);
    expect(result).toBe(expected);
    expect(result).not.toContain("\uFFFD");
    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(input.endsWith(result ?? "")).toBe(true);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(NATIVE_ASSISTANT_TEXT_MAX);
  });
});
