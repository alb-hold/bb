import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelTerminalOutputPaints,
  getTerminalLatencyDiagnostics,
  recordTerminalInputAccepted,
  recordTerminalInputWebSocketSent,
  recordTerminalOutputPainted,
  recordTerminalOutputParsed,
  recordTerminalOutputReceived,
} from "./terminal-latency-diagnostics.js";

describe("terminal latency diagnostics", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { innerWidth: 1300 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a fixed-size rolling sample and stores numeric measurements only", () => {
    for (let index = 0; index < 400; index += 1) {
      recordTerminalInputAccepted("term-a", index + 1, index, index + 0.5);
      recordTerminalInputWebSocketSent("term-a", index + 1, index + 1.25);
      const frameId = recordTerminalOutputReceived("term-a", index + 2);
      recordTerminalOutputParsed("term-a", frameId ?? undefined, index + 2.5);
      recordTerminalOutputPainted("term-a", index + 3);
    }

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.desktop.outputParseMs.count).toBe(256);
    expect(snapshot.desktop.outputParseMs.totalCount).toBe(400);
    expect(snapshot.desktop.outputParseMs.p50Ms).toBe(0.5);
    expect(snapshot.desktop.outputParseMs.p95Ms).toBe(0.5);
    expect(snapshot.desktop.outputPaintMs.count).toBe(256);
    expect(snapshot.desktop.outputPaintMs.totalCount).toBe(400);
    expect(snapshot.desktop.outputPaintMs.p50Ms).toBe(1);
    expect(snapshot.desktop.outputPaintMs.p95Ms).toBe(1);
    expect(snapshot.desktop.inputToFirstOutputReceivedMs.count).toBe(256);
    expect(snapshot.desktop.inputFirstOutputReceivedToParseMs.count).toBe(256);
    expect(snapshot.desktop.inputFirstOutputReceivedToParseMs.p50Ms).toBe(0.5);
    expect(snapshot.desktop.inputFirstOutputReceivedToPaintMs.count).toBe(256);
    expect(snapshot.desktop.inputToFirstOutputParseMs.count).toBe(256);
    expect(snapshot.desktop.inputToFirstOutputPaintMs.count).toBe(256);
    expect(snapshot.desktop.inputEventToSerializationMs.count).toBe(256);
    expect(snapshot.desktop.inputEventToSerializationMs.totalCount).toBe(400);
    expect(snapshot.desktop.inputEventToSerializationMs.p50Ms).toBe(0.5);
    expect(snapshot.desktop.inputSerializationToAcceptanceMs.count).toBe(256);
    expect(snapshot.desktop.inputSerializationToAcceptanceMs.totalCount).toBe(
      400,
    );
    expect(snapshot.desktop.inputSerializationToAcceptanceMs.p50Ms).toBe(0.5);
    expect(snapshot.desktop.inputAcceptanceToWebSocketSendMs.count).toBe(256);
    expect(snapshot.desktop.inputAcceptanceToWebSocketSendMs.totalCount).toBe(
      400,
    );
    expect(snapshot.desktop.inputAcceptanceToWebSocketSendMs.p50Ms).toBe(0.25);
    expect(snapshot.desktop.inputToFirstOutputParseMs.p50Ms).toBe(2.5);
    expect(snapshot.desktop.inputToFirstOutputPaintMs.p50Ms).toBe(3);
    expect(
      snapshot.desktop.inputWebSocketSendToFirstOutputReceivedMs.count,
    ).toBe(256);
    expect(
      snapshot.desktop.inputWebSocketSendToFirstOutputReceivedMs.totalCount,
    ).toBe(400);
    expect(
      snapshot.desktop.inputWebSocketSendToFirstOutputReceivedMs.p50Ms,
    ).toBe(0.75);
    const recordedValues = Object.values(snapshot.desktop).flatMap((metric) => [
      metric.count,
      metric.totalCount,
      metric.p50Ms,
      metric.p95Ms,
    ]);
    expect(
      recordedValues.every(
        (value) => typeof value === "number" || value === null,
      ),
    ).toBe(true);
    for (const formFactor of [snapshot.desktop, snapshot.phone]) {
      for (const metric of Object.values(formFactor)) {
        expect(Object.keys(metric)).toEqual([
          "count",
          "totalCount",
          "p50Ms",
          "p95Ms",
        ]);
        expect(
          Object.values(metric).every(
            (value) => typeof value === "number" || value === null,
          ),
        ).toBe(true);
      }
    }
  });

  it("keeps phone and desktop timing samples separate", () => {
    vi.stubGlobal("window", { innerWidth: 390 });
    const frameId = recordTerminalOutputReceived("term-a", 5);
    recordTerminalOutputParsed("term-a", frameId ?? undefined, 9);
    recordTerminalOutputPainted("term-a", 11);

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.phone.outputParseMs.p50Ms).toBe(4);
    expect(snapshot.phone.outputPaintMs.p50Ms).toBe(6);
    expect(snapshot.desktop.outputParseMs.p50Ms).toBe(0.5);
    expect(snapshot.desktop.outputPaintMs.p50Ms).toBe(1);
  });

  it("attributes a coalesced first output to the first key and stores no terminal text", () => {
    vi.stubGlobal("window", { innerWidth: 390 });
    const keystroke = "private-keystroke-7f31";
    const output = "private-terminal-output-93ad";
    recordTerminalInputAccepted("term-a", 100, 90);
    recordTerminalInputAccepted("term-a", 108, 98);
    recordTerminalInputAccepted("term-a", 116, 106);
    recordTerminalInputWebSocketSent("term-a", 100, 101);
    recordTerminalInputWebSocketSent("term-a", 108, 109);
    recordTerminalInputWebSocketSent("term-a", 116, 117);
    const frameId = recordTerminalOutputReceived("term-a", 130);
    recordTerminalOutputParsed("term-a", frameId ?? undefined, 140);
    recordTerminalOutputPainted("term-a", 150);

    const serialized = JSON.stringify(getTerminalLatencyDiagnostics());
    expect(serialized).not.toContain(keystroke);
    expect(serialized).not.toContain(output);
    expect(
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputReceivedMs.p50Ms,
    ).toBe(30);
    expect(
      getTerminalLatencyDiagnostics().phone
        .inputWebSocketSendToFirstOutputReceivedMs.p50Ms,
    ).toBe(29);
    expect(
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputParseMs.p50Ms,
    ).toBe(50);
    expect(
      getTerminalLatencyDiagnostics().phone.inputFirstOutputReceivedToParseMs
        .p50Ms,
    ).toBe(10);
    expect(
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputPaintMs.p50Ms,
    ).toBe(60);
    expect(
      getTerminalLatencyDiagnostics().phone.inputFirstOutputReceivedToPaintMs
        .p50Ms,
    ).toBe(20);
    expect(
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputReceivedMs.count,
    ).toBe(1);
  });

  it("pairs output only with input sent by its receive time and keeps unsent input", () => {
    const before = getTerminalLatencyDiagnostics().desktop;
    recordTerminalInputAccepted("term-before-send", 10_000);
    const beforeSendFrame = recordTerminalOutputReceived(
      "term-before-send",
      10_005,
    );
    recordTerminalOutputParsed(
      "term-before-send",
      beforeSendFrame ?? undefined,
      10_008,
    );
    recordTerminalOutputPainted("term-before-send", 10_009);

    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before.inputToFirstOutputReceivedMs.totalCount);
    recordTerminalInputWebSocketSent("term-before-send", 10_000, 10_020);
    recordTerminalOutputReceived("term-before-send", 10_025);

    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before.inputToFirstOutputReceivedMs.totalCount + 1);
  });

  it("does not pair output from another terminal with pending input", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount;
    recordTerminalInputAccepted("term-cross-a", 20_000);
    recordTerminalInputWebSocketSent("term-cross-a", 20_000, 20_001);

    const otherFrame = recordTerminalOutputReceived("term-cross-b", 20_005);
    recordTerminalOutputParsed("term-cross-b", otherFrame ?? undefined, 20_008);
    recordTerminalOutputPainted("term-cross-b", 20_009);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before);

    const ownFrame = recordTerminalOutputReceived("term-cross-a", 20_010);
    recordTerminalOutputParsed("term-cross-a", ownFrame ?? undefined, 20_012);
    recordTerminalOutputPainted("term-cross-a", 20_013);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before + 1);
  });

  it("consumes every sent input coalesced into the first output frame", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount;
    for (let index = 0; index < 127; index += 1) {
      const enqueuedAt = 40_000 + index * 100;
      recordTerminalInputAccepted("term-coalesce-fill", enqueuedAt);
      recordTerminalInputWebSocketSent(
        "term-coalesce-fill",
        enqueuedAt,
        enqueuedAt + 1,
      );
      recordTerminalOutputReceived("term-coalesce-fill", enqueuedAt + 12);
    }
    for (let index = 0; index < 128; index += 1) {
      const enqueuedAt = 60_000 + index * 100;
      recordTerminalInputAccepted("term-coalesce-fill", enqueuedAt);
      recordTerminalInputWebSocketSent(
        "term-coalesce-fill",
        enqueuedAt,
        enqueuedAt + 1,
      );
      recordTerminalOutputReceived("term-coalesce-fill", enqueuedAt + 20);
    }
    recordTerminalInputAccepted("term-coalesced", 30_000);
    recordTerminalInputAccepted("term-coalesced", 30_008);
    recordTerminalInputWebSocketSent("term-coalesced", 30_000, 30_001);
    recordTerminalInputWebSocketSent("term-coalesced", 30_008, 30_009);

    recordTerminalOutputReceived("term-coalesced", 30_020);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before + 256);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .p50Ms,
    ).toBe(20);

    recordTerminalOutputReceived("term-coalesced", 30_030);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before + 256);
  });

  it("measures the first painted output from the keystroke timestamp", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputPaintMs
        .totalCount;
    for (let index = 0; index < 32; index += 1) {
      const inputEventAt = 1_000_000 + index * 100;
      const acceptedAt = inputEventAt + 10;
      const sentAt = inputEventAt + 20;
      const receivedAt = inputEventAt + 30;
      const terminalId = `term-keystroke-anchor-${index}`;
      recordTerminalInputAccepted(
        terminalId,
        acceptedAt,
        inputEventAt,
        inputEventAt + 5,
      );
      recordTerminalInputWebSocketSent(terminalId, acceptedAt, sentAt);
      const frameId = recordTerminalOutputReceived(terminalId, receivedAt);
      recordTerminalOutputParsed(
        terminalId,
        frameId ?? undefined,
        receivedAt + 10,
      );
      recordTerminalOutputPainted(terminalId, inputEventAt + 5_000);
    }

    const metric =
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputPaintMs;
    expect(metric.totalCount).toBe(before + 32);
    expect(metric.p95Ms).toBe(5_000);
  });

  it("pairs delayed parse callbacks and paint events across ring eviction", () => {
    const before = getTerminalLatencyDiagnostics().desktop;
    const terminalId = "term-paint-ring-pairing";
    const frames: Array<{
      frameId: number | null;
      receivedAt: number;
      index: number;
    }> = [];

    for (let index = 0; index < 300; index += 1) {
      const receivedAt = 100_000 + index * 100;
      const inputEventAt = receivedAt - (1_000 + index);
      const acceptedAt = inputEventAt + 100;
      recordTerminalInputAccepted(
        terminalId,
        acceptedAt,
        inputEventAt,
        inputEventAt + 50,
      );
      recordTerminalInputWebSocketSent(
        terminalId,
        acceptedAt,
        inputEventAt + 200,
      );
      frames.push({
        frameId: recordTerminalOutputReceived(terminalId, receivedAt),
        receivedAt,
        index,
      });
    }

    for (const frame of frames.slice(0, 150)) {
      recordTerminalOutputParsed(
        terminalId,
        frame.frameId ?? undefined,
        frame.receivedAt + frame.index,
      );
      recordTerminalOutputPainted(
        terminalId,
        frame.receivedAt + frame.index + 1,
      );
    }
    for (const frame of frames.slice(150).reverse()) {
      recordTerminalOutputParsed(
        terminalId,
        frame.frameId ?? undefined,
        frame.receivedAt + frame.index,
      );
      recordTerminalOutputPainted(
        terminalId,
        frame.receivedAt + frame.index + 1,
      );
    }

    const after = getTerminalLatencyDiagnostics().desktop;
    expect(after.outputParseMs.totalCount).toBe(
      before.outputParseMs.totalCount + 256,
    );
    expect(after.outputParseMs.count).toBe(256);
    expect(after.outputParseMs.p50Ms).toBe(171);
    expect(after.outputParseMs.p95Ms).toBe(287);
    expect(after.outputPaintMs.totalCount).toBe(
      before.outputPaintMs.totalCount + 256,
    );
    expect(after.outputPaintMs.count).toBe(256);
    expect(after.outputPaintMs.p50Ms).toBe(172);
    expect(after.outputPaintMs.p95Ms).toBe(288);
    expect(after.inputToFirstOutputReceivedMs.totalCount).toBe(
      before.inputToFirstOutputReceivedMs.totalCount + 300,
    );
    expect(after.inputToFirstOutputPaintMs.totalCount).toBe(
      before.inputToFirstOutputPaintMs.totalCount + 256,
    );
    expect(after.inputToFirstOutputPaintMs.p50Ms).toBe(1_343);
    expect(after.inputToFirstOutputPaintMs.p95Ms).toBe(1_575);
  });

  it("records paint on the first terminal render after its matching parse", () => {
    const terminalId = "term-parse-before-paint";
    const before = getTerminalLatencyDiagnostics().desktop;
    recordTerminalInputAccepted(terminalId, 11, 10);
    recordTerminalInputWebSocketSent(terminalId, 11, 12);
    const frameId = recordTerminalOutputReceived(terminalId, 20);

    recordTerminalOutputPainted(terminalId, 25);
    expect(
      getTerminalLatencyDiagnostics().desktop.outputPaintMs.totalCount,
    ).toBe(before.outputPaintMs.totalCount);

    recordTerminalOutputParsed(terminalId, frameId ?? undefined, 30);
    recordTerminalOutputPainted(terminalId, 35);

    const snapshot = getTerminalLatencyDiagnostics().desktop;
    expect(snapshot.outputParseMs.totalCount).toBe(
      before.outputParseMs.totalCount + 1,
    );
    expect(snapshot.outputPaintMs.totalCount).toBe(
      before.outputPaintMs.totalCount + 1,
    );
    expect(snapshot.inputToFirstOutputPaintMs.totalCount).toBe(
      before.inputToFirstOutputPaintMs.totalCount + 1,
    );
  });

  it("does not record paint for a hidden terminal on a later render", () => {
    const terminalId = "term-hidden-before-paint";
    const before = getTerminalLatencyDiagnostics().desktop;
    const frameId = recordTerminalOutputReceived(terminalId, 50);
    cancelTerminalOutputPaints(terminalId);
    recordTerminalOutputParsed(terminalId, frameId ?? undefined, 55);
    recordTerminalOutputPainted(terminalId, 65);

    const snapshot = getTerminalLatencyDiagnostics().desktop;
    expect(snapshot.outputParseMs.totalCount).toBe(
      before.outputParseMs.totalCount + 1,
    );
    expect(snapshot.outputPaintMs.totalCount).toBe(
      before.outputPaintMs.totalCount,
    );
  });
});
