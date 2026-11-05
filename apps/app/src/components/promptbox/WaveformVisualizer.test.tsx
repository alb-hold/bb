// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WaveformVisualizer } from "./WaveformVisualizer";

const closedContext = () =>
  Promise.reject(new DOMException("Context is closed", "InvalidStateError"));

class ClosedAudioContext {
  state = "suspended";
  resume = closedContext;
  close = closedContext;
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
  createAnalyser() {
    return {
      fftSize: 0,
      disconnect: () => {},
      getByteTimeDomainData: (data: Uint8Array) => data.fill(128),
    };
  }
}

const noOpContext2d = new Proxy(
  {},
  { get: (_target, key) => (key === "canvas" ? undefined : () => {}) },
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setupAudio(reducedMotion: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  let sample = 128;
  const analysisTrack = { stop: vi.fn() };
  const recordingTrack = { clone: () => analysisTrack, stop: vi.fn() };
  class TestMediaStream {
    getAudioTracks() {
      return [recordingTrack];
    }
  }
  vi.stubGlobal("MediaStream", TestMediaStream);
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 1024,
          getByteTimeDomainData: (data: Uint8Array) => data.fill(sample),
          disconnect: vi.fn(),
        };
      }
    },
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) =>
    frames.delete(frame),
  );
  const moveTo = vi.fn();
  const lineTo = vi.fn();
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo,
    lineTo,
    stroke: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 100, 40));
  return {
    stream: new MediaStream(),
    recordingTrack,
    analysisTrack,
    frames,
    drawSample(value: number) {
      sample = value;
      moveTo.mockClear();
      lineTo.mockClear();
      act(() => {
        for (let iteration = 0; iteration < 2; iteration++) {
          const pending = [...frames.values()];
          frames.clear();
          for (const callback of pending) callback(0);
        }
      });
      return lineTo.mock.calls.map(
        ([, bottom], index) => bottom - moveTo.mock.calls[index][1],
      );
    },
  };
}

describe("WaveformVisualizer", () => {
  it.each([false, true])(
    "shows changing input levels with reduced motion %s without stopping the recording track",
    (reducedMotion) => {
      const audio = setupAudio(reducedMotion);
      const view = render(<WaveformVisualizer active stream={audio.stream} />);

      const quiet = audio.drawSample(128);
      const loud = audio.drawSample(160);
      expect(loud.length).toBeGreaterThan(0);
      expect(loud[0]).toBeGreaterThan(quiet[0]);

      const silent = audio.drawSample(128);
      expect(silent[0]).toBeLessThan(loud[0]);
      expect(silent[1]).toBe(loud[0]);

      view.unmount();
      expect(audio.frames.size).toBe(0);
      expect(audio.analysisTrack.stop).toHaveBeenCalledOnce();
      expect(audio.recordingTrack.stop).not.toHaveBeenCalled();
    },
  );

  it("keeps inactive input static", () => {
    const audio = setupAudio(false);
    render(<WaveformVisualizer active={false} stream={audio.stream} />);
    expect(audio.frames.size).toBe(0);
  });

  it("handles an audio context that rejects resume and close", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("AudioContext", ClosedAudioContext);
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      noOpContext2d as CanvasRenderingContext2D,
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const stop = vi.fn();
    const stream = {
      getAudioTracks: () => [{ clone: () => ({ stop }) }],
    } as unknown as MediaStream;
    try {
      const view = render(<WaveformVisualizer stream={stream} active />);
      frames.shift()?.(0);
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stop).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
