import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_REPLY_FALLBACK_DELAY_MS,
  CURSOR_REPLY_HOLD_FLUSH_MS,
  TerminalCursorReplyFallback,
} from "./terminal-cursor-reply-fallback.js";

const ESTIMATE = "\u001b[3;5R";
const REPLY = "\u001b[4;1R";

function setup() {
  const written: string[] = [];
  const fallback = new TerminalCursorReplyFallback((data) => {
    written.push(data);
  });
  fallback.expect(ESTIMATE);
  return { fallback, written };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalCursorReplyFallback split replies", () => {
  const offsets = Array.from({ length: REPLY.length - 1 }, (_, i) => i + 1);

  it.each(offsets)(
    "delivers exactly one reply when split at byte %i before the timeout",
    (offset) => {
      const { fallback, written } = setup();
      const delivered = [fallback.filterInput(REPLY.slice(0, offset))];
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS / 2);
      delivered.push(fallback.filterInput(REPLY.slice(offset)));
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS * 4);
      expect(delivered.join("") + written.join("")).toBe(REPLY);
      expect(fallback.isIdle()).toBe(true);
    },
  );

  it.each(offsets)(
    "delivers exactly one reply when split at byte %i across the timeout",
    (offset) => {
      const { fallback, written } = setup();
      const delivered = [fallback.filterInput(REPLY.slice(0, offset))];
      vi.advanceTimersByTime(CURSOR_REPLY_FALLBACK_DELAY_MS + 50);
      delivered.push(fallback.filterInput(REPLY.slice(offset)));
      vi.advanceTimersByTime(CURSOR_REPLY_HOLD_FLUSH_MS * 2);
      expect(delivered.join("") + written.join("")).toBe(ESTIMATE);
    },
  );

  it("delivers a held prefix unchanged when the next input is not a reply", () => {
    const { fallback, written } = setup();
    const delivered = [
      fallback.filterInput("\u001b["),
      fallback.filterInput("A"),
    ];
    expect(delivered.join("")).toBe("\u001b[A");
    expect(written).toEqual([]);
  });

  it("flushes a lone held escape when nothing follows", () => {
    const { fallback, written } = setup();
    expect(fallback.filterInput("\u001b")).toBe("");
    vi.advanceTimersByTime(CURSOR_REPLY_HOLD_FLUSH_MS);
    expect(written).toContain("\u001b");
  });
});
