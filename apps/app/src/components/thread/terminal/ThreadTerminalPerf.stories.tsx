import { useInsertionEffect } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalSession } from "@bb/server-contract";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { ThreadTerminalView } from "./ThreadTerminalView";

export default {
  title: "terminal/ThreadTerminalPerf",
};

type PaneMetric = {
  ackCount: number;
  fitCount: number;
  ptyResizeCount: number;
  renderCount: number;
  renderMs: number;
  renderWhilePaused: number;
  terminalResizeCount: number;
};

type PerfResult = {
  durationMs: number;
  firstInteractiveMs: number | null;
  paneMetrics: Record<string, PaneMetric>;
  resizeAt500Ms: Record<string, PaneMetric> | null;
  resizeAfterSettle: Record<string, PaneMetric> | null;
};

type PerfState = {
  firstInteractiveMs: number | null;
  measurementStarted: boolean;
  panes: Record<string, PaneMetric>;
  result: PerfResult | null;
};

type PerfWindow = Window & { __p19TerminalPerf?: PerfState };

const paneIds = Array.from({ length: 8 }, (_, index) => `term_perf_${index}`);
const sessionById = new Map<string, TerminalSession>(
  paneIds.map((id, index) => [
    id,
    makeTerminalSession({
      id,
      title: `Performance terminal ${index + 1}`,
      cols: 80,
      rows: 18,
    }),
  ]),
);

function emptyMetric(): PaneMetric {
  return {
    ackCount: 0,
    fitCount: 0,
    ptyResizeCount: 0,
    renderCount: 0,
    renderMs: 0,
    renderWhilePaused: 0,
    terminalResizeCount: 0,
  };
}

function metricFor(paneId: string): PaneMetric {
  const state = (window as PerfWindow).__p19TerminalPerf;
  if (state === undefined) {
    throw new Error("Terminal performance measurement is not initialized");
  }
  state.panes[paneId] ??= emptyMetric();
  return state.panes[paneId];
}

function snapshotMetrics(): Record<string, PaneMetric> {
  return Object.fromEntries(
    paneIds.map((paneId) => [paneId, { ...metricFor(paneId) }]),
  );
}

function resetMetrics(): void {
  const state = (window as PerfWindow).__p19TerminalPerf;
  if (state === undefined) {
    return;
  }
  state.panes = Object.fromEntries(paneIds.map((id) => [id, emptyMetric()]));
}

function installRendererInstrumentation(): () => void {
  const terminalPrototype = Terminal.prototype as unknown as {
    open: (element: HTMLElement) => void;
  };
  const originalOpen = terminalPrototype.open;
  terminalPrototype.open = function (element: HTMLElement) {
    originalOpen.call(this, element);
    const paneId = element.closest<HTMLElement>("[data-p19-terminal]")?.dataset
      .p19Terminal;
    const core = this as unknown as {
      _core?: {
        _renderService?: {
          _isPaused: boolean;
          _renderRows: (start: number, end: number) => void;
        };
      };
    };
    const renderService = core._core?._renderService;
    if (paneId === undefined || renderService === undefined) {
      return;
    }
    const originalRenderRows = renderService._renderRows.bind(renderService);
    renderService._renderRows = (start, end) => {
      const startedAt = performance.now();
      try {
        originalRenderRows(start, end);
      } finally {
        const metric = metricFor(paneId);
        metric.renderCount += 1;
        metric.renderMs += performance.now() - startedAt;
        if (renderService._isPaused) {
          metric.renderWhilePaused += 1;
        }
      }
    };
    const terminal = this as unknown as {
      resize: (cols: number, rows: number) => void;
    };
    const originalResize = terminal.resize.bind(terminal);
    terminal.resize = (cols, rows) => {
      metricFor(paneId).terminalResizeCount += 1;
      originalResize(cols, rows);
    };
  };

  const fitPrototype = FitAddon.prototype as unknown as {
    proposeDimensions: () => { cols: number; rows: number } | undefined;
  };
  const originalProposeDimensions = fitPrototype.proposeDimensions;
  fitPrototype.proposeDimensions = function () {
    const terminal = this as unknown as {
      _terminal?: { element?: HTMLElement };
    };
    const paneId = terminal._terminal?.element?.closest<HTMLElement>(
      "[data-p19-terminal]",
    )?.dataset.p19Terminal;
    if (paneId !== undefined) {
      metricFor(paneId).fitCount += 1;
    }
    return originalProposeDimensions.call(this);
  };
  return () => {
    terminalPrototype.open = originalOpen;
    fitPrototype.proposeDimensions = originalProposeDimensions;
  };
}

let restoreRendererInstrumentation: (() => void) | null = null;
let originalWebSocketDescriptor: PropertyDescriptor | undefined;

function StreamingSocket(url: string) {
  const terminalId = new URL(url).pathname.split("/").at(-1) ?? "";
  const session = sessionById.get(terminalId);
  if (session === undefined) {
    throw new Error(`Unknown performance terminal: ${terminalId}`);
  }
  let sequence = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const socket = {
    bufferedAmount: 0,
    onclose: null as ((event: CloseEvent) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onopen: null as ((event: Event) => void) | null,
    readyState: 0,
    close() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      socket.readyState = 3;
    },
    send(raw: string) {
      const message = JSON.parse(raw) as {
        seq?: number;
        type?: string;
      };
      if (message.type === "ack") {
        metricFor(terminalId).ackCount += 1;
        const state = (window as PerfWindow).__p19TerminalPerf;
        if (state?.firstInteractiveMs === null) {
          state.firstInteractiveMs = performance.now();
        }
        if (
          state !== undefined &&
          !state.measurementStarted &&
          paneIds.every((id) => metricFor(id).ackCount > 0)
        ) {
          state.measurementStarted = true;
          window.setTimeout(() => {
            resetMetrics();
            const sampleStartedAt = performance.now();
            window.setTimeout(() => {
              const paneMetrics = snapshotMetrics();
              resetMetrics();
              const probe = document.querySelector<HTMLElement>(
                "[data-p19-resize-probe]",
              );
              probe?.classList.add("p19-resizing");
              if (probe !== null && probe !== undefined) {
                probe.style.width = "calc(100% - 40px)";
              }
              window.setTimeout(() => {
                const resizeAt500Ms = snapshotMetrics();
                window.setTimeout(() => {
                  const resizeAfterSettle = snapshotMetrics();
                  state.result = {
                    durationMs: performance.now() - sampleStartedAt,
                    firstInteractiveMs: state.firstInteractiveMs,
                    paneMetrics,
                    resizeAt500Ms,
                    resizeAfterSettle,
                  };
                  document.documentElement.dataset.p19PerfComplete = "true";
                }, 180);
              }, 500);
            }, 3_000);
          }, 500);
        }
      }
      if (message.type === "resize" && message.seq !== undefined) {
        metricFor(terminalId).ptyResizeCount += 1;
        socket.deliver({ type: "resize-applied", seq: message.seq });
      }
    },
    deliver(payload: unknown) {
      socket.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify(payload) }),
      );
    },
  };
  queueMicrotask(() => {
    socket.readyState = 1;
    socket.onopen?.(new Event("open"));
    socket.deliver({ type: "features", resizeAcks: true });
    socket.deliver({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    timer = setInterval(() => {
      const data = btoa(
        `\u001b[32m${terminalId} stream ${sequence}\u001b[0m\r\n`,
      );
      socket.deliver({
        type: "output",
        chunk: { seq: sequence++, dataBase64: data },
      });
    }, 30);
  });
  return socket;
}

export function EightPaneStreaming() {
  useInsertionEffect(() => {
    const state: PerfState = {
      firstInteractiveMs: null,
      measurementStarted: false,
      panes: Object.fromEntries(paneIds.map((id) => [id, emptyMetric()])),
      result: null,
    };
    (window as PerfWindow).__p19TerminalPerf = state;
    restoreRendererInstrumentation = installRendererInstrumentation();
    originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "WebSocket",
    );
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: StreamingSocket,
    });
    return () => {
      restoreRendererInstrumentation?.();
      restoreRendererInstrumentation = null;
      if (originalWebSocketDescriptor === undefined) {
        Reflect.deleteProperty(window, "WebSocket");
      } else {
        Object.defineProperty(window, "WebSocket", originalWebSocketDescriptor);
      }
      originalWebSocketDescriptor = undefined;
      delete (window as PerfWindow).__p19TerminalPerf;
    };
  }, []);
  const params = new URLSearchParams(window.location.search);
  const hiddenPanes = new Set(
    params.get("visible") === "all" ? [] : paneIds.slice(4),
  );

  return (
    <main className="h-screen w-full overflow-auto bg-background p-2">
      <div
        data-p19-resize-probe=""
        className="grid grid-cols-4 gap-2"
        style={{ transition: "width 500ms linear", width: "100%" }}
      >
        {paneIds.map((id, index) => (
          <section
            key={id}
            data-p19-terminal={id}
            className="h-[230px] min-w-0 overflow-hidden border border-border"
            style={{ visibility: hiddenPanes.has(id) ? "hidden" : "visible" }}
          >
            <ThreadTerminalView
              autoFocus={index === 0}
              isPanelOpen
              session={sessionById.get(id)!}
            />
          </section>
        ))}
      </div>
      <output data-p19-ready="measuring">measuring</output>
    </main>
  );
}
