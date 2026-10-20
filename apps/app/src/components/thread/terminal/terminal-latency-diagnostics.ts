const RING_SIZE = 256;
const INPUT_SAMPLE_EVERY = 16;

type LatencyMetric =
  | "inputToFirstOutputReceivedMs"
  | "inputToFirstOutputRenderMs"
  | "outputRenderMs";

export interface TerminalLatencyMetricSnapshot {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface TerminalLatencySnapshot {
  inputToFirstOutputReceivedMs: TerminalLatencyMetricSnapshot;
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
  private nextIndex = 0;

  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % RING_SIZE;
    this.count = Math.min(this.count + 1, RING_SIZE);
  }

  snapshot(): TerminalLatencyMetricSnapshot {
    if (this.count === 0) return { count: 0, p50Ms: null, p95Ms: null };
    const sorted = Array.from(this.values.slice(0, this.count)).sort(
      (left, right) => left - right,
    );
    return {
      count: this.count,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    };
  }
}

function percentile(sorted: number[], percentileValue: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)]!;
}

const metrics: Record<"desktop" | "phone", Record<LatencyMetric, LatencyRing>> = {
  desktop: {
    inputToFirstOutputReceivedMs: new LatencyRing(),
    inputToFirstOutputRenderMs: new LatencyRing(),
    outputRenderMs: new LatencyRing(),
  },
  phone: {
    inputToFirstOutputReceivedMs: new LatencyRing(),
    inputToFirstOutputRenderMs: new LatencyRing(),
    outputRenderMs: new LatencyRing(),
  },
};
let inputCount = 0;
let sampledInputAt: {
  formFactor: "desktop" | "phone";
  outputReceived: boolean;
  timestamp: number;
} | null = null;

function currentFormFactor(): "desktop" | "phone" {
  return typeof window !== "undefined" && window.innerWidth < 768
    ? "phone"
    : "desktop";
}

export function recordTerminalInputEnqueued(timestamp: number): void {
  inputCount += 1;
  if (inputCount % INPUT_SAMPLE_EVERY === 0) {
    sampledInputAt = {
      formFactor: currentFormFactor(),
      outputReceived: false,
      timestamp,
    };
  }
}

export function recordTerminalOutputReceived(timestamp: number): void {
  if (sampledInputAt === null || sampledInputAt.outputReceived) return;
  metrics[sampledInputAt.formFactor].inputToFirstOutputReceivedMs.add(
    timestamp - sampledInputAt.timestamp,
  );
  sampledInputAt.outputReceived = true;
}

export function recordTerminalOutputRendered(
  receivedAt: number,
  renderedAt: number,
): void {
  const formFactor = currentFormFactor();
  metrics[formFactor].outputRenderMs.add(renderedAt - receivedAt);
  if (sampledInputAt !== null) {
    metrics[sampledInputAt.formFactor].inputToFirstOutputRenderMs.add(
      renderedAt - sampledInputAt.timestamp,
    );
    sampledInputAt = null;
  }
}

function snapshot(formFactor: "desktop" | "phone"): TerminalLatencySnapshot {
  return {
    inputToFirstOutputReceivedMs:
      metrics[formFactor].inputToFirstOutputReceivedMs.snapshot(),
    inputToFirstOutputRenderMs:
      metrics[formFactor].inputToFirstOutputRenderMs.snapshot(),
    outputRenderMs: metrics[formFactor].outputRenderMs.snapshot(),
  };
}

export function getTerminalLatencyDiagnostics(): TerminalLatencyDiagnosticsSnapshot {
  return { desktop: snapshot("desktop"), phone: snapshot("phone") };
}
