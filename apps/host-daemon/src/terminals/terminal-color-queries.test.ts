import { describe, expect, it } from "vitest";
import { TerminalColorQueries } from "@bb/domain";

const colors = {
  foreground: [190, 128, 1],
  background: [24, 32, 48],
} satisfies import("@bb/domain").TerminalDefaultColors;

describe("live default color queries", () => {
  for (const slot of [10, 11] as const) {
    for (const end of ["\x07", "\x1b\\"]) {
      const query = `\x1b]${slot};?${end}`;
      for (let split = 0; split <= query.length; split++) {
        it(`answers ${slot} ${JSON.stringify(end)} split ${split} once`, () => {
          const scanner = new TerminalColorQueries(colors);
          const replies: string[] = [];
          const reply = (text: string) => {
            replies.push(text);
          };
          expect(
            scanner.push(query.slice(0, split), reply) +
              scanner.push(query.slice(split), reply),
          ).toBe("");
          expect(replies).toEqual([
            `\x1b]${slot};rgb:${slot === 10 ? "bebe/8080/0101" : "1818/2020/3030"}\x1b\\`,
          ]);
          expect(scanner.flush()).toBe("");
        });
      }
    }
  }

  it("consumes consecutive queries without changing surrounding output", () => {
    const scanner = new TerminalColorQueries(colors);
    const replies: string[] = [];
    expect(
      scanner.push("a\x1b]10;?\x07\x1b]11;?\x1b\\b", (text) => {
        replies.push(text);
      }),
    ).toBe("ab");
    expect(replies).toHaveLength(2);
  });

  it.each(["\x1b\x1b]11;?\x07", "\x1b]1\x1b]11;?\x07"])(
    "restarts a query at an aborting ESC",
    (input) => {
      const scanner = new TerminalColorQueries(colors);
      const replies: string[] = [];
      expect(
        scanner.push(input, (reply) => {
          replies.push(reply);
        }),
      ).toBe(input.slice(0, input.lastIndexOf("\x1b]11;?")));
      expect(replies).toEqual(["\x1b]11;rgb:1818/2020/3030\x1b\\"]);
    },
  );

  it.each(["\x07", "\x1b\\"])(
    "preserves title and hyperlink OSC with split terminators",
    (end) => {
      const input = `\x1b]0;title${end}\x1b]8;;https://example.com${end}link\x1b]8;;${end}`;
      const scanner = new TerminalColorQueries(colors);
      const replies: string[] = [];
      let output = "";
      for (const char of input)
        output += scanner.push(char, (reply) => {
          replies.push(reply);
        });
      expect(output + scanner.flush()).toBe(input);
      expect(replies).toEqual([]);
    },
  );

  it("preserves oversized OSC 52 with a query-like body", () => {
    const input = "\x1b]52;c;" + "x".repeat(100_000) + "]11;?\x07";
    const scanner = new TerminalColorQueries(colors);
    const replies: string[] = [];
    expect(
      scanner.push(input, (reply) => {
        replies.push(reply);
      }),
    ).toBe(input);
    expect(replies).toEqual([]);
  });

  it("flushes a held prefix on close", () => {
    const scanner = new TerminalColorQueries(colors);
    expect(
      scanner.push("before\x1b]11;?", () => {
        throw new Error("Unexpected reply");
      }),
    ).toBe("before");
    expect(scanner.flush()).toBe("\x1b]11;?");
    expect(scanner.flush()).toBe("");
  });

  it.each([
    "\x1b]11;x\x07",
    "\x1b]11;??\x07",
    "\x1b]10;rgb:ffff/ffff/ffff\x07",
    "\x1b]12;?\x07",

    "\x1b]11;" + "x".repeat(100_000) + "\x1b\\",
    "\x1b[31m",
    "\x1b]11;?",
  ])(
    "preserves malformed, oversized, unrelated and incomplete sequences",
    (input) => {
      const scanner = new TerminalColorQueries(colors);
      const replies: string[] = [];
      let output = "";
      for (const char of input)
        output += scanner.push(char, (text) => {
          replies.push(text);
        });
      expect(output + scanner.flush()).toBe(input);
      expect(replies).toEqual([]);
    },
  );
});
