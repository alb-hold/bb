import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_REPLY_FALLBACK_DELAY_MS,
  CURSOR_REPLY_HOLD_FLUSH_MS,
  CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS,
  CURSOR_REPLY_SWALLOW_MS,
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

  it.each(
    REPLY_FORMS.flatMap((reply) =>
      Array.from({ length: reply.length - 1 }, (_, i) => i + 1).map(
        (offset) => ({ reply, offset }),
      ),
    ),
  )(
    "releases $reply prefix of length $offset at the window end when it arrives 10 ms before and nothing follows",
    ({ reply, offset }) => {
      const { fallback, written } = setup();
      const windowEnd =
        CURSOR_REPLY_FALLBACK_DELAY_MS + CURSOR_REPLY_SWALLOW_MS;
      vi.advanceTimersByTime(windowEnd - 10);
      expect(fallback.filterInput(reply.slice(0, offset))).toBe("");
      vi.advanceTimersByTime(9);
      expect(written).toEqual([ESTIMATE]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, reply.slice(0, offset)]);
      vi.advanceTimersByTime(CURSOR_REPLY_HOLD_FLUSH_MS);
      expect(written).toEqual([ESTIMATE, reply.slice(0, offset)]);
      expect(fallback.filterInput("x")).toBe("x");
    },
  );

  describe("hold deadline follows every window mutator", () => {
    const WINDOW_END = CURSOR_REPLY_FALLBACK_DELAY_MS + CURSOR_REPLY_SWALLOW_MS;

    it("expect() extends the deadline", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(1_000);
      expect(fallback.filterInput("\u001b[4")).toBe("");
      vi.advanceTimersByTime(1_000);
      fallback.expect("\u001b[9;9R");
      vi.advanceTimersByTime(WINDOW_END - 1);
      expect(written).toEqual([ESTIMATE, "\u001b[9;9R"]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, "\u001b[9;9R", "\u001b[4"]);
    });

    it("a completed reply that consumes the latest window shrinks the deadline", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 750);
      fallback.expect("\u001b[9;9R");
      vi.advanceTimersByTime(10);
      expect(fallback.filterInput("\u001b[4;")).toBe("");
      const out = fallback.filterInput("1R\u001b[?");
      expect(out).toBe("");
      vi.advanceTimersByTime(WINDOW_END - 10 - 1);
      expect(written).toEqual([ESTIMATE, "\u001b[9;9R"]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, "\u001b[9;9R", "\u001b[?"]);
    });

    it("swallows a completed late split reply when a new prefix follows in the same chunk", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 750);
      fallback.expect("\u001b[9;9R");
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 10);
      expect(written).toEqual([ESTIMATE, "\u001b[9;9R"]);
      expect(fallback.filterInput("\u001b[4;")).toBe("");
      expect(fallback.filterInput("1R\u001b[?")).toBe("");
      expect(fallback.filterInput("9;9R\u001b[?")).toBe("\u001b[?");
      expect(fallback.isIdle()).toBe(true);
    });

    it("a fallback fire keeps the deadline", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(10);
      expect(fallback.filterInput("\u001b[4")).toBe("");
      vi.advanceTimersByTime(WINDOW_END - 10 - 1);
      expect(written).toEqual([ESTIMATE]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, "\u001b[4"]);
    });

    it("does not extend a held short prefix past 50 ms when a fallback fires or expect() runs", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS - 30);
      expect(fallback.filterInput("\u001b")).toBe("");
      vi.advanceTimersByTime(30);
      expect(written).toEqual([ESTIMATE]);
      fallback.expect("\u001b[9;9R");
      vi.advanceTimersByTime(CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS - 30 - 1);
      expect(written).toEqual([ESTIMATE]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, "\u001b"]);
    });

    it("late-slot expiry releases the prefix and leaves the filter idle", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 1);
      expect(fallback.filterInput("\u001b[?4")).toBe("");
      vi.advanceTimersByTime(WINDOW_END - CURSOR_REPLY_FALLBACK_DELAY_MS - 2);
      expect(written).toEqual([ESTIMATE]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, "\u001b[?4"]);
      vi.advanceTimersByTime(1);
      expect(fallback.filterInput("x")).toBe("x");
      expect(fallback.isIdle()).toBe(true);
    });

    it("filterInput() re-evaluates the class of a grown prefix", () => {
      const { fallback, written } = setup();
      expect(fallback.filterInput("\u001b[")).toBe("");
      vi.advanceTimersByTime(40);
      expect(fallback.filterInput("4")).toBe("");
      vi.advanceTimersByTime(WINDOW_END - 40 - 1);
      expect(written).toEqual([ESTIMATE]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, "\u001b[4"]);
    });

    it("dispose() drops the held prefix and its timer", () => {
      const { fallback, written } = setup();
      expect(fallback.filterInput("\u001b[4")).toBe("");
      fallback.dispose();
      vi.advanceTimersByTime(WINDOW_END * 2);
      expect(written).toEqual([]);
    });
  });

  describe("FIFO reply matching across outstanding queries", () => {
    it("swallows reply A for late slot 1 then forwards reply B for armed query 2 with no fallback", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 100);
      expect(written).toEqual([ESTIMATE]);
      fallback.expect("\u001b[9;9R");
      expect(fallback.filterInput("\u001b[4;1R")).toBe("");
      expect(fallback.filterInput("\u001b[8;2R")).toBe("\u001b[8;2R");
      vi.advanceTimersByTime(CURSOR_REPLY_HOLD_FLUSH_MS);
      expect(written).toEqual([ESTIMATE]);
      expect(fallback.isIdle()).toBe(true);
    });

    it("swallows reply A for late slot 1 and fires armed query 2's fallback once when reply B never arrives", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 100);
      expect(written).toEqual([ESTIMATE]);
      fallback.expect("\u001b[9;9R");
      expect(fallback.filterInput("\u001b[4;1R")).toBe("");
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS - 1);
      expect(written).toEqual([ESTIMATE]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, "\u001b[9;9R"]);
      vi.advanceTimersByTime(CURSOR_REPLY_HOLD_FLUSH_MS);
      expect(written).toEqual([ESTIMATE, "\u001b[9;9R"]);
      expect(fallback.isIdle()).toBe(true);
    });

    it("swallows two replies in order when two late slots are open", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 100);
      fallback.expect("\u001b[9;9R");
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 10);
      expect(written).toEqual([ESTIMATE, "\u001b[9;9R"]);
      expect(fallback.filterInput("\u001b[4;1R")).toBe("");
      vi.advanceTimersByTime(
        CURSOR_REPLY_HOLD_FLUSH_MS -
          (2 * CURSOR_REPLY_FALLBACK_DELAY_MS + 110) +
          50,
      );
      expect(fallback.isIdle()).toBe(false);
      expect(fallback.filterInput("\u001b[8;2R")).toBe("");
      expect(fallback.isIdle()).toBe(true);
      expect(fallback.filterInput("\u001b[1;1R")).toBe("\u001b[1;1R");
    });

    it("forwards reply A for armed query 1 while keeping query 2 armed", () => {
      const { fallback, written } = setup();
      vi.advanceTimersByTime(100);
      fallback.expect("\u001b[9;9R");
      expect(fallback.filterInput("\u001b[4;1R")).toBe("\u001b[4;1R");
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS - 1);
      expect(written).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual(["\u001b[9;9R"]);
    });
  });

  describe("fallback fired after its scheduled deadline", () => {
    const WINDOW_END = CURSOR_REPLY_FALLBACK_DELAY_MS + CURSOR_REPLY_SWALLOW_MS;

    function blockedSetup() {
      let clock = 0;
      const written: string[] = [];
      const fallback = new TerminalCursorReplyFallback(
        (data) => {
          written.push(data);
        },
        CURSOR_REPLY_FALLBACK_DELAY_MS,
        () => clock,
      );
      fallback.expect(ESTIMATE);
      return {
        fallback,
        written,
        setClock: (value: number) => {
          clock = value;
        },
      };
    }

    it("forwards a reply arriving after windowEnd when the fallback timer has not yet run and cancels the fallback", () => {
      const { fallback, written, setClock } = blockedSetup();
      setClock(WINDOW_END + 1_000);
      expect(fallback.filterInput("\u001b[4;1R")).toBe("\u001b[4;1R");
      vi.advanceTimersByTime(CURSOR_REPLY_HOLD_FLUSH_MS * 2);
      expect(written).toEqual([]);
      expect(fallback.isIdle()).toBe(true);
    });

    it("swallows a late reply after a fire delayed past the deadline", () => {
      const { fallback, written, setClock } = blockedSetup();
      setClock(WINDOW_END + 1_000);
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS);
      expect(written).toEqual([ESTIMATE]);
      setClock(WINDOW_END + 1_500);
      expect(fallback.filterInput("\u001b[4;1R")).toBe("");
      expect(fallback.isIdle()).toBe(true);
    });

    it("preserves FIFO and exactly one answer per query across two queries when the first stalls past windowEnd", () => {
      const { fallback, written, setClock } = blockedSetup();
      setClock(WINDOW_END + 1_000);
      fallback.expect("\u001b[9;9R");
      expect(fallback.filterInput("\u001b[4;1R")).toBe("\u001b[4;1R");
      expect(written).toEqual([]);
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS);
      expect(written).toEqual(["\u001b[9;9R"]);
      setClock(WINDOW_END + 1_500);
      expect(fallback.filterInput("\u001b[8;2R")).toBe("");
      expect(fallback.isIdle()).toBe(true);

      const second = blockedSetup();
      second.setClock(WINDOW_END + 1_000);
      second.fallback.expect("\u001b[9;9R");
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS);
      expect(second.written).toEqual([ESTIMATE, "\u001b[9;9R"]);
      second.setClock(WINDOW_END + 1_500);
      expect(second.fallback.filterInput("\u001b[4;1R")).toBe("");
      expect(second.fallback.filterInput("\u001b[8;2R")).toBe("");
      expect(second.fallback.isIdle()).toBe(true);

      const bothRepliedBeforeTimer = blockedSetup();
      bothRepliedBeforeTimer.setClock(WINDOW_END + 1_000);
      bothRepliedBeforeTimer.fallback.expect("\u001b[9;9R");
      expect(bothRepliedBeforeTimer.fallback.filterInput("\u001b[4;1R")).toBe(
        "\u001b[4;1R",
      );
      expect(bothRepliedBeforeTimer.fallback.filterInput("\u001b[8;2R")).toBe(
        "\u001b[8;2R",
      );
      vi.advanceTimersByTime(CURSOR_REPLY_HOLD_FLUSH_MS * 2);
      expect(bothRepliedBeforeTimer.written).toEqual([]);
      expect(bothRepliedBeforeTimer.fallback.isIdle()).toBe(true);
    });

    it("reschedules a held prefix to the new slot end after a delayed fire", () => {
      const { fallback, written, setClock } = blockedSetup();
      setClock(100);
      expect(fallback.filterInput("\u001b[4")).toBe("");
      setClock(WINDOW_END + 1_000);
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS);
      expect(written).toEqual([ESTIMATE]);
      vi.advanceTimersByTime(CURSOR_REPLY_SWALLOW_MS - 1);
      expect(written).toEqual([ESTIMATE]);
      vi.advanceTimersByTime(1);
      expect(written).toEqual([ESTIMATE, "\u001b[4"]);
    });

    it("keeps the scheduled slot end for an on-time fire", () => {
      const { fallback, written, setClock } = blockedSetup();
      setClock(CURSOR_REPLY_FALLBACK_DELAY_MS);
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS);
      expect(written).toEqual([ESTIMATE]);
      setClock(WINDOW_END - 1);
      expect(fallback.filterInput("\u001b[4;1R")).toBe("");
      setClock(WINDOW_END);
      expect(fallback.filterInput("\u001b[4;1R")).toBe("\u001b[4;1R");
    });
  });

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
