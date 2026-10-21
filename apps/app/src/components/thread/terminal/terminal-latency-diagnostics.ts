const RING_SIZE = 256;

type LatencyMetric =
  | "inputEventToSerializationMs"
  | "inputSerializationToAcceptanceMs"
  | "inputAcceptanceToWebSocketSendMs"
  | "inputWebSocketSendToFirstOutputReceivedMs"
  | "inputToFirstOutputReceivedMs"
  | "inputFirstOutputReceivedToRenderMs"
  | "inputToFirstOutputRenderMs"
  | "outputRenderMs";

export interface TerminalLatencyMetricSnapshot {
  count: number;
  totalCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface TerminalLatencySnapshot {
  inputEventToSerializationMs: TerminalLatencyMetricSnapshot;
  inputSerializationToAcceptanceMs: TerminalLatencyMetricSnapshot;
  inputAcceptanceToWebSocketSendMs: TerminalLatencyMetricSnapshot;
  inputWebSocketSendToFirstOutputReceivedMs: TerminalLatencyMetricSnapshot;
  inputToFirstOutputReceivedMs: TerminalLatencyMetricSnapshot;
  inputFirstOutputReceivedToRenderMs: TerminalLatencyMetricSnapshot;
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
    inputEventToSerializationMs: new LatencyRing(),
    inputSerializationToAcceptanceMs: new LatencyRing(),
    inputAcceptanceToWebSocketSendMs: new LatencyRing(),
    inputWebSocketSendToFirstOutputReceivedMs: new LatencyRing(),
    inputToFirstOutputReceivedMs: new LatencyRing(),
    inputFirstOutputReceivedToRenderMs: new LatencyRing(),
    inputToFirstOutputRenderMs: new LatencyRing(),
    outputRenderMs: new LatencyRing(),
  },
  phone: {
    inputEventToSerializationMs: new LatencyRing(),
    inputSerializationToAcceptanceMs: new LatencyRing(),
    inputAcceptanceToWebSocketSendMs: new LatencyRing(),
    inputWebSocketSendToFirstOutputReceivedMs: new LatencyRing(),
    inputToFirstOutputReceivedMs: new LatencyRing(),
    inputFirstOutputReceivedToRenderMs: new LatencyRing(),
    inputToFirstOutputRenderMs: new LatencyRing(),
    outputRenderMs: new LatencyRing(),
  },
};
type FormFactor = "desktop" | "phone";

type PendingTerminalInput = {
  formFactor: FormFactor;
  terminalId: string;
  inputEventAt?: number;
  sentAt?: number;
  timestamp: number;
};
type SentTerminalInput = PendingTerminalInput & { sentAt: number };

const pendingInputs: PendingTerminalInput[] = [];
type PendingTerminalRender = {
  frameId: number;
  formFactor: FormFactor;
  terminalId: string;
  inputAcceptedAt: number | null;
  inputEventAt: number | null;
  receivedAt: number;
};

const pendingRenders: Array<PendingTerminalRender | undefined> = Array.from({
  length: RING_SIZE,
});
let nextOutputFrameId = 1;

function currentFormFactor(): FormFactor {
  return typeof window !== "undefined" && window.innerWidth < 768
    ? "phone"
    : "desktop";
}

export function recordTerminalInputAccepted(
  terminalId: string,
  acceptedAt: number,
  inputEventAt?: number,
  serializedAt?: number,
): void {
  if (!Number.isFinite(acceptedAt)) return;
  const serializedTimestamp = serializedAt ?? acceptedAt;
  const formFactor = currentFormFactor();
  if (inputEventAt !== undefined) {
    metrics[formFactor].inputEventToSerializationMs.add(
      serializedTimestamp - inputEventAt,
    );
  }
  metrics[formFactor].inputSerializationToAcceptanceMs.add(
    acceptedAt - serializedTimestamp,
  );
  if (pendingInputs.length === RING_SIZE) pendingInputs.shift();
  pendingInputs.push({
    formFactor,
    terminalId,
    inputEventAt,
    timestamp: acceptedAt,
  });
}

export function recordTerminalInputWebSocketSent(
  terminalId: string,
  acceptedAt: number,
  sentAt: number,
): void {
  const index = pendingInputs.findIndex(
    (pending) =>
      pending.terminalId === terminalId && pending.timestamp === acceptedAt,
  );
  if (index < 0) return;
  const pending = pendingInputs[index];
  if (pending) {
    pending.sentAt = sentAt;
    metrics[pending.formFactor].inputAcceptanceToWebSocketSendMs.add(
      sentAt - acceptedAt,
    );
  }
}

export function recordTerminalOutputReceived(
  terminalId: string,
  timestamp: number,
): number | null {
  if (!Number.isFinite(timestamp)) return null;
  const firstInput: SentTerminalInput | null =
    pendingInputs.find((pending): pending is SentTerminalInput => {
      const sentAt = pending.sentAt;
      return (
        pending.terminalId === terminalId &&
        sentAt !== undefined &&
        sentAt <= timestamp
      );
    }) ?? null;
  if (firstInput !== null) {
    const firstSentAt = firstInput.sentAt;
    metrics[firstInput.formFactor].inputToFirstOutputReceivedMs.add(
      timestamp - firstInput.timestamp,
    );
    metrics[
      firstInput.formFactor
    ].inputWebSocketSendToFirstOutputReceivedMs.add(timestamp - firstSentAt);
    for (let index = pendingInputs.length - 1; index >= 0; index -= 1) {
      const pending = pendingInputs[index];
      if (
        pending?.terminalId === terminalId &&
        pending.sentAt !== undefined &&
        pending.sentAt <= timestamp
      ) {
        pendingInputs.splice(index, 1);
      }
    }
  }
  const frameId = nextOutputFrameId++;
  pendingRenders[frameId % RING_SIZE] = {
    frameId,
    formFactor: firstInput?.formFactor ?? currentFormFactor(),
    terminalId,
    inputAcceptedAt: firstInput?.timestamp ?? null,
    inputEventAt: firstInput?.inputEventAt ?? null,
    receivedAt: timestamp,
  };
  return frameId;
}

export function recordTerminalOutputRendered(
  terminalId: string,
  frameId: number | undefined,
  renderedAt: number,
): void {
  if (frameId === undefined || !Number.isSafeInteger(frameId)) return;
  const index = frameId % RING_SIZE;
  const pending = pendingRenders[index];
  if (pending?.frameId !== frameId || pending.terminalId !== terminalId) return;
  pendingRenders[index] = undefined;
  const formFactor = pending?.formFactor ?? currentFormFactor();
  metrics[formFactor].outputRenderMs.add(renderedAt - pending.receivedAt);
  if (
    pending?.inputAcceptedAt !== null &&
    pending?.inputAcceptedAt !== undefined
  ) {
    metrics[formFactor].inputFirstOutputReceivedToRenderMs.add(
      renderedAt - pending.receivedAt,
    );
  }
  if (pending?.inputEventAt !== null && pending?.inputEventAt !== undefined) {
    metrics[formFactor].inputToFirstOutputRenderMs.add(
      renderedAt - pending.inputEventAt,
    );
  }
}

function snapshot(formFactor: "desktop" | "phone"): TerminalLatencySnapshot {
  return {
    inputEventToSerializationMs:
      metrics[formFactor].inputEventToSerializationMs.snapshot(),
    inputSerializationToAcceptanceMs:
      metrics[formFactor].inputSerializationToAcceptanceMs.snapshot(),
    inputAcceptanceToWebSocketSendMs:
      metrics[formFactor].inputAcceptanceToWebSocketSendMs.snapshot(),
    inputWebSocketSendToFirstOutputReceivedMs:
      metrics[formFactor].inputWebSocketSendToFirstOutputReceivedMs.snapshot(),
    inputToFirstOutputReceivedMs:
      metrics[formFactor].inputToFirstOutputReceivedMs.snapshot(),
    inputFirstOutputReceivedToRenderMs:
      metrics[formFactor].inputFirstOutputReceivedToRenderMs.snapshot(),
    inputToFirstOutputRenderMs:
      metrics[formFactor].inputToFirstOutputRenderMs.snapshot(),
    outputRenderMs: metrics[formFactor].outputRenderMs.snapshot(),
  };
}

export function getTerminalLatencyDiagnostics(): TerminalLatencyDiagnosticsSnapshot {
  return { desktop: snapshot("desktop"), phone: snapshot("phone") };
}
