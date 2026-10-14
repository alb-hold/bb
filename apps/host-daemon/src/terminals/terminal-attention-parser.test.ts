import { describe, expect, it } from "vitest";
import {
  consumeTerminalAttention,
  INITIAL_TERMINAL_ATTENTION_PARSER_STATE,
} from "./terminal-attention-parser.js";

const bytes = (value: string) => Buffer.from(value, "utf8");

describe("terminal attention parser", () => {
  it("finds bells and supported OSC notifications across chunk boundaries", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(consumeTerminalAttention(state, bytes("prompt\u0007\u001b]9;hel"))).toEqual([
      { kind: "bell" },
    ]);
    expect(consumeTerminalAttention(state, bytes("lo\u0007\u001b]777;notify;Build;Done\u001b\\"))).toEqual([
      { kind: "osc-9", body: "hello" },
      { kind: "osc-777", title: "Build", body: "Done" },
    ]);
  });

  it("ignores unrelated OSC strings and bounds an incomplete sequence", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(consumeTerminalAttention(state, bytes("\u001b]8;;https://example.test\u0007"))).toEqual([]);
    consumeTerminalAttention(state, bytes(`\u001b]9;${"x".repeat(5000)}`));
    expect(state.pending.length).toBeLessThanOrEqual(4096);
  });
});
