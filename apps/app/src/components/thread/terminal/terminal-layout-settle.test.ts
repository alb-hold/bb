import {
  TerminalWebSocketTransport,
  type TerminalBrowserSocket,
} from "@bb/client-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchTerminalLayoutSettled } from "./terminal-layout-settle";

const FRAME_MS = 16;

class SentSocket implements TerminalBrowserSocket {
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = 1;
  readonly resizeCols: number[] = [];

  close(): void {
    this.readyState = 3;
  }

  send(data: string): void {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "resize" &&
      "cols" in parsed &&
      typeof parsed.cols === "number"
    ) {
      this.resizeCols.push(parsed.cols);
    }
  }
}

function frameScheduler() {
  return {
    cancelFrame: (handle: number) => {
      clearTimeout(handle);
    },
    requestFrame: (callback: () => void) =>
      Number(setTimeout(callback, FRAME_MS)),
  };
}

describe("watchTerminalLayoutSettled", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports once the measured size has been unchanged for two frames", () => {
    vi.useFakeTimers();
    const sizes = ["0x0", "100x40", "120x40", "120x40", "120x40"];
    let index = 0;
    const onSettled = vi.fn();
    watchTerminalLayoutSettled({
      ...frameScheduler(),
      measure: () => sizes[Math.min(index++, sizes.length - 1)] ?? null,
      onSettled,
    });

    vi.advanceTimersByTime(FRAME_MS * 4);
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(onSettled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FRAME_MS * 20);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("never reports a hidden container and stops when cancelled", () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const stop = watchTerminalLayoutSettled({
      ...frameScheduler(),
      measure: () => null,
      onSettled,
    });

    vi.advanceTimersByTime(FRAME_MS * 30);
    stop();
    vi.advanceTimersByTime(FRAME_MS * 30);

    expect(onSettled).not.toHaveBeenCalled();
  });

  it.each([100, 800, 2000])(
    "sends exactly one resize with the final size when the container settles at %i ms",
    (settleAtMs) => {
      vi.useFakeTimers();
      const socket = new SentSocket();
      const transport = new TerminalWebSocketTransport({
        createSocket: () => socket,
        onMessage: () => undefined,
        shouldReconnect: () => false,
        url: "ws://example.test/ws/terminals/term_1",
      });
      let containerCols = 128;
      let elapsedFrames = 0;
      const settleFrame = Math.ceil(settleAtMs / FRAME_MS);
      const fit = () => transport.sendResize(containerCols, 43);
      fit();
      transport.start();
      socket.onopen?.(new Event("open"));
      watchTerminalLayoutSettled({
        ...frameScheduler(),
        measure: () => {
          elapsedFrames += 1;
          if (elapsedFrames < settleFrame) {
            return `in-flux-${elapsedFrames}`;
          }
          if (containerCols !== 132) {
            containerCols = 132;
            fit();
          }
          return "132x43";
        },
        onSettled: () => {
          fit();
          transport.markLayoutSettled();
        },
      });

      vi.advanceTimersByTime(settleAtMs + 10_000);

      expect(socket.resizeCols).toEqual([132]);
      transport.dispose();
    },
  );

  it("sends exactly once at the hard ceiling when the container never lays out", () => {
    vi.useFakeTimers();
    const socket = new SentSocket();
    const transport = new TerminalWebSocketTransport({
      createSocket: () => socket,
      onMessage: () => undefined,
      shouldReconnect: () => false,
      url: "ws://example.test/ws/terminals/term_1",
    });
    let containerCols = 128;
    const fit = () => transport.sendResize(containerCols, 43);
    fit();
    transport.start();
    socket.onopen?.(new Event("open"));
    watchTerminalLayoutSettled({
      ...frameScheduler(),
      measure: () => null,
      onSettled: () => {
        fit();
        transport.markLayoutSettled();
      },
    });

    vi.advanceTimersByTime(3000);
    containerCols = 132;
    fit();
    vi.advanceTimersByTime(1900);
    expect(socket.resizeCols).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(socket.resizeCols).toEqual([132]);
    vi.advanceTimersByTime(20_000);
    expect(socket.resizeCols).toEqual([132]);
    transport.dispose();
  });
});
