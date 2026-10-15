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
          "\u001b]9;hello\u0007\u001b]99;p=title;Agent\u001b\\\u001b]777;notify;Build;Done\u0007",
        ),
      ),
    ).toEqual([
      { kind: "osc-9", body: "hello" },
      { kind: "osc-99", title: "Agent" },
      { kind: "osc-777", title: "Build", body: "Done" },
    ]);
  });

  it("parses spec-valid OSC 99 metadata with default title and done values", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=notice-1;Build finished\u001b\\"),
      ),
    ).toEqual([{ kind: "osc-99", title: "Build finished" }]);
  });

  it("joins OSC 99 title and body sequences by notification id", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=notice-2:d=0;Agent\u001b\\"),
      ),
    ).toEqual([]);
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=notice-2:p=body;Needs approval\u001b\\"),
      ),
    ).toEqual([
      { kind: "osc-99", title: "Agent", body: "Needs approval" },
    ]);
  });

  it("holds OSC 99 d=0 chunks until a d=1 chunk completes the notification", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=notice-3:p=title:d=0;Long\u001b\\"),
      ),
    ).toEqual([]);
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=notice-3:p=title; task\u001b\\"),
      ),
    ).toEqual([{ kind: "osc-99", title: "Long task" }]);
  });

  it("ignores OSC 99 capability queries", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(state, bytes("\u001b]99;p=?;\u001b\\")),
    ).toEqual([]);
  });

  it("decodes base64 OSC 99 payloads", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;e=1:p=body;SGVsbG8g8J+QiA==\u001b\\"),
      ),
    ).toEqual([{ kind: "osc-99", body: "Hello 🐈" }]);
  });

  it("decodes base64 OSC 99 payloads split after encoding mid-quantum", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=split:e=1:p=body:d=0;SGVsbG8\u001b\\"),
      ),
    ).toEqual([]);
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=split:e=1:p=body;gd29ybGQh\u001b\\"),
      ),
    ).toEqual([{ kind: "osc-99", body: "Hello world!" }]);
  });

  it("accepts an unpadded final base64 OSC 99 chunk", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=unpadded:e=1:p=body;SGVsbG8\u001b\\"),
      ),
    ).toEqual([{ kind: "osc-99", body: "Hello" }]);
  });

  it("decodes a UTF-8 character whose encoded bytes straddle base64 chunks", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=utf8:e=1:p=body:d=0;8J+Q\u001b\\"),
      ),
    ).toEqual([]);
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=utf8:e=1:p=body;iA==\u001b\\"),
      ),
    ).toEqual([{ kind: "osc-99", body: "🐈" }]);
  });

  it("rejects invalid base64 and invalid UTF-8 after assembling OSC 99 chunks", () => {
    const base64State = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        base64State,
        bytes("\u001b]99;i=bad-base64:e=1:p=body:d=0;SGV=\u001b\\"),
      ),
    ).toEqual([]);
    expect(
      consumeTerminalAttention(
        base64State,
        bytes("\u001b]99;i=bad-base64:e=1:p=body;bG8=\u001b\\"),
      ),
    ).toEqual([]);

    const utf8State = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        utf8State,
        bytes("\u001b]99;i=bad-utf8:e=1:p=body:d=0;AQ\u001b\\"),
      ),
    ).toEqual([]);
    expect(
      consumeTerminalAttention(
        utf8State,
        bytes("\u001b]99;i=bad-utf8:e=1:p=body;CA\u001b\\"),
      ),
    ).toEqual([]);
  });

  it("ignores malformed OSC 99 base64 payloads", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;e=1:p=body;not base64\u001b\\"),
      ),
    ).toEqual([]);
  });

  it("bounds incomplete OSC 99 notification accumulation per terminal", () => {
    const state = { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE };
    consumeTerminalAttention(
      state,
      bytes(`\u001b]99;i=large:p=body:d=0;${"x".repeat(1024)}\u001b\\`),
    );
    consumeTerminalAttention(
      state,
      bytes(`\u001b]99;i=large:p=body:d=0;${"x".repeat(1024)}\u001b\\`),
    );
    consumeTerminalAttention(
      state,
      bytes(`\u001b]99;i=large:p=body:d=0;${"x".repeat(1024)}\u001b\\`),
    );
    consumeTerminalAttention(
      state,
      bytes(`\u001b]99;i=large:p=body:d=0;${"x".repeat(1024)}\u001b\\`),
    );
    expect(state.osc99AssemblyBytes ?? 0).toBeLessThanOrEqual(4096);
    expect(
      consumeTerminalAttention(
        state,
        bytes("\u001b]99;i=large:p=body;done\u001b\\"),
      ),
    ).toEqual([]);
    expect(state.osc99AssemblyBytes).toBe(0);
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
