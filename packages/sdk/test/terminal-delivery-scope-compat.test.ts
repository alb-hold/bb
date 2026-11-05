import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ExperimentalTerminalDeliveryScope,
  ExperimentalTerminalFocusArgs,
  ThreadOpenArgs,
  ThreadOpenDeliveryScope,
} from "@bb/sdk";

describe("terminal delivery scope type", () => {
  it("keeps the previously exported name interchangeable with the shared scope", () => {
    const scope: ExperimentalTerminalDeliveryScope = {
      all: true,
      callerThreadId: "thr_caller",
    };
    const shared: ThreadOpenDeliveryScope = scope;

    expect(shared).toEqual({ all: true, callerThreadId: "thr_caller" });
    expectTypeOf<ExperimentalTerminalDeliveryScope>().toEqualTypeOf<ThreadOpenDeliveryScope>();
    expectTypeOf<ExperimentalTerminalFocusArgs>().toMatchTypeOf<ExperimentalTerminalDeliveryScope>();
    expectTypeOf<ThreadOpenArgs>().toMatchTypeOf<ExperimentalTerminalDeliveryScope>();
  });
});
