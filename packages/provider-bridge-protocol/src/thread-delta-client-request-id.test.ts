import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ClientTurnRequestId, ThreadEvent } from "@bb/domain";
import { createDeltaAssembler } from "./assembler/index.js";
import { threadDeltaSchema } from "./thread-delta.js";

const CREQ = "creq_abcdefghjk" as ClientTurnRequestId;

function userMessageItems(events: readonly ThreadEvent[]) {
  return events.flatMap((event) =>
    event.type === "item/completed" && event.item.type === "userMessage"
      ? [event.item]
      : [],
  );
}

function assembleInput(delta: unknown) {
  const parsed = threadDeltaSchema.parse(delta);
  const assembler = createDeltaAssembler({
    providerId: "pi",
    entropyPrefix: "compat",
    textDeltaFlushMs: 0,
  });
  assembler.assemble({ threadId: "thr_1", deltas: [{ kind: "turn.open" }] });
  return {
    parsed,
    events: assembler.assemble({ threadId: "thr_1", deltas: [parsed] }),
  };
}

describe("input.provider clientRequestId wire compatibility", () => {
  it("parses a delta from a plugin that predates the field and assembles an item without it", () => {
    const { parsed, events } = assembleInput({
      kind: "input.provider",
      text: "hello",
    });
    expect(parsed).toEqual({ kind: "input.provider", text: "hello" });
    const [item] = userMessageItems(events);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty("clientRequestId");
  });

  it("carries the id onto the assembled user message when a plugin sends it", () => {
    const { events } = assembleInput({
      kind: "input.provider",
      text: "hello",
      clientRequestId: CREQ,
    });
    expect(userMessageItems(events)[0]).toMatchObject({
      clientRequestId: CREQ,
    });
  });

  it("is stripped, not rejected, by a reader whose schema predates the field", () => {
    const previousShape = z.object({
      kind: z.literal("input.provider"),
      text: z.string().min(1),
      parentRef: z.string().optional(),
    });
    expect(
      previousShape.parse({
        kind: "input.provider",
        text: "hello",
        clientRequestId: CREQ,
      }),
    ).toEqual({ kind: "input.provider", text: "hello" });
  });

  it("rejects a malformed id", () => {
    expect(
      threadDeltaSchema.safeParse({
        kind: "input.provider",
        text: "hello",
        clientRequestId: "not-a-request-id",
      }).success,
    ).toBe(false);
  });
});
