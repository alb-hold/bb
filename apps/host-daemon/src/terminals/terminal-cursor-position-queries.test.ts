import { describe, expect, it } from "vitest";
import {
  TerminalCursorPositionQueries,
  unicodeV11CellWidth,
} from "@bb/domain";

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

  it("matches @xterm/addon-unicode11 cell widths for emoji, CJK, combining, ZWJ, variation selectors, and East Asian ambiguous characters", () => {
    const cases: Array<[string, number, number]> = [
      ["U+1F9E0 brain", 0x1f9e0, 2],
      ["U+1FA70 ballet shoes", 0x1fa70, 2],
      ["U+1FA95 banjo", 0x1fa95, 2],
      ["U+1FAE8 shaking face (Unicode 14, width 1 in Unicode 11)", 0x1fae8, 1],
      ["U+231A watch", 0x231a, 2],
      ["U+26A1 high voltage", 0x26a1, 2],
      ["U+2B50 star", 0x2b50, 2],
      ["U+6F22 CJK ideograph", 0x6f22, 2],
      ["U+0301 combining acute accent", 0x0301, 0],
      ["U+200D zero-width joiner", 0x200d, 0],
      ["U+FE0F variation selector-16", 0xfe0f, 0],
      ["U+E0100 variation selector-17", 0xe0100, 0],
      ["U+00A7 East Asian ambiguous section sign", 0x00a7, 1],
      ["U+00B0 East Asian ambiguous degree sign", 0x00b0, 1],
      ["U+03B1 East Asian ambiguous Greek alpha", 0x03b1, 1],
      ["U+2500 East Asian ambiguous box drawing", 0x2500, 1],
      ["U+2605 East Asian ambiguous black star", 0x2605, 1],
    ];
    for (const [, codePoint, expected] of cases) {
      expect(unicodeV11CellWidth(codePoint)).toBe(expected);
    }
  });

  it.each([
    {
      name: "wide emoji across U+1F900-1FAFF (U+1F9E0, U+1FA70, U+1FA95, U+1FAE8)",
      cols: 20,
      rows: 5,
      input: "\u{1F9E0}\u{1FA70}\u{1FA95}\u{1FAE8}\x1b[6n",
      expected: ["\x1b[1;8R"],
    },
    {
      name: "BMP wide emoji symbols (U+231A, U+26A1, U+2B50)",
      cols: 20,
      rows: 5,
      input: "\u231A\u26A1\u2B50\x1b[6n",
      expected: ["\x1b[1;7R"],
    },
    {
      name: "CJK, combining mark, ZWJ, and BMP variation selector",
      cols: 20,
      rows: 5,
      input: "漢e\u0301\u{1F468}\u200D\u{1F469}\u2764\uFE0F\x1b[6n",
      expected: ["\x1b[1;9R"],
    },
    {
      name: "non-BMP variation selector U+E0100",
      cols: 20,
      rows: 5,
      input: "a\u{E0100}b\x1b[6n",
      expected: ["\x1b[1;3R"],
    },
    {
      name: "East Asian ambiguous characters",
      cols: 20,
      rows: 5,
      input: "§°±×÷α─★\x1b[6n",
      expected: ["\x1b[1;9R"],
    },
    {
      name: "wide CJK character at right edge wraps before printing",
      cols: 5,
      rows: 4,
      input: "abcd漢\x1b[6nx\x1b[6n",
      expected: ["\x1b[2;3R", "\x1b[2;4R"],
    },
    {
      name: "wide emoji at right edge wraps before printing",
      cols: 5,
      rows: 4,
      input: "abcd\u{1FA70}\x1b[6n",
      expected: ["\x1b[2;3R"],
    },
    {
      name: "wide character wrapping onto a 2-column line",
      cols: 2,
      rows: 4,
      input: "a漢X\x1b[6n",
      expected: ["\x1b[3;2R"],
    },
    {
      name: "wide character at right edge with autowrap disabled",
      cols: 5,
      rows: 4,
      input: "\x1b[?7labcd漢\x1b[6n",
      expected: ["\x1b[1;5R"],
    },
    {
      name: "scroll region with newlines at bottom",
      cols: 10,
      rows: 5,
      input: "\x1b[2;4r\x1b[4;5H\n\n\x1b[6n",
      expected: ["\x1b[4;5R"],
    },
    {
      name: "scroll region newline below bottom clamps at screen bottom",
      cols: 10,
      rows: 5,
      input: "\x1b[2;3r\x1b[4;3H\n\n\x1b[6n",
      expected: ["\x1b[5;3R"],
    },
    {
      name: "alternate screen enter and exit preserves main cursor",
      cols: 10,
      rows: 5,
      input: "\x1b[3;6H\x1b[?1049h\x1b[2;4H\x1b[6n\x1b[?1049l\x1b[6n",
      expected: ["\x1b[2;4R", "\x1b[3;6R"],
    },
    {
      name: "DECSC/DECRC and SCOSC/SCORC cursor save and restore",
      cols: 10,
      rows: 5,
      input:
        "\x1b[2;5H\x1b7\x1b[4;9H\x1b8\x1b[6n\x1b[3;7H\x1b[s\x1b[1;1H\x1b[u\x1b[6n",
      expected: ["\x1b[2;5R", "\x1b[3;7R"],
    },
    {
      name: "origin mode relative CUP and CPR",
      cols: 10,
      rows: 6,
      input:
        "\x1b[2;5r\x1b[?6h\x1b[6n\x1b[2;4H\x1b[6n\x1b[99;1H\x1b[6n\x1b[?6l\x1b[6n",
      expected: ["\x1b[2;1R", "\x1b[3;4R", "\x1b[5;1R", "\x1b[1;1R"],
    },
    {
      name: "origin mode DECXCPR",
      cols: 10,
      rows: 6,
      input: "\x1b[2;5r\x1b[?6h\x1b[?6n\x1b[2;4H\x1b[?6n\x1b[?6l\x1b[?6n",
      expected: ["\x1b[?2;1R", "\x1b[?3;4R", "\x1b[?1;1R"],
    },
    {
      name: "HT, HTS, TBC (0 and 3), CHT, and CBT including pending-wrap no-op",
      cols: 20,
      rows: 4,
      input:
        "\t\x1b[6n\x1b[2I\x1b[6n\x1b[Z\x1b[6n\x1b[0g\r\x1b[2I\x1b[6n\x1b[1;5H\x1bH\r\t\x1b[6n\x1b[3g\t\x1b[6n\x1b[1;1H" +
        "a".repeat(20) +
        "\t\x1b[2I\x1b[Z\x1b[6n",
      expected: [
        "\x1b[1;9R",
        "\x1b[1;20R",
        "\x1b[1;17R",
        "\x1b[1;20R",
        "\x1b[1;5R",
        "\x1b[1;20R",
        "\x1b[1;21R",
      ],
    },
    {
      name: "REP repeats ASCII and wide characters and resets after control or CSI sequences",
      cols: 8,
      rows: 4,
      input:
        "A\x1b[3b\x1b[6n\x1b[2b\x1b[6n漢\x1b[2b\x1b[6nB\x1b[0m\x1b[4b\x1b[6n",
      expected: ["\x1b[1;5R", "\x1b[1;5R", "\x1b[2;3R", "\x1b[2;4R"],
    },
    {
      name: "IND, NEL, RI, C1 controls, IL/DL column reset, and invalid DECSTBM no-op",
      cols: 10,
      rows: 5,
      input:
        "\x1b[2;4r\x1b[4;3r\x1b[2;6H\x1bM\x1b[6n\x1bD\x84\x1b[6n\x1bE\x1b[6n\x1b[3;7H\x1b[L\x1b[6n\x1b[1;7H\x1b[M\x1b[6n",
      expected: [
        "\x1b[2;6R",
        "\x1b[4;6R",
        "\x1b[4;1R",
        "\x1b[3;1R",
        "\x1b[1;7R",
      ],
    },
    {
      name: "alternate screen modes 47, 1047, and 1048 cursor transfers and tab reset",
      cols: 16,
      rows: 4,
      input:
        "\x1b[2;5H\x1b[?47h\x1b[6n\x1b[3g\t\x1b[6n\x1b[?47l\x1b[6n\x1b[?1047h\r\t\x1b[6n\x1b[?1048h\x1b[4;2H\x1b[?1048l\x1b[6n\x1b[?1047l",
      expected: [
        "\x1b[2;5R",
        "\x1b[2;16R",
        "\x1b[2;16R",
        "\x1b[2;9R",
        "\x1b[2;9R",
      ],
    },
  ])(
    "matches xterm.js Unicode 11 cursor position: $name",
    ({ cols, rows, input, expected }) => {
      const tracker = new TerminalCursorPositionQueries(cols, rows);
      const replies: string[] = [];
      tracker.push(input, (reply) => replies.push(reply));
      expect(replies).toEqual(expected);
    },
  );

  it("tracks cursor across CUP, relative moves, wrap, save/restore, alt screen, and resize", () => {
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
    expect(push("\x1b[6n")).toBe("\x1b[6n");
    expect(push("\x1b[1;9H\x1b[6n")).toBe("\x1b[1;9H");

    expect(replies).toEqual([
      "\x1b[1;1R",
      "\x1b[1;11R",
      "\x1b[2;2R",
      "\x1b[4;7R",
      "\x1b[2;4R",
      "\x1b[2;4R",
      "\x1b[2;4R",
      "\x1b[1;3R",
    ]);
  });

  for (const query of ["\x1b[6n", "\x1b[?6n"] as const) {
    for (let split = 0; split <= query.length; split++) {
      it(`forwards ${JSON.stringify(query)} raw when split at ${split} while cursor position is unknown`, () => {
        const tracker = new TerminalCursorPositionQueries(10, 4);
        const replies: string[] = [];
        const reply = (text: string) => {
          replies.push(text);
        };
        tracker.push("1234567890abc", reply);
        tracker.resize(6, 4);

        const out =
          tracker.push(`pre${query.slice(0, split)}`, reply) +
          tracker.push(`${query.slice(split)}post`, reply);
        expect(out).toBe(`pre${query}post`);
        expect(replies).toEqual([]);
        expect(tracker.flush()).toBe("");
      });
    }

    it(`forwards ${JSON.stringify(query)} raw when resize marks position unknown mid-query`, () => {
      const tracker = new TerminalCursorPositionQueries(10, 4);
      const replies: string[] = [];
      const reply = (text: string) => {
        replies.push(text);
      };
      tracker.push("1234567890abc", reply);
      const prefix = query.slice(0, -1);
      const out1 = tracker.push(`A${prefix}`, reply);
      tracker.resize(6, 4);
      const out2 = tracker.push("nB", reply);
      expect(out1 + out2).toBe(`A${query}B`);
      expect(replies).toEqual([]);
    });
  }

  it("defers DSR while position is unknown from reverse-wraparound, unknown tabs, or deep scrollback and resumes once row and column are both known", () => {
    const tracker = new TerminalCursorPositionQueries(10, 5);
    const replies: string[] = [];
    const push = (text: string) =>
      tracker.push(text, (reply) => replies.push(reply));

    expect(push("\x1b[?45h\x1b[2;1H\b\x1b[6n\x1b[?6n")).toBe(
      "\x1b[?45h\x1b[2;1H\b\x1b[6n\x1b[?6n",
    );
    expect(replies).toEqual([]);

    expect(push("\r\x1b[6n")).toBe("\r\x1b[6n");
    expect(push("\x1b[4G\x1b[6n")).toBe("\x1b[4G\x1b[6n");
    expect(replies).toEqual([]);

    expect(push("\x1b[3d\x1b[6n")).toBe("\x1b[3d");
    expect(replies).toEqual(["\x1b[3;4R"]);

    replies.length = 0;
    expect(push("\x1b[2;1H\b\x1b[2d\x1b[6n")).toBe("\x1b[2;1H\b\x1b[2d\x1b[6n");
    expect(replies).toEqual([]);
    expect(push("\x1b[5G\x1b[?6n")).toBe("\x1b[5G");
    expect(replies).toEqual(["\x1b[?2;5R"]);

    replies.length = 0;
    expect(push("\x1b[2;1H\b\x1bH\x1b[1;1H\t\x1b[6n")).toBe(
      "\x1b[2;1H\b\x1bH\x1b[1;1H\t\x1b[6n",
    );
    expect(replies).toEqual([]);
    expect(push("\x1b[3g\x1b[2;3f\x1b[6n")).toBe("\x1b[3g\x1b[2;3f");
    expect(replies).toEqual(["\x1b[2;3R"]);

    replies.length = 0;
    expect(push("\x1b7" + "\n".repeat(205) + "\x1b8\x1b[6n")).toBe(
      "\x1b7" + "\n".repeat(205) + "\x1b8\x1b[6n",
    );
    expect(replies).toEqual([]);

    expect(push("\x1b[2;4r\x1b[6n")).toBe("\x1b[2;4r");
    expect(replies).toEqual(["\x1b[1;1R"]);

    replies.length = 0;
    expect(push("\x1b[3;1H\b\x1b[?6h\x1b[6n")).toBe("\x1b[3;1H\b\x1b[?6h");
    expect(replies).toEqual(["\x1b[2;1R"]);

    replies.length = 0;
    expect(push("\x1b[3;1H\b\x1b#8\x1b[6n\x1b[?6l\x1b[6n")).toBe(
      "\x1b[3;1H\b\x1b#8\x1b[?6l",
    );
    expect(replies).toEqual(["\x1b[2;1R", "\x1b[1;1R"]);

    replies.length = 0;
    expect(push("\x1b[?45h\x1b[2;1H\b\x1bc\x1b[6n")).toBe(
      "\x1b[?45h\x1b[2;1H\b\x1bc",
    );
    expect(replies).toEqual(["\x1b[1;1R"]);
  });

  it("keeps cursor position known across non-reflowing resizes and marks it unknown when shrinking cols reflows normal-buffer text", () => {
    const tracker = new TerminalCursorPositionQueries(80, 24);
    const replies: string[] = [];
    const push = (text: string) =>
      tracker.push(text, (reply) => replies.push(reply));

    expect(push("\x1b[1;1Hlive-1")).toBe("\x1b[1;1Hlive-1");
    tracker.resize(85, 26);
    expect(push("\x1b[6n")).toBe("");
    expect(replies).toEqual(["\x1b[1;7R"]);

    replies.length = 0;
    tracker.resize(10, 5);
    expect(push("\x1b[6n")).toBe("");
    expect(replies).toEqual(["\x1b[1;7R"]);

    replies.length = 0;
    tracker.resize(4, 5);
    expect(push("\x1b[6n")).toBe("\x1b[6n");
    expect(replies).toEqual([]);

    tracker.resize(10, 5);
    expect(push("\x1b[?1049h\x1b[2;4Habcdef")).toBe("\x1b[?1049h\x1b[2;4Habcdef");
    tracker.resize(4, 1);
    expect(push("\x1b[6n")).toBe("");
    expect(replies).toEqual(["\x1b[1;4R"]);

    replies.length = 0;
    expect(push("\x1b[?1049l\x1b[6n")).toBe("\x1b[?1049l\x1b[6n");
    expect(replies).toEqual([]);
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

  it("answers and strips bursts of 9+ mixed standard and private DSR queries in one chunk", () => {
    const tracker = new TerminalCursorPositionQueries(80, 24);
    const replies: string[] = [];
    const queries = [
      "\x1b[6n",
      "\x1b[?6n",
      "\x1b[6n",
      "\x1b[?6n",
      "\x1b[6n",
      "\x1b[?6n",
      "\x1b[6n",
      "\x1b[?6n",
      "\x1b[6n",
      "\x1b[?6n",
      "\x1b[6n",
    ];
    const output = tracker.push(`before${queries.join("")}after`, (reply) =>
      replies.push(reply),
    );
    expect(replies).toEqual([
      "\x1b[1;7R",
      "\x1b[?1;7R",
      "\x1b[1;7R",
      "\x1b[?1;7R",
      "\x1b[1;7R",
      "\x1b[?1;7R",
      "\x1b[1;7R",
      "\x1b[?1;7R",
      "\x1b[1;7R",
      "\x1b[?1;7R",
      "\x1b[1;7R",
    ]);
    expect(output).toBe("beforeafter");
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
