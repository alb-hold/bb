interface ScheduledRealization {
  id: number;
  priority: boolean;
  realize: () => void;
}

export interface TerminalRealizationSchedulerOptions {
  cancelFrame: (handle: number) => void;
  requestFrame: (callback: () => void) => number;
}

export class TerminalRealizationScheduler {
  private readonly cancelFrame: (handle: number) => void;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly queue: ScheduledRealization[] = [];
  private frame: number | null = null;
  private nextId = 0;

  constructor({
    cancelFrame,
    requestFrame,
  }: TerminalRealizationSchedulerOptions) {
    this.cancelFrame = cancelFrame;
    this.requestFrame = requestFrame;
  }

  schedule(realize: () => void, priority = false): () => void {
    const entry = { id: this.nextId++, priority, realize };
    this.queue.push(entry);
    this.scheduleFrame();
    return () => {
      const index = this.queue.indexOf(entry);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      if (this.queue.length === 0 && this.frame !== null) {
        this.cancelFrame(this.frame);
        this.frame = null;
      }
    };
  }

  private scheduleFrame(): void {
    if (this.frame !== null || this.queue.length === 0) {
      return;
    }
    this.frame = this.requestFrame(() => {
      this.frame = null;
      this.queue.sort((left, right) => {
        if (left.priority !== right.priority) {
          return Number(right.priority) - Number(left.priority);
        }
        return left.id - right.id;
      });
      this.queue.shift()?.realize();
      this.scheduleFrame();
    });
  }
}

export const terminalRealizationScheduler = new TerminalRealizationScheduler({
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  requestFrame: (callback) => window.requestAnimationFrame(callback),
});
