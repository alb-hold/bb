import { describe, expect, it } from "vitest";
import { providerNativeTerminalActivitySchema } from "../src/native-terminal.js";
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
