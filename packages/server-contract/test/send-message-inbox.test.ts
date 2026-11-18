import { describe, expect, it } from "vitest";
import { sendMessageRequestSchema } from "../src/index.js";

const input = [{ type: "text", text: "hello", mentions: [] }];

describe("sendMessageRequestSchema inbox mode", () => {
  it("accepts an inbox send with a deliverBy", () => {
    expect(
      sendMessageRequestSchema.safeParse({
        input,
        mode: "inbox",
        deliverBy: 1_700_000_000_000,
      }).success,
    ).toBe(true);
  });

  it("rejects deliverBy on any other mode", () => {
    const result = sendMessageRequestSchema.safeParse({
      input,
      mode: "queue-if-active",
      deliverBy: 1_700_000_000_000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects inbox combined with sendAt or compactFirst", () => {
    expect(
      sendMessageRequestSchema.safeParse({
        input,
        mode: "inbox",
        sendAt: 1_700_000_000_000,
      }).success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({
        input,
        mode: "inbox",
        compactFirst: true,
      }).success,
    ).toBe(false);
  });
});
