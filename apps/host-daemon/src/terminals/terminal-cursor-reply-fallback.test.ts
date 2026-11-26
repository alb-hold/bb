import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_REPLY_FALLBACK_DELAY_MS,
  CURSOR_REPLY_HOLD_FLUSH_MS,
  CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS,
  isShortKeypressPrefix,
  TerminalCursorReplyFallback,
} from "./terminal-cursor-reply-fallback.js";

const ESTIMATE = "\u001b[3;5R";
const REPLY_FORMS = ["\u001b[4;1R", "\u001b[?4;1R"];

function setup() {
  const written: string[] = [];
  const fallback = new TerminalCursorReplyFallback((data) => {
    written.push(data);
  });
  fallback.expect(ESTIMATE);
  return { fallback, written };
}

function splitCases(delays: (short: boolean) => number[]) {
  return REPLY_FORMS.flatMap((reply) =>
    Array.from({ length: reply.length - 1 }, (_, i) => i + 1).flatMap(
      (offset) =>
        delays(isShortKeypressPrefix(reply.slice(0, offset))).map((delay) => ({
          reply,
          offset,
          delay,
          short: isShortKeypressPrefix(reply.slice(0, offset)),
        })),
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalCursorReplyFallback split replies", () => {
  it("treats only ESC and ESC[ as the short keypress class", () => {
    expect(isShortKeypressPrefix("\u001b")).toBe(true);
    expect(isShortKeypressPrefix("\u001b[")).toBe(true);
    expect(isShortKeypressPrefix("\u001b[?")).toBe(false);
    expect(isShortKeypressPrefix("\u001b[4")).toBe(false);
  });

  it.each(
    splitCases((short) =>
      short ? [10, 49] : [CURSOR_REPLY_FALLBACK_DELAY_MS / 2],
    ),
  )(
    "delivers exactly one reply for $reply split at byte $offset with a $delay ms gap before the timeout",
    ({ reply, offset, delay }) => {
      const { fallback, written } = setup();
      const delivered = [fallback.filterInput(reply.slice(0, offset))];
      vi.advanceTimersByTime(delay);
      delivered.push(fallback.filterInput(reply.slice(offset)));
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS * 4);
      expect(delivered.join("") + written.join("")).toBe(reply);
      expect(fallback.isIdle()).toBe(true);
    },
  );

  it.each(
    splitCases((short) =>
      short
        ? []
        : [CURSOR_REPLY_FALLBACK_DELAY_MS + 50, 499, 501, 4_900, 5_100],
    ),
  )(
    "delivers exactly one reply for $reply split at byte $offset with a $delay ms gap across the timeout",
    ({ reply, offset, delay }) => {
      const { fallback, written } = setup();
      const delivered = [fallback.filterInput(reply.slice(0, offset))];
      vi.advanceTimersByTime(delay);
      delivered.push(fallback.filterInput(reply.slice(offset)));
      vi.advanceTimersByTime(CURSOR_REPLY_HOLD_FLUSH_MS * 2);
      expect(delivered.join("") + written.join("")).toBe(ESTIMATE);
    },
  );

  it.each(
    REPLY_FORMS.flatMap((reply) =>
      [1, 2]
        .filter((offset) => isShortKeypressPrefix(reply.slice(0, offset)))
        .map((offset) => ({ reply, offset })),
    ),
  )(
    "leaks the fragment unchanged when $reply split at byte $offset has a 60 ms gap",
    ({ reply, offset }) => {
      const { fallback, written } = setup();
      const delivered = [fallback.filterInput(reply.slice(0, offset))];
      vi.advanceTimersByTime(60);
      delivered.push(fallback.filterInput(reply.slice(offset)));
      expect(written).toEqual([reply.slice(0, offset)]);
      expect(delivered).toEqual(["", reply.slice(offset)]);
    },
  );

  it("keeps ESC[? held past 50 ms so a private reply arrives whole", () => {
    const { fallback, written } = setup();
    const delivered = [fallback.filterInput("\u001b[?")];
    vi.advanceTimersByTime(CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS + 10);
    expect(written).toEqual([]);
    delivered.push(fallback.filterInput("4;1R"));
    vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS);
    expect(delivered.join("") + written.join("")).toBe("\u001b[?4;1R");
  });

  it("delivers a held prefix unchanged when the next input is not a reply", () => {
    const { fallback, written } = setup();
    const delivered = [
      fallback.filterInput("\u001b["),
      fallback.filterInput("A"),
    ];
    expect(delivered.join("")).toBe("\u001b[A");
    expect(written).toEqual([]);
  });

  it("delivers a lone Esc pressed inside the window within 50 ms", () => {
    const { fallback, written } = setup();
    expect(fallback.filterInput("\u001b")).toBe("");
    vi.advanceTimersByTime(CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS - 1);
    expect(written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(written).toEqual(["\u001b"]);
  });

  it("releases a held digit or question-mark prefix at once when a non-reply byte follows", () => {
    const { fallback, written } = setup();
    expect(fallback.filterInput("\u001b[4")).toBe("");
    expect(fallback.filterInput("x")).toBe("\u001b[4x");
    expect(fallback.filterInput("\u001b[?")).toBe("");
    expect(fallback.filterInput("x")).toBe("\u001b[?x");
    expect(written).toEqual([]);
  });
});
