import { describe, expect, it } from "vitest";
import { TerminalCursorPositionQueries } from "@bb/domain";

describe("live cursor position queries", () => {
  for (const [query, replyPrefix] of [
    ["\x1b[6n", "\x1b["],
    ["\x1b[?6n", "\x1b[?"],
  ] as const) {
    for (let split = 0; split <= query.length; split++) {
      it(`answers ${JSON.stringify(query)} split at ${split} once`, () => {
        const tracker = new TerminalCursorPositionQueries(80, 24);
        const replies: string[] = [];
        const reply = (text: string) => {
          replies.push(text);
        };
        expect(
          tracker.push(`abc${query.slice(0, split)}`, reply) +
            tracker.push(`${query.slice(split)}def`, reply),
        ).toBe("abcdef");
        expect(replies).toEqual([`${replyPrefix}1;4R`]);
        expect(tracker.flush()).toBe("");
      });
    }
  }

  it("tracks cursor across CUP, relative moves, CR/LF, tabs, wrap, save/restore, alt screen, and resize", () => {
    const tracker = new TerminalCursorPositionQueries(10, 5);
    const replies: string[] = [];
    const push = (text: string) =>
      tracker.push(text, (reply) => replies.push(reply));

    expect(push("\x1b[6n")).toBe("");
    expect(push("1234567890\x1b[6n")).toBe("1234567890");
    expect(push("X\x1b[6n")).toBe("X");
    expect(push("\x1b[4;7H\x1b[6n")).toBe("\x1b[4;7H");
    expect(push("\x1b[2A\x1b[3D\x1b[6n")).toBe("\x1b[2A\x1b[3D");
    expect(push("\x1b7\x1b[?1049h\x1b[6n")).toBe("\x1b7\x1b[?1049h");
    expect(push("\x1b[?1049l\x1b[6n")).toBe("\x1b[?1049l");
    tracker.resize(3, 1);
    expect(push("\x1b[6n")).toBe("");

    expect(replies).toEqual([
      "\x1b[1;1R",
      "\x1b[1;10R",
      "\x1b[2;2R",
      "\x1b[4;7R",
      "\x1b[2;4R",
      "\x1b[1;1R",
      "\x1b[2;4R",
      "\x1b[1;3R",
    ]);
  });

  it("ignores OSC and DCS payloads so titles and hyperlinks do not move the cursor", () => {
    const tracker = new TerminalCursorPositionQueries(80, 24);
    const replies: string[] = [];
    const input =
      "\x1b]0;Window Title\x07\x1b]8;;https://example.com\x1b\\hi\x1b]8;;\x1b\\\x1bPq#0;2;0;0;0\x1b\\\x1b[6n";
    expect(tracker.push(input, (reply) => replies.push(reply))).toBe(
      input.slice(0, -4),
    );
    expect(replies).toEqual(["\x1b[1;3R"]);
  });

  it("caps replies per chunk for flood control while still stripping every query", () => {
    const tracker = new TerminalCursorPositionQueries(80, 24, 3);
    const replies: string[] = [];
    expect(
      tracker.push("\x1b[6n".repeat(10), (reply) => replies.push(reply)),
    ).toBe("");
    expect(replies).toHaveLength(3);
  });

  it("preserves non-query CSI sequences that share a prefix, aborting ESC, and flushes held prefixes on close", () => {
    const tracker = new TerminalCursorPositionQueries(80, 24);
    const replies: string[] = [];
    const input = "\x1b[6;3H\x1b[?6h\x1b[?6l\x1b\x1b[6n\x1b[6m";
    let output = "";
    for (const ch of input) {
      output += tracker.push(ch, (reply) => replies.push(reply));
    }
    expect(output).toBe("\x1b[6;3H\x1b[?6h\x1b[?6l\x1b\x1b[6m");
    expect(replies).toEqual(["\x1b[1;1R"]);

    expect(tracker.push("tail\x1b[?6", (reply) => replies.push(reply))).toBe(
      "tail",
    );
    expect(tracker.flush()).toBe("\x1b[?6");
    expect(tracker.flush()).toBe("");
  });
});
