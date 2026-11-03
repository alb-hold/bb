import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelTerminalOutputNextRenders,
  getTerminalLatencyDiagnostics,
  recordTerminalInputAccepted,
  recordTerminalInputWebSocketSent,
  recordTerminalOutputNextRender,
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
      recordTerminalOutputNextRender("term-a", index + 3);
    }

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.desktop.outputParseMs.count).toBe(256);
    expect(snapshot.desktop.outputParseMs.totalCount).toBe(400);
    expect(snapshot.desktop.outputParseMs.p50Ms).toBe(0.5);
    expect(snapshot.desktop.outputParseMs.p95Ms).toBe(0.5);
    expect(snapshot.desktop.outputNextRenderMs.count).toBe(256);
    expect(snapshot.desktop.outputNextRenderMs.totalCount).toBe(400);
    expect(snapshot.desktop.outputNextRenderMs.p50Ms).toBe(1);
    expect(snapshot.desktop.outputNextRenderMs.p95Ms).toBe(1);
    expect(snapshot.desktop.inputAcceptedToFirstOutputAfterSendMs.count).toBe(
      256,
    );
    expect(snapshot.desktop.firstOutputAfterSendToParseMs.count).toBe(256);
    expect(snapshot.desktop.firstOutputAfterSendToParseMs.p50Ms).toBe(0.5);
    expect(snapshot.desktop.firstOutputAfterSendToNextRenderMs.count).toBe(256);
    expect(snapshot.desktop.inputEventToFirstOutputAfterSendParseMs.count).toBe(
      256,
    );
    expect(
      snapshot.desktop.inputEventToFirstOutputAfterSendNextRenderMs.count,
    ).toBe(256);
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
    expect(snapshot.desktop.inputEventToFirstOutputAfterSendParseMs.p50Ms).toBe(
      2.5,
    );
    expect(
      snapshot.desktop.inputEventToFirstOutputAfterSendNextRenderMs.p50Ms,
    ).toBe(3);
    expect(snapshot.desktop.inputSendToFirstOutputAfterSendMs.count).toBe(256);
    expect(snapshot.desktop.inputSendToFirstOutputAfterSendMs.totalCount).toBe(
      400,
    );
    expect(snapshot.desktop.inputSendToFirstOutputAfterSendMs.p50Ms).toBe(0.75);
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
    recordTerminalOutputNextRender("term-a", 11);

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.phone.outputParseMs.p50Ms).toBe(4);
    expect(snapshot.phone.outputNextRenderMs.p50Ms).toBe(6);
    expect(snapshot.desktop.outputParseMs.p50Ms).toBe(0.5);
    expect(snapshot.desktop.outputNextRenderMs.p50Ms).toBe(1);
  });

  it("records first same-terminal output after send as a temporal proxy and stores no terminal text", () => {
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
    recordTerminalOutputNextRender("term-a", 150);

    const serialized = JSON.stringify(getTerminalLatencyDiagnostics());
    expect(serialized).not.toContain(keystroke);
    expect(serialized).not.toContain(output);
    expect(
      getTerminalLatencyDiagnostics().phone
        .inputAcceptedToFirstOutputAfterSendMs.p50Ms,
    ).toBe(30);
    expect(
      getTerminalLatencyDiagnostics().phone.inputSendToFirstOutputAfterSendMs
        .p50Ms,
    ).toBe(29);
    expect(
      getTerminalLatencyDiagnostics().phone
        .inputEventToFirstOutputAfterSendParseMs.p50Ms,
    ).toBe(50);
    expect(
      getTerminalLatencyDiagnostics().phone.firstOutputAfterSendToParseMs.p50Ms,
    ).toBe(10);
    expect(
      getTerminalLatencyDiagnostics().phone
        .inputEventToFirstOutputAfterSendNextRenderMs.p50Ms,
    ).toBe(60);
    expect(
      getTerminalLatencyDiagnostics().phone.firstOutputAfterSendToNextRenderMs
        .p50Ms,
    ).toBe(20);
    expect(
      getTerminalLatencyDiagnostics().phone
        .inputAcceptedToFirstOutputAfterSendMs.count,
    ).toBe(1);
  });

  it("counts output only after same-terminal send time and keeps unsent input", () => {
    const before = getTerminalLatencyDiagnostics().desktop;
    recordTerminalInputAccepted("term-before-send", 10_000);
    recordTerminalInputWebSocketSent("term-before-send", 10_000, 10_020);
    const beforeSendFrame = recordTerminalOutputReceived(
      "term-before-send",
      10_005,
    );
    recordTerminalOutputParsed(
      "term-before-send",
      beforeSendFrame ?? undefined,
      10_008,
    );
    recordTerminalOutputNextRender("term-before-send", 10_009);

    expect(
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.totalCount,
    ).toBe(before.inputAcceptedToFirstOutputAfterSendMs.totalCount);
    recordTerminalOutputReceived("term-before-send", 10_025);

    expect(
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.totalCount,
    ).toBe(before.inputAcceptedToFirstOutputAfterSendMs.totalCount + 1);
  });

  it("counts asynchronous same-terminal output after send as the temporal proxy", () => {
    const terminalId = "term-asynchronous-output-after-send";
    const before = getTerminalLatencyDiagnostics().desktop;
    for (let index = 0; index < 300; index += 1) {
      const sentAt = 1_000_000 + index * 10;
      const acceptedAt = sentAt - 2;
      recordTerminalInputAccepted(terminalId, acceptedAt, acceptedAt - 5);
      recordTerminalInputWebSocketSent(terminalId, acceptedAt, sentAt);
      recordTerminalOutputReceived(terminalId, sentAt + 5);
      recordTerminalOutputReceived(terminalId, sentAt + 6);
    }

    const snapshot = getTerminalLatencyDiagnostics().desktop;
    expect(snapshot.inputAcceptedToFirstOutputAfterSendMs.totalCount).toBe(
      before.inputAcceptedToFirstOutputAfterSendMs.totalCount + 300,
    );
    expect(snapshot.inputAcceptedToFirstOutputAfterSendMs.p50Ms).toBe(7);
    expect(snapshot.inputSendToFirstOutputAfterSendMs.p50Ms).toBe(5);
  });

  it("ignores other-terminal output for pending input", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.totalCount;
    recordTerminalInputAccepted("term-cross-a", 20_000);
    recordTerminalInputWebSocketSent("term-cross-a", 20_000, 20_001);

    const otherFrame = recordTerminalOutputReceived("term-cross-b", 20_005);
    recordTerminalOutputParsed("term-cross-b", otherFrame ?? undefined, 20_008);
    recordTerminalOutputNextRender("term-cross-b", 20_009);
    expect(
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.totalCount,
    ).toBe(before);

    const ownFrame = recordTerminalOutputReceived("term-cross-a", 20_010);
    recordTerminalOutputParsed("term-cross-a", ownFrame ?? undefined, 20_012);
    recordTerminalOutputNextRender("term-cross-a", 20_013);
    expect(
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.totalCount,
    ).toBe(before + 1);
  });

  it("clears each same-terminal sent input at the first subsequent output", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.totalCount;
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
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.totalCount,
    ).toBe(before + 256);
    expect(
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.p50Ms,
    ).toBe(20);

    recordTerminalOutputReceived("term-coalesced", 30_030);
    expect(
      getTerminalLatencyDiagnostics().desktop
        .inputAcceptedToFirstOutputAfterSendMs.totalCount,
    ).toBe(before + 256);
  });

  it("measures input-event-to-next-render after first output following send", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop
        .inputEventToFirstOutputAfterSendNextRenderMs.totalCount;
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
      recordTerminalOutputNextRender(terminalId, inputEventAt + 5_000);
    }

    const metric =
      getTerminalLatencyDiagnostics().desktop
        .inputEventToFirstOutputAfterSendNextRenderMs;
    expect(metric.totalCount).toBe(before + 32);
    expect(metric.p95Ms).toBe(5_000);
  });

  it("pairs delayed parse callbacks and next-render callbacks across ring eviction", () => {
    const before = getTerminalLatencyDiagnostics().desktop;
    const terminalId = "term-next-render-ring-pairing";
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
      recordTerminalOutputNextRender(
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
      recordTerminalOutputNextRender(
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
    expect(after.outputNextRenderMs.totalCount).toBe(
      before.outputNextRenderMs.totalCount + 256,
    );
    expect(after.outputNextRenderMs.count).toBe(256);
    expect(after.outputNextRenderMs.p50Ms).toBe(172);
    expect(after.outputNextRenderMs.p95Ms).toBe(288);
    expect(after.inputAcceptedToFirstOutputAfterSendMs.totalCount).toBe(
      before.inputAcceptedToFirstOutputAfterSendMs.totalCount + 300,
    );
    expect(after.inputEventToFirstOutputAfterSendNextRenderMs.totalCount).toBe(
      before.inputEventToFirstOutputAfterSendNextRenderMs.totalCount + 256,
    );
    expect(after.inputEventToFirstOutputAfterSendNextRenderMs.p50Ms).toBe(
      1_343,
    );
    expect(after.inputEventToFirstOutputAfterSendNextRenderMs.p95Ms).toBe(
      1_575,
    );
  });

  it("next render after parse completes pending frames regardless of rows", () => {
    const terminalId = "term-parse-before-next-render";
    const before = getTerminalLatencyDiagnostics().desktop;
    recordTerminalInputAccepted(terminalId, 11, 10);
    recordTerminalInputWebSocketSent(terminalId, 11, 12);
    const frameId = recordTerminalOutputReceived(terminalId, 20);
    const nextFrameId = recordTerminalOutputReceived(terminalId, 22);

    recordTerminalOutputNextRender(terminalId, 25);
    expect(
      getTerminalLatencyDiagnostics().desktop.outputNextRenderMs.totalCount,
    ).toBe(before.outputNextRenderMs.totalCount);

    recordTerminalOutputParsed(terminalId, frameId ?? undefined, 30);
    recordTerminalOutputParsed(terminalId, nextFrameId ?? undefined, 32);
    recordTerminalOutputNextRender(terminalId, 35);

    const snapshot = getTerminalLatencyDiagnostics().desktop;
    expect(snapshot.outputParseMs.totalCount).toBe(
      before.outputParseMs.totalCount + 2,
    );
    expect(snapshot.outputNextRenderMs.totalCount).toBe(
      before.outputNextRenderMs.totalCount + 2,
    );
    expect(
      snapshot.inputEventToFirstOutputAfterSendNextRenderMs.totalCount,
    ).toBe(before.inputEventToFirstOutputAfterSendNextRenderMs.totalCount + 1);
  });

  it("does not record a next-render sample when the terminal is hidden", () => {
    const terminalId = "term-hidden-before-next-render";
    const before = getTerminalLatencyDiagnostics().desktop;
    const frameId = recordTerminalOutputReceived(terminalId, 50);
    cancelTerminalOutputNextRenders(terminalId);
    recordTerminalOutputParsed(terminalId, frameId ?? undefined, 55);
    recordTerminalOutputNextRender(terminalId, 65);

    const snapshot = getTerminalLatencyDiagnostics().desktop;
    expect(snapshot.outputParseMs.totalCount).toBe(
      before.outputParseMs.totalCount + 1,
    );
    expect(snapshot.outputNextRenderMs.totalCount).toBe(
      before.outputNextRenderMs.totalCount,
    );
  });
});
