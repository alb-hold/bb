import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTerminalLatencyDiagnostics,
  recordTerminalInputEnqueued,
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
      recordTerminalInputEnqueued(index + 1, index);
      recordTerminalInputWebSocketSent(index + 1, index + 1.25);
      recordTerminalOutputReceived(index + 2);
      recordTerminalOutputRendered(index + 2, index + 3);
    }

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.desktop.outputRenderMs.count).toBe(256);
    expect(snapshot.desktop.outputRenderMs.totalCount).toBe(400);
    expect(snapshot.desktop.outputRenderMs.p50Ms).toBe(1);
    expect(snapshot.desktop.outputRenderMs.p95Ms).toBe(1);
    expect(snapshot.desktop.inputToFirstOutputReceivedMs.count).toBe(256);
    expect(snapshot.desktop.inputEchoReceivedToRenderMs.count).toBe(256);
    expect(snapshot.desktop.inputEchoReceivedToRenderMs.p50Ms).toBe(1);
    expect(snapshot.desktop.inputToFirstOutputRenderMs.count).toBe(256);
    expect(snapshot.desktop.inputEventToEnqueueMs.count).toBe(256);
    expect(snapshot.desktop.inputEventToEnqueueMs.totalCount).toBe(400);
    expect(snapshot.desktop.inputEventToEnqueueMs.p50Ms).toBe(1);
    expect(snapshot.desktop.inputEnqueueToWebSocketSendMs.count).toBe(256);
    expect(snapshot.desktop.inputEnqueueToWebSocketSendMs.totalCount).toBe(400);
    expect(snapshot.desktop.inputEnqueueToWebSocketSendMs.p50Ms).toBe(0.25);
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
    recordTerminalOutputReceived(5);
    recordTerminalOutputRendered(5, 11);

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.phone.outputRenderMs.p50Ms).toBe(6);
    expect(snapshot.desktop.outputRenderMs.p50Ms).toBe(1);
  });

  it("attributes a coalesced echo to the first key and stores no terminal text", () => {
    vi.stubGlobal("window", { innerWidth: 390 });
    const keystroke = "private-keystroke-7f31";
    const output = "private-terminal-output-93ad";
    recordTerminalInputEnqueued(100);
    recordTerminalInputEnqueued(108);
    recordTerminalInputEnqueued(116);
    recordTerminalInputWebSocketSent(100, 101);
    recordTerminalInputWebSocketSent(108, 109);
    recordTerminalInputWebSocketSent(116, 117);
    recordTerminalOutputReceived(130);
    recordTerminalOutputRendered(130, 140);

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
    ).toBe(40);
    expect(
      getTerminalLatencyDiagnostics().phone.inputEchoReceivedToRenderMs.p50Ms,
    ).toBe(10);
    expect(
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputReceivedMs.count,
    ).toBe(1);
  });
});
