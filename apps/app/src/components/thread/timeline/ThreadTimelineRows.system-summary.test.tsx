// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import {
  threadCommandFailureCopyForInterruption,
  threadScope,
} from "@bb/domain";
import { buildThreadTimelineFromEvents } from "@bb/thread-view";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { systemRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import { installFakeFlowLayout } from "@/test/fake-flow-layout";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import {
  buildTimelineRowsListItems,
  ThreadTimelineRows,
} from "./ThreadTimelineRows";

function rowTree(row: TimelineRow, queryClient = new QueryClient()) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ThreadTimelineRows
          threadIsActive={false}
          timelineRows={[row]}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderRow(row: TimelineRow) {
  return render(rowTree(row));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function measureSummary(height: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("line-clamp-2") ? height : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("line-clamp-2") ? 40 : 0;
    },
  );
}

const summary =
  "This session was recorded with model `gpt-6-astra` but is resuming with `gpt-5.6-luna`. Consider switching back to `gpt-6-astra` as it may affect Codex performance.";

function serverProducedInterruptionRows(count: number): TimelineRow[] {
  const events = Array.from({ length: count }, (_, index) => {
    const copy = threadCommandFailureCopyForInterruption(
      index % 2 === 0 ? "host-connection-lost" : "host-daemon-restarted",
    );
    if (copy === null) throw new Error("Expected an interruption error");
    const seq = index + 1;
    return {
      event: {
        type: "system/error" as const,
        threadId: "thr_main",
        scope: threadScope(),
        code: "thread_command_failed",
        message: copy.message,
        detail: copy.detail,
      },
      meta: { id: `event-${seq}`, seq, createdAt: seq },
    };
  });
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents: [],
    },
    contextWindowEvents: [],
    events,
    options: {
      completedTurnDisplay: "collapse",
      includeNestedRows: true,
      includeDiagnosticOperations: false,
      isLatestPage: true,
      summarizeShellCommands: true,
      threadStatus: "idle",
      threadName: "",
      workspaceRoot: null,
    },
  }).rows;
}

function preview() {
  const title = screen.getByTitle((title) => title.startsWith(summary));
  expect(title.classList.contains("whitespace-pre-wrap")).toBe(true);
  return title.parentElement;
}

describe("system summary overflow", () => {
  it("groups consecutive thread interruptions and expands their individual entries", () => {
    const interruptionRows = serverProducedInterruptionRows(12);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={interruptionRows}
            threadIsActive={false}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const groupButton = screen.getByRole("button", {
      name: "12 interruptions, show details",
    });
    expect(groupButton.getAttribute("aria-expanded")).toBe("false");
    expect(interruptionRows).toHaveLength(12);
    expect(screen.queryByText(/Thread interrupted because/)).toBeNull();
    fireEvent.click(groupButton);
    expect(groupButton.getAttribute("aria-expanded")).toBe("true");
    const expandedReasons = screen.getAllByText(/Thread interrupted because/);
    expect(expandedReasons).toHaveLength(12);
  });

  it("groups interruptions separated by their own interrupted turn summaries", () => {
    const [first, second, third] = serverProducedInterruptionRows(3);
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Expected three server-produced interruption rows");
    }
    const rows: TimelineRow[] = [
      { ...first, sourceSeqStart: 1, sourceSeqEnd: 1 },
      turnRow({
        id: "interrupted-turn-two",
        threadId: "thr_main",
        turnId: "turn-two",
        status: "interrupted",
        seq: 2,
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        startedAt: 2,
        createdAt: 2,
      }),
      {
        ...second,
        turnId: "turn-two",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
      },
      turnRow({
        id: "interrupted-turn-three",
        threadId: "thr_main",
        turnId: "turn-three",
        status: "interrupted",
        seq: 4,
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        startedAt: 4,
        createdAt: 4,
      }),
      {
        ...third,
        turnId: "turn-three",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
      },
    ];
    const [item] = buildTimelineRowsListItems({
      rows,
      scopeActive: false,
      threadIsActive: false,
      excludedInterruptionRowIds: new Set(),
      unreadDividerPlacement: null,
    });

    expect(item?.kind).toBe("interruption-group");
    if (item?.kind !== "interruption-group") return;
    expect(item.interruptionCount).toBe(3);
    expect(item.rows.filter((row) => row.kind === "turn")).toHaveLength(2);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={rows}
            threadIsActive={false}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("3 interruptions")).toBeTruthy();
  });

  it("hides retry instructions after a later turn or while the thread is active", () => {
    const interruption = systemRow({
      id: "interruption",
      threadId: "thr_main",
      systemKind: "error",
      title: "Thread interrupted because the host daemon disconnected",
      detail: "Please retry the thread to continue.",
      status: "error",
      seq: 1,
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      startedAt: 1,
      createdAt: 1,
    });
    const laterTurn = systemRow({
      id: "later-turn",
      threadId: "thr_main",
      systemKind: "error",
      title: "Later turn event",
      detail: null,
      status: "error",
      seq: 2,
      sourceSeqStart: 2,
      sourceSeqEnd: 2,
      startedAt: 2,
      createdAt: 2,
      turnId: "turn-later",
    });
    const displayedDetail = (rows: TimelineRow[], threadIsActive = false) => {
      const firstItem = buildTimelineRowsListItems({
        rows,
        scopeActive: false,
        threadIsActive,
        excludedInterruptionRowIds: new Set(),
        unreadDividerPlacement: null,
      })[0];
      return firstItem?.kind === "row" && firstItem.row.kind === "system"
        ? firstItem.row.detail
        : null;
    };

    expect(displayedDetail([interruption])).toBe(
      "Please retry the thread to continue.",
    );
    expect(displayedDetail([interruption, laterTurn])).toBeNull();
    expect(displayedDetail([interruption], true)).toBeNull();
    expect(interruption.detail).toBe("Please retry the thread to continue.");
  });

  it("links a thread title through the target thread's project", () => {
    const targetThread = makeThreadListEntry({
      id: "thr_target",
      projectId: "proj_target",
      title: "Target thread",
      titleFallback: "Target thread",
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map([[targetThread.id, targetThread]])}
          >
            <ThreadTimelineRows
              projectId="proj_current"
              threadIsActive={false}
              timelineRows={[
                systemRow({
                  threadId: "thr_current",
                  title: "Worker assigned to Target thread",
                  detail: null,
                  operationKind: "parent-change",
                  parentChange: {
                    action: "assign",
                    previousParentThreadId: null,
                    previousParentThreadTitle: null,
                    nextParentThreadId: targetThread.id,
                    nextParentThreadTitle: targetThread.title,
                  },
                }),
              ]}
              threadRuntimeDisplayStatus="idle"
              workspaceRootPath={undefined}
            />
          </ThreadTitleMentionResourcesProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("link", { name: "Target thread" }).getAttribute("href"),
    ).toBe("/projects/proj_target/threads/thr_target");
  });

  it.each([20, 40])(
    "shows a fitting %ipx summary without a toggle",
    (height) => {
      measureSummary(height);
      renderRow(
        systemRow({ operationKind: "warning", title: summary, detail: null }),
      );
      expect(preview()?.classList.contains("line-clamp-2")).toBe(true);
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it.each([
    systemRow({ operationKind: "warning", title: summary, detail: null }),
    systemRow({ operationKind: "deprecation", title: summary, detail: "   " }),
    systemRow({
      systemKind: "error",
      title: summary,
      status: "error",
      detail: null,
    }),
    systemRow({ systemKind: "reconnect", title: summary, detail: null }),
    systemRow({ systemKind: "debug", title: summary, detail: null }),
  ])("expands an overflowing $systemKind / $operationKind summary", (row) => {
    measureSummary(60);
    renderRow(row);
    expect(preview()?.classList.contains("line-clamp-2")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(preview()?.classList.contains("line-clamp-2")).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Show less" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(preview()?.classList.contains("line-clamp-2")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Show more" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("preserves auto-expanded terminal error diagnostics", () => {
    const detail = "Error: connection failed\n    at reconnect (client.ts:42)";
    renderRow(
      systemRow({
        systemKind: "error",
        title: "Provider error",
        status: "error",
        detail,
      }),
    );
    expect(screen.getByText(/at reconnect/).textContent).toContain(detail);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

describe("pending system detail scrolling", () => {
  const LINE_HEIGHT = 100;
  const DETAIL_HEIGHT = 100;

  it("keeps an expanded pending detail at its end while it streams, holds a reader who scrolled up, and follows again once they reach the new end", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
      ],
    });
    const layout = installFakeFlowLayout({
      heightOf: (element) =>
        element.tagName === "PRE"
          ? (element.textContent ?? "").split("\n").length * LINE_HEIGHT
          : null,
      scrollElement: () =>
        document.querySelector<HTMLElement>("[data-detail-scroll-area]"),
      viewportHeight: DETAIL_HEIGHT,
    });
    try {
      const pendingRow = (lineCount: number) =>
        systemRow({
          detail: Array.from(
            { length: lineCount },
            (_, index) => `line ${index + 1}`,
          ).join("\n"),
          status: "pending",
        });
      const settle = async () => {
        await act(async () => {
          layout.flushResizeObservers();
          await vi.advanceTimersByTimeAsync(50);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_000);
          layout.flushResizeObservers();
        });
      };
      const queryClient = new QueryClient();
      const view = render(rowTree(pendingRow(10), queryClient));
      const stream = async (lineCount: number) => {
        view.rerender(rowTree(pendingRow(lineCount), queryClient));
        await settle();
      };

      fireEvent.click(
        screen.getByRole("button", { name: /Provisioned thread/u }),
      );
      await settle();
      expect(layout.maxScrollTop()).toBe(900);
      expect(layout.scrollTop).toBe(900);

      act(() => layout.layoutScrollTo(500));
      await stream(11);
      expect(layout.scrollTop).toBe(1_000);

      act(() => layout.userScrollTo(500));
      await settle();
      await stream(12);
      expect(layout.maxScrollTop()).toBe(1_100);
      expect(layout.scrollTop).toBe(500);

      act(() => layout.userScrollTo(1_000));
      await settle();
      await stream(13);
      expect(layout.scrollTop).toBe(1_000);

      act(() => layout.userScrollTo(1_200));
      await settle();
      await stream(14);
      expect(layout.scrollTop).toBe(1_300);
    } finally {
      layout.restore();
      vi.useRealTimers();
    }
  });
});
