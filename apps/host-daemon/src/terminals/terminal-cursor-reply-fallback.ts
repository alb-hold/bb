const CURSOR_POSITION_REPLY = /\u001b\[\??\d+;\d+R/g;

export const CURSOR_REPLY_FALLBACK_DELAY_MS = 250;
export const CURSOR_REPLY_SWALLOW_MS = 5_000;

export class TerminalCursorReplyFallback {
  private waiting: Array<{
    estimate: string;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private lateUntil: number[] = [];

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
    return this.waiting.length === 0 && this.lateUntil.length === 0;
  }

  filterInput(data: string): string {
    if (this.isIdle()) return data;
    return data.replace(CURSOR_POSITION_REPLY, (reply) => {
      const answered = this.waiting.shift();
      if (answered !== undefined) {
        clearTimeout(answered.timer);
        return reply;
      }
      const now = this.now();
      this.lateUntil = this.lateUntil.filter((until) => until > now);
      return this.lateUntil.shift() === undefined ? reply : "";
    });
  }

  dispose(): void {
    for (const entry of this.waiting) clearTimeout(entry.timer);
    this.waiting = [];
    this.lateUntil = [];
  }
}
