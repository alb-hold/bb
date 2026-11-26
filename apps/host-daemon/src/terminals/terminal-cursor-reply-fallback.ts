const CURSOR_POSITION_REPLY = /\u001b\[\??\d+;\d+R/g;
const PARTIAL_CURSOR_POSITION_REPLY = /\u001b(?:\[\??(?:\d+(?:;\d*)?)?)?$/;

export const CURSOR_REPLY_FALLBACK_DELAY_MS = 250;
export const CURSOR_REPLY_SWALLOW_MS = 5_000;
const SHORT_KEYPRESS_PREFIX = /^\u001b\[?$/;

export function isShortKeypressPrefix(prefix: string): boolean {
  return SHORT_KEYPRESS_PREFIX.test(prefix);
}

export const CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS = 50;
export const CURSOR_REPLY_HOLD_FLUSH_MS =
  CURSOR_REPLY_FALLBACK_DELAY_MS + CURSOR_REPLY_SWALLOW_MS;

type PendingCursorReply =
  | {
      kind: "waiting";
      estimate: string;
      windowEnd: number;
      timer: ReturnType<typeof setTimeout>;
    }
  | {
      kind: "late";
      windowEnd: number;
    };

export class TerminalCursorReplyFallback {
  private pending: PendingCursorReply[] = [];
  private held = "";
  private heldAt = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly delayMs: number = CURSOR_REPLY_FALLBACK_DELAY_MS,
    private readonly now: () => number = Date.now,
  ) {}

  expect(estimate: string): void {
    const entry: Extract<PendingCursorReply, { kind: "waiting" }> = {
      kind: "waiting",
      estimate,
      windowEnd: this.now() + this.delayMs + CURSOR_REPLY_SWALLOW_MS,
      timer: setTimeout(() => {
        const index = this.pending.indexOf(entry);
        if (index === -1) return;
        this.pending[index] = {
          kind: "late",
          windowEnd: Math.max(
            entry.windowEnd,
            this.now() + CURSOR_REPLY_SWALLOW_MS,
          ),
        };
        this.write(estimate);
        this.rescheduleHold();
      }, this.delayMs),
    };
    entry.timer.unref();
    this.pending.push(entry);
    this.rescheduleHold();
  }

  private pruneLate(): void {
    const now = this.now();
    this.pending = this.pending.filter(
      (entry) => entry.kind === "waiting" || entry.windowEnd > now,
    );
  }

  isIdle(): boolean {
    this.pruneLate();
    return this.pending.length === 0 && this.held === "";
  }

  filterInput(data: string): string {
    if (this.isIdle()) return data;
    this.clearHold();
    const previousHeld = this.held;
    const previousHeldAt = this.heldAt;
    let text = previousHeld + data;
    this.held = "";
    let partial = "";
    const tail = PARTIAL_CURSOR_POSITION_REPLY.exec(text);
    if (tail !== null) {
      partial = tail[0];
      text = text.slice(0, tail.index);
    }
    const out = text.replace(CURSOR_POSITION_REPLY, (reply) => {
      this.pruneLate();
      const oldest = this.pending.shift();
      if (oldest === undefined) return reply;
      if (oldest.kind === "waiting") {
        clearTimeout(oldest.timer);
        return reply;
      }
      return "";
    });
    if (partial === "") return out;
    this.pruneLate();
    if (this.pending.length === 0) {
      return out + partial;
    }
    const now = this.now();
    this.held = partial;
    this.heldAt =
      previousHeld !== "" && tail !== null && tail.index === 0
        ? previousHeldAt
        : now;
    this.rescheduleHold();
    return out;
  }

  private rescheduleHold(): void {
    this.clearHold();
    if (this.held === "") return;
    const now = this.now();
    const remaining = Math.max(0, this.windowEnd() - now);
    const holdMs = isShortKeypressPrefix(this.held)
      ? Math.min(
          Math.max(0, this.heldAt + CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS - now),
          remaining,
        )
      : remaining;
    this.holdTimer = setTimeout(() => {
      this.clearHold();
      const flushed = this.held;
      this.held = "";
      this.heldAt = 0;
      if (flushed !== "") this.write(flushed);
    }, holdMs);
    this.holdTimer.unref();
  }

  private windowEnd(): number {
    this.pruneLate();
    return Math.max(0, ...this.pending.map((entry) => entry.windowEnd));
  }

  private clearHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  dispose(): void {
    for (const entry of this.pending) {
      if (entry.kind === "waiting") clearTimeout(entry.timer);
    }
    this.pending = [];
    this.held = "";
    this.heldAt = 0;
    this.clearHold();
  }
}
