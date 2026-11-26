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

export class TerminalCursorReplyFallback {
  private waiting: Array<{
    estimate: string;
    windowEnd: number;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private lateUntil: number[] = [];
  private held = "";
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly delayMs: number = CURSOR_REPLY_FALLBACK_DELAY_MS,
    private readonly now: () => number = Date.now,
  ) {}

  expect(estimate: string): void {
    const entry = {
      estimate,
      windowEnd: this.now() + this.delayMs + CURSOR_REPLY_SWALLOW_MS,
      timer: setTimeout(() => {
        this.waiting = this.waiting.filter((candidate) => candidate !== entry);
        this.lateUntil.push(entry.windowEnd);
        this.write(estimate);
        this.rescheduleHold();
      }, this.delayMs),
    };
    entry.timer.unref();
    this.waiting.push(entry);
    this.rescheduleHold();
  }

  private pruneLate(): void {
    const now = this.now();
    this.lateUntil = this.lateUntil.filter((until) => until > now);
  }

  isIdle(): boolean {
    this.pruneLate();
    return (
      this.waiting.length === 0 &&
      this.lateUntil.length === 0 &&
      this.held === ""
    );
  }

  filterInput(data: string): string {
    if (this.isIdle()) return data;
    this.clearHold();
    let text = this.held + data;
    this.held = "";
    let partial = "";
    const tail = PARTIAL_CURSOR_POSITION_REPLY.exec(text);
    if (tail !== null) {
      partial = tail[0];
      text = text.slice(0, tail.index);
    }
    const out = text.replace(CURSOR_POSITION_REPLY, (reply) => {
      const answered = this.waiting.shift();
      if (answered !== undefined) {
        clearTimeout(answered.timer);
        return reply;
      }
      const now = this.now();
      this.lateUntil = this.lateUntil.filter((until) => until > now);
      return this.lateUntil.shift() === undefined ? reply : "";
    });
    if (partial === "") return out;
    const now = this.now();
    this.lateUntil = this.lateUntil.filter((until) => until > now);
    if (this.waiting.length === 0 && this.lateUntil.length === 0) {
      return out + partial;
    }
    this.held = partial;
    this.rescheduleHold();
    return out;
  }

  private rescheduleHold(): void {
    this.clearHold();
    if (this.held === "") return;
    const remaining = Math.max(0, this.windowEnd() - this.now());
    const holdMs = isShortKeypressPrefix(this.held)
      ? Math.min(CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS, remaining)
      : remaining;
    this.holdTimer = setTimeout(() => {
      this.clearHold();
      const flushed = this.held;
      this.held = "";
      if (flushed !== "") this.write(flushed);
    }, holdMs);
    this.holdTimer.unref();
  }

  private windowEnd(): number {
    return Math.max(
      0,
      ...this.waiting.map((entry) => entry.windowEnd),
      ...this.lateUntil,
    );
  }

  private clearHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  dispose(): void {
    for (const entry of this.waiting) clearTimeout(entry.timer);
    this.waiting = [];
    this.lateUntil = [];
    this.held = "";
    this.clearHold();
  }
}
