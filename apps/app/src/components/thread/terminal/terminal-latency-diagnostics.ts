const RING_SIZE = 256;

type LatencyMetric =
  | "inputEventToSerializationMs"
  | "inputSerializationToAcceptanceMs"
  | "inputAcceptanceToWebSocketSendMs"
  | "inputWebSocketSendToFirstOutputReceivedMs"
  | "inputToFirstOutputReceivedMs"
  | "inputFirstOutputReceivedToParseMs"
  | "inputToFirstOutputParseMs"
  | "outputParseMs"
  | "inputFirstOutputReceivedToPaintMs"
  | "inputToFirstOutputPaintMs"
  | "outputPaintMs";

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
  inputFirstOutputReceivedToParseMs: TerminalLatencyMetricSnapshot;
  inputToFirstOutputParseMs: TerminalLatencyMetricSnapshot;
  outputParseMs: TerminalLatencyMetricSnapshot;
  inputFirstOutputReceivedToPaintMs: TerminalLatencyMetricSnapshot;
  inputToFirstOutputPaintMs: TerminalLatencyMetricSnapshot;
  outputPaintMs: TerminalLatencyMetricSnapshot;
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
    inputFirstOutputReceivedToParseMs: new LatencyRing(),
    inputToFirstOutputParseMs: new LatencyRing(),
    outputParseMs: new LatencyRing(),
    inputFirstOutputReceivedToPaintMs: new LatencyRing(),
    inputToFirstOutputPaintMs: new LatencyRing(),
    outputPaintMs: new LatencyRing(),
  },
  phone: {
    inputEventToSerializationMs: new LatencyRing(),
    inputSerializationToAcceptanceMs: new LatencyRing(),
    inputAcceptanceToWebSocketSendMs: new LatencyRing(),
    inputWebSocketSendToFirstOutputReceivedMs: new LatencyRing(),
    inputToFirstOutputReceivedMs: new LatencyRing(),
    inputFirstOutputReceivedToParseMs: new LatencyRing(),
    inputToFirstOutputParseMs: new LatencyRing(),
    outputParseMs: new LatencyRing(),
    inputFirstOutputReceivedToPaintMs: new LatencyRing(),
    inputToFirstOutputPaintMs: new LatencyRing(),
    outputPaintMs: new LatencyRing(),
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
type PendingTerminalOutputFrame = {
  frameId: number;
  formFactor: FormFactor;
  terminalId: string;
  inputAcceptedAt: number | null;
  inputEventAt: number | null;
  receivedAt: number;
  parsedAt?: number;
  paintCancelled?: boolean;
};

const pendingOutputFrames: Array<PendingTerminalOutputFrame | undefined> =
  Array.from({
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
  pendingOutputFrames[frameId % RING_SIZE] = {
    frameId,
    formFactor: firstInput?.formFactor ?? currentFormFactor(),
    terminalId,
    inputAcceptedAt: firstInput?.timestamp ?? null,
    inputEventAt: firstInput?.inputEventAt ?? null,
    receivedAt: timestamp,
  };
  return frameId;
}

export function recordTerminalOutputParsed(
  terminalId: string,
  frameId: number | undefined,
  parsedAt: number,
): void {
  if (
    frameId === undefined ||
    !Number.isSafeInteger(frameId) ||
    !Number.isFinite(parsedAt)
  )
    return;
  const index = frameId % RING_SIZE;
  const pending = pendingOutputFrames[index];
  if (pending?.frameId !== frameId || pending.terminalId !== terminalId) return;
  if (pending.parsedAt !== undefined) return;
  pending.parsedAt = parsedAt;
  const formFactor = pending.formFactor;
  metrics[formFactor].outputParseMs.add(parsedAt - pending.receivedAt);
  if (pending.inputAcceptedAt !== null) {
    metrics[formFactor].inputFirstOutputReceivedToParseMs.add(
      parsedAt - pending.receivedAt,
    );
  }
  if (pending.inputEventAt !== null) {
    metrics[formFactor].inputToFirstOutputParseMs.add(
      parsedAt - pending.inputEventAt,
    );
  }
}

export function recordTerminalOutputPainted(
  terminalId: string,
  paintedAt: number,
): void {
  if (!Number.isFinite(paintedAt)) return;
  for (let index = 0; index < pendingOutputFrames.length; index += 1) {
    const pending = pendingOutputFrames[index];
    if (
      pending?.terminalId !== terminalId ||
      pending.parsedAt === undefined ||
      pending.paintCancelled === true ||
      pending.parsedAt > paintedAt
    ) {
      continue;
    }
    pendingOutputFrames[index] = undefined;
    const formFactor = pending.formFactor;
    metrics[formFactor].outputPaintMs.add(paintedAt - pending.receivedAt);
    if (pending.inputAcceptedAt !== null) {
      metrics[formFactor].inputFirstOutputReceivedToPaintMs.add(
        paintedAt - pending.receivedAt,
      );
    }
    if (pending.inputEventAt !== null) {
      metrics[formFactor].inputToFirstOutputPaintMs.add(
        paintedAt - pending.inputEventAt,
      );
    }
  }
}

export function cancelTerminalOutputPaints(terminalId: string): void {
  for (const pending of pendingOutputFrames) {
    if (pending?.terminalId === terminalId) {
      pending.paintCancelled = true;
    }
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
    inputFirstOutputReceivedToParseMs:
      metrics[formFactor].inputFirstOutputReceivedToParseMs.snapshot(),
    inputToFirstOutputParseMs:
      metrics[formFactor].inputToFirstOutputParseMs.snapshot(),
    outputParseMs: metrics[formFactor].outputParseMs.snapshot(),
    inputFirstOutputReceivedToPaintMs:
      metrics[formFactor].inputFirstOutputReceivedToPaintMs.snapshot(),
    inputToFirstOutputPaintMs:
      metrics[formFactor].inputToFirstOutputPaintMs.snapshot(),
    outputPaintMs: metrics[formFactor].outputPaintMs.snapshot(),
  };
}

export function getTerminalLatencyDiagnostics(): TerminalLatencyDiagnosticsSnapshot {
  return { desktop: snapshot("desktop"), phone: snapshot("phone") };
}
