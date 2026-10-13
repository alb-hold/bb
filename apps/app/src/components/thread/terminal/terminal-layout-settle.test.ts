import {
  TerminalWebSocketTransport,
  type TerminalBrowserSocket,
} from "@bb/client-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasRunningLayoutAnimation,
  observeLayoutSignals,
  watchTerminalLayoutSettled,
} from "./terminal-layout-settle";

const FRAME_MS = 16;

class SentSocket implements TerminalBrowserSocket {
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = 1;
  readonly resizeCols: number[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];

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
      if ("rows" in parsed && typeof parsed.rows === "number") {
        this.resizes.push({ cols: parsed.cols, rows: parsed.rows });
      }
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

  it.each([2000, 3500])(
    "sends exactly one resize with the final size when the container is stable for two frames and a font load changes the fit at %i ms",
    async (fontsReadyAtMs) => {
      vi.useFakeTimers();
      const socket = new SentSocket();
      const transport = new TerminalWebSocketTransport({
        createSocket: () => socket,
        onMessage: () => undefined,
        shouldReconnect: () => false,
        url: "ws://example.test/ws/terminals/term_1",
      });
      let fittedCols = 128;
      const fit = () => transport.sendResize(fittedCols, 43);
      const ready = new Promise<void>((resolve) => {
        setTimeout(() => {
          fittedCols = 132;
          resolve();
        }, fontsReadyAtMs);
      });
      fit();
      transport.start();
      socket.onopen?.(new Event("open"));
      watchTerminalLayoutSettled({
        ...frameScheduler(),
        measure: () => `800x600:${fittedCols}x43`,
        onSettled: () => {
          fit();
          transport.markLayoutSettled();
        },
        ready,
      });

      await vi.advanceTimersByTimeAsync(fontsReadyAtMs + 10_000);

      expect(socket.resizeCols).toEqual([132]);
      transport.dispose();
    },
  );

  it("starts frames immediately when the font set is already ready", async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    watchTerminalLayoutSettled({
      ...frameScheduler(),
      measure: () => "800x600",
      onSettled,
      ready: Promise.resolve(),
    });

    await vi.advanceTimersByTimeAsync(FRAME_MS * 4);

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("does not report when cancelled before the fonts are ready", async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    let resolveReady: () => void = () => undefined;
    const stop = watchTerminalLayoutSettled({
      ...frameScheduler(),
      measure: () => "800x600",
      onSettled,
      ready: new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    });
    stop();
    resolveReady();

    await vi.advanceTimersByTimeAsync(1000);

    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe("hasRunningLayoutAnimation", () => {
  function elementWith(
    animations: readonly { playState: string }[] | undefined,
    parent: Element | null,
  ): Element {
    const element = { parentElement: parent } as Element;
    if (animations !== undefined) {
      Object.assign(element, { getAnimations: () => animations });
    }
    return element;
  }

  it("is true when the container or an ancestor has a running animation", () => {
    const drawer = elementWith([{ playState: "running" }], null);
    const container = elementWith([], drawer);

    expect(hasRunningLayoutAnimation(container)).toBe(true);
  });

  it("is false when every animation on the chain is finished or unsupported", () => {
    const root = elementWith([{ playState: "finished" }], null);
    const container = elementWith([], root);
    const unsupported = elementWith(undefined, null);

    expect(hasRunningLayoutAnimation(container)).toBe(false);
    expect(hasRunningLayoutAnimation(unsupported)).toBe(false);
  });
});

describe("watcher with layout signals after two stable frames", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    const socket = new SentSocket();
    const transport = new TerminalWebSocketTransport({
      createSocket: () => socket,
      onMessage: () => undefined,
      shouldReconnect: () => false,
      url: "ws://example.test/ws/terminals/term_1",
    });
    const doc = new EventTarget();
    const fontSet = new EventTarget();
    const state = { cols: 128, animating: false, fontsLoading: false };
    const fit = () => transport.sendResize(state.cols, 43);
    fit();
    transport.start();
    socket.onopen?.(new Event("open"));
    watchTerminalLayoutSettled({
      ...frameScheduler(),
      measure: () =>
        state.animating || state.fontsLoading
          ? null
          : `800x600:${state.cols}x43`,
      onSettled: () => {
        fit();
        transport.markLayoutSettled();
      },
      ready: Promise.resolve(),
      subscribe: (onSignal) =>
        observeLayoutSignals({
          affectsContainer: (target) => target === doc,
          document: doc,
          fontSet,
          onSignal,
        }),
    });
    return { doc, fit, fontSet, socket, state, transport };
  }

  it("sends exactly one resize at the final size when a transition starts after two stable frames", async () => {
    const { doc, fit, socket, state, transport } = setup();

    await vi.advanceTimersByTimeAsync(FRAME_MS * 3);
    doc.dispatchEvent(new Event("transitionrun"));
    state.animating = true;
    await vi.advanceTimersByTimeAsync(400);
    state.cols = 132;
    state.animating = false;
    fit();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(socket.resizeCols).toEqual([132]);
    transport.dispose();
  });

  it("sends exactly one resize at the final size when a font load starts after fonts.ready resolved", async () => {
    const { fit, fontSet, socket, state, transport } = setup();

    await vi.advanceTimersByTimeAsync(FRAME_MS * 3);
    state.fontsLoading = true;
    fontSet.dispatchEvent(new Event("loading"));
    await vi.advanceTimersByTimeAsync(300);
    state.cols = 132;
    state.fontsLoading = false;
    fit();
    fontSet.dispatchEvent(new Event("loadingdone"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(socket.resizeCols).toEqual([132]);
    transport.dispose();
  });

  it("ignores transitions that do not involve the terminal container", async () => {
    const { socket, transport } = setup();
    const other = new EventTarget();

    await vi.advanceTimersByTimeAsync(FRAME_MS);
    other.dispatchEvent(new Event("transitionrun"));
    await vi.advanceTimersByTimeAsync(FRAME_MS * 12);

    expect(socket.resizeCols).toEqual([128]);
    transport.dispose();
  });

  it("sends a second resize at the final size for a move with no signal after the grace window", async () => {
    const { fit, socket, state, transport } = setup();

    await vi.advanceTimersByTimeAsync(2000);
    state.cols = 132;
    fit();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(socket.resizeCols).toEqual([128, 132]);
    transport.dispose();
  });

  it("unsubscribes from signals once settled", () => {
    const doc = new EventTarget();
    const added: string[] = [];
    const removed: string[] = [];
    const spy = {
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    } as unknown as EventTarget;
    const stop = observeLayoutSignals({
      affectsContainer: () => true,
      document: spy,
      fontSet: doc,
      onSignal: () => undefined,
    });
    stop();

    expect(added.sort()).toEqual(["transitionrun", "transitionstart"]);
    expect(removed.sort()).toEqual(["transitionrun", "transitionstart"]);
  });
});

describe("a signal still active at the 5 s ceiling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(signal: "transition" | "font") {
    vi.useFakeTimers();
    const socket = new SentSocket();
    const transport = new TerminalWebSocketTransport({
      createSocket: () => socket,
      onMessage: () => undefined,
      shouldReconnect: () => false,
      url: "ws://example.test/ws/terminals/term_1",
    });
    const doc = new EventTarget();
    const fontSet = new EventTarget();
    const state = { cols: 128, blocked: true };
    const fit = () => transport.sendResize(state.cols, 43);
    fit();
    transport.start();
    socket.onopen?.(new Event("open"));
    watchTerminalLayoutSettled({
      ...frameScheduler(),
      measure: () => (state.blocked ? null : `800x600:${state.cols}x43`),
      onSettled: () => {
        fit();
        transport.markLayoutSettled();
      },
      ready: Promise.resolve(),
      subscribe: (onSignal) =>
        observeLayoutSignals({
          affectsContainer: (target) => target === doc,
          document: doc,
          fontSet,
          onSignal,
        }),
    });
    if (signal === "transition") {
      doc.dispatchEvent(new Event("transitionrun"));
    } else {
      fontSet.dispatchEvent(new Event("loading"));
    }
    const finish = () => {
      state.cols = 132;
      state.blocked = false;
      fit();
      if (signal === "font") {
        fontSet.dispatchEvent(new Event("loadingdone"));
      }
    };
    return { finish, socket, transport };
  }

  it.each(["transition", "font"] as const)(
    "sends the then-current size once at the ceiling and one more resize to the final size when a %s ends after it",
    async (signal) => {
      const { finish, socket, transport } = setup(signal);

      await vi.advanceTimersByTimeAsync(4999);
      expect(socket.resizes).toEqual([]);
      await vi.advanceTimersByTimeAsync(6001 - 4999);
      expect(socket.resizes).toEqual([{ cols: 128, rows: 43 }]);
      finish();
      await vi.advanceTimersByTimeAsync(20_000);

      expect(socket.resizes).toEqual([
        { cols: 128, rows: 43 },
        { cols: 132, rows: 43 },
      ]);
      transport.dispose();
    },
  );

  it.each(
    (["transition", "font"] as const).flatMap((signal) =>
      [4840, 4900, 4990].map((endsAtMs) => [signal, endsAtMs] as const),
    ),
  )(
    "sends exactly one resize with the final size and no later nudge or restore when a %s ends at %i ms, inside the grace window that crosses the ceiling",
    async (signal, endsAtMs) => {
      const { finish, socket, transport } = setup(signal);

      await vi.advanceTimersByTimeAsync(endsAtMs);
      expect(socket.resizes).toEqual([]);
      finish();
      await vi.advanceTimersByTimeAsync(20_000);

      expect(socket.resizes).toEqual([{ cols: 132, rows: 43 }]);
      transport.dispose();
    },
  );

  it.each(["transition", "font"] as const)(
    "sends one resize with the final size and no nudge wider than the grid when a repaint was requested and a %s ends at 4900 ms",
    async (signal) => {
      const { finish, socket, transport } = setup(signal);

      transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(4900);
      finish();
      await vi.advanceTimersByTimeAsync(20_000);

      const sent = socket.resizes;
      expect(sent[0]).toEqual({ cols: 132, rows: 43 });
      expect(sent.filter((size) => size.cols > 132)).toEqual([]);
      expect(sent[sent.length - 1]).toEqual({ cols: 132, rows: 43 });
      expect(sent.slice(1, -1).every((size) => size.cols < 132)).toBe(true);
      transport.dispose();
    },
  );

  it.each(["transition", "font"] as const)(
    "never sends a nudge wider than the grid at send time and leaves no stale nudge when a %s ends after the ceiling",
    async (signal) => {
      const { finish, socket, transport } = setup(signal);

      transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(6000);
      finish();
      await vi.advanceTimersByTimeAsync(20_000);

      const sent = socket.resizes;
      expect(sent[0]).toEqual({ cols: 128, rows: 43 });
      expect(sent[sent.length - 1]).toEqual({ cols: 132, rows: 43 });
      expect(sent.slice(0, -1).every((size) => size.cols <= 128)).toBe(true);
      expect(sent.filter((size) => size.cols > 128)).toEqual([
        { cols: 132, rows: 43 },
      ]);
      transport.dispose();
    },
  );
});

describe("repaint nudge spacing", () => {
  const RESTORE_DELAY_MS = 400;

  afterEach(() => {
    vi.useRealTimers();
  });

  function settledTransport() {
    vi.useFakeTimers();
    const socket = new SentSocket();
    const transport = new TerminalWebSocketTransport({
      createSocket: () => socket,
      onMessage: () => undefined,
      shouldReconnect: () => false,
      url: "ws://example.test/ws/terminals/term_1",
    });
    transport.sendResize(132, 46);
    transport.start();
    socket.onopen?.(new Event("open"));
    transport.markLayoutSettled();
    socket.resizes.length = 0;
    return { socket, transport };
  }

  it("holds the restore until the program has had 400 ms to redraw at the narrower size", async () => {
    const { socket, transport } = settledTransport();

    transport.requestRepaint();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.resizes).toEqual([{ cols: 131, rows: 46 }]);

    await vi.advanceTimersByTimeAsync(RESTORE_DELAY_MS - 1);
    expect(socket.resizes).toEqual([{ cols: 131, rows: 46 }]);

    await vi.advanceTimersByTimeAsync(1);
    expect(socket.resizes).toEqual([
      { cols: 131, rows: 46 },
      { cols: 132, rows: 46 },
    ]);
    transport.dispose();
  });

  it("skips the restore when the grid changed during the quiet delay", async () => {
    const { socket, transport } = settledTransport();

    transport.requestRepaint();
    await vi.advanceTimersByTimeAsync(0);
    transport.sendResize(100, 30);
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY_MS * 2);

    expect(socket.resizes).toEqual([
      { cols: 131, rows: 46 },
      { cols: 100, rows: 30 },
    ]);
    transport.dispose();
  });
});
