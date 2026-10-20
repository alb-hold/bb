const RING_SIZE = 256;

type LatencyMetric =
  | "inputEventToEnqueueMs"
  | "inputEnqueueToWebSocketSendMs"
  | "inputWebSocketSendToFirstOutputReceivedMs"
  | "inputToFirstOutputReceivedMs"
  | "inputEchoReceivedToRenderMs"
  | "inputToFirstOutputRenderMs"
  | "outputRenderMs";

export interface TerminalLatencyMetricSnapshot {
  count: number;
  totalCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface TerminalLatencySnapshot {
  inputEventToEnqueueMs: TerminalLatencyMetricSnapshot;
  inputEnqueueToWebSocketSendMs: TerminalLatencyMetricSnapshot;
  inputWebSocketSendToFirstOutputReceivedMs: TerminalLatencyMetricSnapshot;
  inputToFirstOutputReceivedMs: TerminalLatencyMetricSnapshot;
  inputEchoReceivedToRenderMs: TerminalLatencyMetricSnapshot;
  inputToFirstOutputRenderMs: TerminalLatencyMetricSnapshot;
  outputRenderMs: TerminalLatencyMetricSnapshot;
}

export interface TerminalLatencyDiagnosticsSnapshot {
  desktop: TerminalLatencySnapshot;
  phone: TerminalLatencySnapshot;
}

class LatencyRing {
  private readonly values = new Float64Array(RING_SIZE);
  private count = 0;
  private totalCount = 0;
  private nextIndex = 0;

  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % RING_SIZE;
    this.count = Math.min(this.count + 1, RING_SIZE);
    this.totalCount += 1;
  }

  snapshot(): TerminalLatencyMetricSnapshot {
    if (this.count === 0)
      return {
        count: 0,
        totalCount: this.totalCount,
        p50Ms: null,
        p95Ms: null,
      };
    const sorted = Array.from(this.values.slice(0, this.count)).sort(
      (left, right) => left - right,
    );
    return {
      count: this.count,
      totalCount: this.totalCount,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    };
  }
}

function percentile(sorted: number[], percentileValue: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)]!;
}

const metrics: Record<
  "desktop" | "phone",
  Record<LatencyMetric, LatencyRing>
> = {
  desktop: {
    inputEventToEnqueueMs: new LatencyRing(),
    inputEnqueueToWebSocketSendMs: new LatencyRing(),
    inputWebSocketSendToFirstOutputReceivedMs: new LatencyRing(),
    inputToFirstOutputReceivedMs: new LatencyRing(),
    inputEchoReceivedToRenderMs: new LatencyRing(),
    inputToFirstOutputRenderMs: new LatencyRing(),
    outputRenderMs: new LatencyRing(),
  },
  phone: {
    inputEventToEnqueueMs: new LatencyRing(),
    inputEnqueueToWebSocketSendMs: new LatencyRing(),
    inputWebSocketSendToFirstOutputReceivedMs: new LatencyRing(),
    inputToFirstOutputReceivedMs: new LatencyRing(),
    inputEchoReceivedToRenderMs: new LatencyRing(),
    inputToFirstOutputRenderMs: new LatencyRing(),
    outputRenderMs: new LatencyRing(),
  },
};
type FormFactor = "desktop" | "phone";

const pendingInputs: Array<{
  formFactor: FormFactor;
  sentAt?: number;
  timestamp: number;
}> = [];
const pendingRenders: Array<{
  formFactor: FormFactor;
  inputTimestamp: number | null;
  receivedAt: number;
}> = [];

function currentFormFactor(): FormFactor {
  return typeof window !== "undefined" && window.innerWidth < 768
    ? "phone"
    : "desktop";
}

export function recordTerminalInputEnqueued(
  timestamp: number,
  inputEventAt?: number,
): void {
  if (!Number.isFinite(timestamp)) return;
  const formFactor = currentFormFactor();
  if (inputEventAt !== undefined) {
    metrics[formFactor].inputEventToEnqueueMs.add(timestamp - inputEventAt);
  }
  if (pendingInputs.length === RING_SIZE) pendingInputs.shift();
  pendingInputs.push({ formFactor, timestamp });
}

export function recordTerminalInputWebSocketSent(
  enqueuedAt: number,
  sentAt: number,
): void {
  const index = pendingInputs.findIndex(
    (pending) => pending.timestamp === enqueuedAt,
  );
  if (index < 0) return;
  const pending = pendingInputs[index];
  if (pending) {
    pending.sentAt = sentAt;
    metrics[pending.formFactor].inputEnqueueToWebSocketSendMs.add(
      sentAt - enqueuedAt,
    );
  }
}

export function recordTerminalOutputReceived(timestamp: number): void {
  if (!Number.isFinite(timestamp)) return;
  const firstInput = pendingInputs.shift() ?? null;
  if (firstInput !== null) {
    metrics[firstInput.formFactor].inputToFirstOutputReceivedMs.add(
      timestamp - firstInput.timestamp,
    );
    if (firstInput.sentAt !== undefined) {
      metrics[
        firstInput.formFactor
      ].inputWebSocketSendToFirstOutputReceivedMs.add(
        timestamp - firstInput.sentAt,
      );
    }
    pendingInputs.length = 0;
  }
  if (pendingRenders.length === RING_SIZE) pendingRenders.shift();
  pendingRenders.push({
    formFactor: firstInput?.formFactor ?? currentFormFactor(),
    inputTimestamp: firstInput?.timestamp ?? null,
    receivedAt: timestamp,
  });
}

export function recordTerminalOutputRendered(
  receivedAt: number,
  renderedAt: number,
): void {
  const pending = pendingRenders.shift();
  const formFactor = pending?.formFactor ?? currentFormFactor();
  const frameReceivedAt = pending?.receivedAt ?? receivedAt;
  metrics[formFactor].outputRenderMs.add(renderedAt - frameReceivedAt);
  if (
    pending?.inputTimestamp !== null &&
    pending?.inputTimestamp !== undefined
  ) {
    metrics[formFactor].inputEchoReceivedToRenderMs.add(
      renderedAt - frameReceivedAt,
    );
    metrics[formFactor].inputToFirstOutputRenderMs.add(
      renderedAt - pending.inputTimestamp,
    );
  }
}

function snapshot(formFactor: "desktop" | "phone"): TerminalLatencySnapshot {
  return {
    inputEventToEnqueueMs: metrics[formFactor].inputEventToEnqueueMs.snapshot(),
    inputEnqueueToWebSocketSendMs:
      metrics[formFactor].inputEnqueueToWebSocketSendMs.snapshot(),
    inputWebSocketSendToFirstOutputReceivedMs:
      metrics[formFactor].inputWebSocketSendToFirstOutputReceivedMs.snapshot(),
    inputToFirstOutputReceivedMs:
      metrics[formFactor].inputToFirstOutputReceivedMs.snapshot(),
    inputEchoReceivedToRenderMs:
      metrics[formFactor].inputEchoReceivedToRenderMs.snapshot(),
    inputToFirstOutputRenderMs:
      metrics[formFactor].inputToFirstOutputRenderMs.snapshot(),
    outputRenderMs: metrics[formFactor].outputRenderMs.snapshot(),
  };
}

export function getTerminalLatencyDiagnostics(): TerminalLatencyDiagnosticsSnapshot {
  return { desktop: snapshot("desktop"), phone: snapshot("phone") };
}
