import { describe, expect, it } from "vitest";
import {
  consumeTerminalAttention,
  INITIAL_TERMINAL_ATTENTION_PARSER_STATE,
} from "./terminal-attention-parser.js";

const bytes = (value: string) => Buffer.from(value, "utf8");

describe("terminal attention parser", () => {
  it("finds bells and supported OSC notifications across chunk boundaries", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(state, bytes("prompt\u0007\u001b]9;hel")),
    ).toEqual([{ kind: "bell" }]);
    expect(
      consumeTerminalAttention(
        state,
        bytes("lo\u0007\u001b]777;notify;Build;Done\u001b\\"),
      ),
    ).toEqual([
      { kind: "osc-9", body: "hello" },
      { kind: "osc-777", title: "Build", body: "Done" },
    ]);
  });

  it("recognizes OSC 9, 99 and 777 notifications", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes(
          "\u001b]9;hello\u0007\u001b]99;Agent;Ready\u0007\u001b]777;notify;Build;Done\u0007",
        ),
      ),
    ).toEqual([
      { kind: "osc-9", body: "hello" },
      { kind: "osc-99", title: "Agent", body: "Ready" },
      { kind: "osc-777", title: "Build", body: "Done" },
    ]);
  });

  it("ignores numeric OSC 9 subcommands such as progress reports", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(state, bytes("\u001b]9;4;1;75\u0007")),
    ).toEqual([]);
  });

  it("preserves an OSC opener split after the escape byte", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(consumeTerminalAttention(state, bytes("\u001b"))).toEqual([]);
    expect(consumeTerminalAttention(state, bytes("]9;split\u0007"))).toEqual([
      { kind: "osc-9", body: "split" },
    ]);
  });

  it("preserves a UTF-8 character split between output chunks", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    const notification = bytes("\u001b]9;café 🐈\u0007");
    const split = notification.indexOf(0xc3) + 1;
    expect(
      consumeTerminalAttention(state, notification.subarray(0, split)),
    ).toEqual([]);
    expect(
      consumeTerminalAttention(state, notification.subarray(split)),
    ).toEqual([{ kind: "osc-9", body: "café 🐈" }]);
  });

  it("ignores unrelated OSC strings and bounds an incomplete sequence", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]8;;https://example.test\u0007"),
      ),
    ).toEqual([]);
    consumeTerminalAttention(state, bytes(`\u001b]9;${"x".repeat(5000)}`));
    expect(state.pending.length).toBeLessThanOrEqual(4096);
  });
});
