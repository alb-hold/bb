const CURSOR_POSITION_REPLY = /\u001b\[\??\d+;\d+R/g;
const PARTIAL_CURSOR_POSITION_REPLY = /\u001b(?:\[\??(?:\d+(?:;\d*)?)?)?$/;

export const CURSOR_REPLY_FALLBACK_DELAY_MS = 250;
export const CURSOR_REPLY_SWALLOW_MS = 5_000;
const SHORT_KEYPRESS_PREFIX = /^\u001b(?:\[\??)?$/;
export const CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS = 50;
export const CURSOR_REPLY_HOLD_FLUSH_MS =
  CURSOR_REPLY_FALLBACK_DELAY_MS + CURSOR_REPLY_SWALLOW_MS;

export class TerminalCursorReplyFallback {
  private waiting: Array<{
    estimate: string;
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
      timer: setTimeout(() => {
        this.waiting = this.waiting.filter((candidate) => candidate !== entry);
        this.lateUntil.push(this.now() + CURSOR_REPLY_SWALLOW_MS);
        this.write(estimate);
      }, this.delayMs),
    };
    entry.timer.unref();
    this.waiting.push(entry);
  }

  isIdle(): boolean {
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
    const holdMs = SHORT_KEYPRESS_PREFIX.test(partial)
      ? CURSOR_REPLY_SHORT_PREFIX_FLUSH_MS
      : CURSOR_REPLY_HOLD_FLUSH_MS;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      const flushed = this.held;
      this.held = "";
      if (flushed !== "") this.write(flushed);
    }, holdMs);
    this.holdTimer.unref();
    return out;
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
