import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTerminalLatencyDiagnostics,
  recordTerminalInputAccepted,
  recordTerminalInputWebSocketSent,
  recordTerminalOutputReceived,
  recordTerminalOutputRendered,
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
      recordTerminalOutputRendered("term-a", frameId ?? undefined, index + 3);
    }

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.desktop.outputRenderMs.count).toBe(256);
    expect(snapshot.desktop.outputRenderMs.totalCount).toBe(400);
    expect(snapshot.desktop.outputRenderMs.p50Ms).toBe(1);
    expect(snapshot.desktop.outputRenderMs.p95Ms).toBe(1);
    expect(snapshot.desktop.inputToFirstOutputReceivedMs.count).toBe(256);
    expect(snapshot.desktop.inputFirstOutputReceivedToRenderMs.count).toBe(256);
    expect(snapshot.desktop.inputFirstOutputReceivedToRenderMs.p50Ms).toBe(1);
    expect(snapshot.desktop.inputToFirstOutputRenderMs.count).toBe(256);
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
    expect(snapshot.desktop.inputToFirstOutputRenderMs.p50Ms).toBe(3);
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
    recordTerminalOutputRendered("term-a", frameId ?? undefined, 11);

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.phone.outputRenderMs.p50Ms).toBe(6);
    expect(snapshot.desktop.outputRenderMs.p50Ms).toBe(1);
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
    recordTerminalOutputRendered("term-a", frameId ?? undefined, 140);

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
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputRenderMs.p50Ms,
    ).toBe(50);
    expect(
      getTerminalLatencyDiagnostics().phone.inputFirstOutputReceivedToRenderMs
        .p50Ms,
    ).toBe(10);
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
    recordTerminalOutputRendered(
      "term-before-send",
      beforeSendFrame ?? undefined,
      10_008,
    );

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
    recordTerminalOutputRendered(
      "term-cross-b",
      otherFrame ?? undefined,
      20_008,
    );
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before);

    const ownFrame = recordTerminalOutputReceived("term-cross-a", 20_010);
    recordTerminalOutputRendered("term-cross-a", ownFrame ?? undefined, 20_013);
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

  it("measures the first rendered output from the keystroke timestamp", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputRenderMs
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
      recordTerminalOutputRendered(
        terminalId,
        frameId ?? undefined,
        inputEventAt + 5_000,
      );
    }

    const metric =
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputRenderMs;
    expect(metric.totalCount).toBe(before + 32);
    expect(metric.p95Ms).toBe(5_000);
  });

  it("pairs delayed render callbacks with their own frame and input across ring eviction", () => {
    const before = getTerminalLatencyDiagnostics().desktop;
    const terminalId = "term-render-ring-pairing";
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
      recordTerminalOutputRendered(
        terminalId,
        frame.frameId ?? undefined,
        frame.receivedAt + frame.index + 1,
      );
    }
    for (const frame of frames.slice(150).reverse()) {
      recordTerminalOutputRendered(
        terminalId,
        frame.frameId ?? undefined,
        frame.receivedAt + frame.index + 1,
      );
    }

    const after = getTerminalLatencyDiagnostics().desktop;
    expect(after.outputRenderMs.totalCount).toBe(
      before.outputRenderMs.totalCount + 256,
    );
    expect(after.outputRenderMs.count).toBe(256);
    expect(after.outputRenderMs.p50Ms).toBe(172);
    expect(after.outputRenderMs.p95Ms).toBe(288);
    expect(after.inputToFirstOutputReceivedMs.totalCount).toBe(
      before.inputToFirstOutputReceivedMs.totalCount + 300,
    );
    expect(after.inputToFirstOutputRenderMs.totalCount).toBe(
      before.inputToFirstOutputRenderMs.totalCount + 256,
    );
    expect(after.inputToFirstOutputRenderMs.p50Ms).toBe(1_343);
    expect(after.inputToFirstOutputRenderMs.p95Ms).toBe(1_575);
  });
});
