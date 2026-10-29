// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import type { UseThreadTimelineControllerResult } from "@/components/thread/timeline";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { CONTENT_MEASURE_MAX_WIDTH_CLASS } from "@/lib/content-measure";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ThreadScreen, type ThreadScreenPresentation } from "./ThreadScreen";
import type { ThreadResponse } from "@bb/server-contract";

const mocks = vi.hoisted(() => ({
  pendingInteractions: [] as PendingInteraction[] | undefined,
  pendingInteractionsIsError: false,
  pendingInteractionsIsFetching: false,
  pendingInteractionsRefetch: vi.fn(),
  pageShellProps: [] as Array<Record<string, unknown>>,
  promptAreaProps: [] as Array<Record<string, unknown>>,
  surfaceProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  isPendingInteractionStateUnknown: (
    interactions: readonly unknown[] | undefined,
    isFetching: boolean,
  ) => (interactions === undefined || interactions.length === 0) && isFetching,
  useChildThreads: () => ({ data: [] }),
  useThread: () => ({ data: undefined }),
  useThreadPendingInteractions: () => ({
    data: mocks.pendingInteractions,
    isError: mocks.pendingInteractionsIsError,
    isFetching: mocks.pendingInteractionsIsFetching,
    refetch: mocks.pendingInteractionsRefetch,
  }),
}));

vi.mock("@/hooks/queries/child-thread-pending-interactions", () => ({
  useChildThreadPendingAttention: () => [],
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => {
  const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });
  return {
    useCreateThreadQueuedMessage: mutation,
    useEditThreadMessage: mutation,
    useSendThreadMessage: mutation,
  };
});

vi.mock("@/components/thread/timeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/thread/timeline")>();
  return {
    ...actual,
    ThreadTimelineSurface: (props: Record<string, unknown>) => {
      mocks.surfaceProps.push(props);
      const addToChat = props.onSelectionAddToChat as
        | ((text: string) => void)
        | undefined;
      return (
        <button type="button" onClick={() => addToChat?.("Quoted line")}>
          Add selection to chat
        </button>
      );
    },
  };
});

vi.mock("@/components/ui/page-shell.js", () => ({
  PageShell: (props: {
    children?: ReactNode;
    footer?: ReactNode;
  }) => {
    mocks.pageShellProps.push(props as Record<string, unknown>);
    return (
      <div>
        {props.children}
        {props.footer}
      </div>
    );
  },
}));

vi.mock("./ThreadDetailPromptArea", () => ({
  ThreadDetailPromptArea: (props: Record<string, unknown>) => {
    mocks.promptAreaProps.push(props);
    return <div data-testid="prompt-area" />;
  },
}));

const THREAD = makeThreadResponse({
  id: "thr_screen",
  projectId: "proj_screen",
  status: "active",
  runtime: { displayStatus: "active" },
});

const TIMELINE = {
  activeBackgroundCommands: [],
  activePromptMode: null,
  activeThinking: null,
  activeWorkflows: [],
  contextBoundarySeq: null,
  contextWindowUsage: null,
  goal: null,
  hasOlderTimelineRows: false,
  isCatchingUpTimeline: false,
  isLoadingOlderTimelineRows: false,
  loadOlderTimelineRows: async () => {},
  modelFallback: null,
  pendingTodos: null,
  providerCommands: null,
  sessionOptions: null,
  timelineError: null,
  timelineLoading: false,
  timelineRows: [],
} as unknown as UseThreadTimelineControllerResult;

const SIDE_CHAT_PRESENTATION: ThreadScreenPresentation = {
  kind: "panel",
  layout: "contained",
  measure: "panel",
  tone: "sidebar",
};

function workflowRow(): TimelineWorkflowWorkRow {
  return {
    id: "thr-test:workflow:task:wf-open",
    threadId: "thr_screen",
    turnId: null,
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    kind: "work",
    status: "pending",
    workKind: "workflow",
    itemId: "task:wf-open",
    taskType: "local_workflow",
    workflowName: "fixture-mini",
    description: "fixture workflow",
    model: null,
    taskStatus: "running",
    workflow: null,
    usage: null,
    summary: null,
    error: null,
    completedAt: null,
  };
}

function renderScreen(
  presentation: ThreadScreenPresentation,
  overrides: {
    hasUnseenTimelineEvents?: boolean;
    thread?: ThreadResponse;
    timeline?: UseThreadTimelineControllerResult;
  } = {},
) {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  return render(
    <Wrapper>
      <ThreadScreen
        composer={{
          environmentCheckout: undefined,
          environmentChrome: undefined,
          contextEnvironmentId: null,
          permissionPolicy: "snapshot",
        }}
        environment={null}
        presentation={presentation}
        projectId={THREAD.projectId}
        resolveMentionLink={() => null}
        thread={overrides.thread ?? THREAD}
        timeline={overrides.timeline ?? TIMELINE}
        timelineHost={{
          environmentHostName: null,
          includePluginMessageActions: false,
          hasUnseenTimelineEvents: overrides.hasUnseenTimelineEvents ?? false,
          unreadDividerPlacement: null,
        }}
        workspaceRootPath={undefined}
      />
    </Wrapper>,
  );
}

function makePluginInteraction(): PendingInteraction {
  return {
    id: "int_plugin",
    threadId: THREAD.id,
    turnId: null,
    providerId: null,
    providerThreadId: null,
    providerRequestId: null,
    origin: { kind: "plugin", pluginId: "secrets" },
    payload: { kind: "plugin", pluginId: "secrets", type: "secret-request" },
    resolution: null,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  } as unknown as PendingInteraction;
}

beforeEach(() => {
  mocks.pendingInteractions = [];
  mocks.pendingInteractionsIsError = false;
  mocks.pendingInteractionsIsFetching = false;
  mocks.pendingInteractionsRefetch.mockClear();
  mocks.pageShellProps = [];
  mocks.promptAreaProps = [];
  mocks.surfaceProps = [];
});

afterEach(() => {
  cleanup();
  getPromptDraftAccessor({
    kind: "thread",
    projectId: THREAD.projectId,
    threadId: THREAD.id,
  }).setDraft({ text: "", mentions: [], attachments: [] });
});

describe("ThreadScreen", () => {
  it("hands a plugin-rendered interaction to an embedded chat's composer", () => {
    mocks.pendingInteractions = [makePluginInteraction()];
    renderScreen(SIDE_CHAT_PRESENTATION);

    const promptArea = mocks.promptAreaProps.at(-1)!;
    expect(promptArea.pendingInteractions).toEqual(mocks.pendingInteractions);
    expect(promptArea.isPrimaryComposer).toBe(false);
    expect(promptArea.permissionPolicy).toBe("snapshot");
    expect(mocks.surfaceProps.at(-1)!.showOngoingIndicator).toBe(false);
  });

  it("gates an embedded chat's composer while pending interactions are initially unknown", () => {
    mocks.pendingInteractions = undefined;
    mocks.pendingInteractionsIsFetching = true;
    renderScreen(SIDE_CHAT_PRESENTATION);

    const promptArea = mocks.promptAreaProps.at(-1)!;
    expect(promptArea.pendingInteractionsInitialLoading).toBe(true);
    expect(promptArea.pendingInteractionsGate).toEqual({ state: "loading" });
  });

  it("gates an embedded chat's composer while cached empty interactions refresh", () => {
    mocks.pendingInteractions = [];
    mocks.pendingInteractionsIsFetching = true;
    renderScreen(SIDE_CHAT_PRESENTATION);

    expect(mocks.promptAreaProps.at(-1)!.pendingInteractionsGate).toEqual({
      state: "loading",
    });
  });

  it("keeps an embedded chat's composer unavailable and retries when pending interactions fail to load", () => {
    mocks.pendingInteractions = undefined;
    mocks.pendingInteractionsIsError = true;
    renderScreen(SIDE_CHAT_PRESENTATION);

    const gate = mocks.promptAreaProps.at(-1)!.pendingInteractionsGate as {
      state: string;
      onRetry: () => void;
    };
    expect(gate.state).toBe("error");
    gate.onRetry();
    expect(mocks.pendingInteractionsRefetch).toHaveBeenCalledOnce();
  });

  it("does not gate the page composer on the pending-interactions refresh", () => {
    mocks.pendingInteractions = [];
    mocks.pendingInteractionsIsFetching = true;
    renderScreen({ kind: "page" });

    expect(mocks.promptAreaProps.at(-1)!.pendingInteractionsGate).toBeNull();
  });

  it("opens the page at the latest content when the thread has unseen events", () => {
    renderScreen({ kind: "page" }, { hasUnseenTimelineEvents: true });

    expect(mocks.pageShellProps.at(-1)!.scrollAnchorMode).toBe("latest");
  });

  it("restores the saved reading position when the thread has no unseen events", () => {
    renderScreen({ kind: "page" }, { hasUnseenTimelineEvents: false });

    expect(mocks.pageShellProps.at(-1)!.scrollAnchorMode).toBe("restore");
  });

  it("sizes a page-measure panel to the content measure and a panel-measure one to its container", () => {
    const view = renderScreen({
      kind: "panel",
      layout: "document",
      measure: "page",
      tone: "background",
    });
    const column = () =>
      screen.getByRole("button", { name: "Add selection to chat" })
        .parentElement!;

    expect(column().className).toContain(CONTENT_MEASURE_MAX_WIDTH_CLASS);
    expect(column().className).not.toContain("max-w-none");

    view.unmount();
    renderScreen({
      kind: "panel",
      layout: "document",
      measure: "panel",
      tone: "background",
    });

    expect(column().className).toContain("max-w-none");
    expect(column().className).not.toContain(CONTENT_MEASURE_MAX_WIDTH_CLASS);
  });

  it("quotes a timeline selection into the thread draft and focuses the composer", () => {
    renderScreen({ kind: "page" });
    const focusKeyBefore =
      mocks.promptAreaProps.at(-1)!.composerFocusRequestKey;

    fireEvent.click(
      screen.getByRole("button", { name: "Add selection to chat" }),
    );

    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId: THREAD.projectId,
      threadId: THREAD.id,
    }).getCurrent();
    expect(draft.text).toContain("Quoted line");
    expect(mocks.promptAreaProps.at(-1)!.composerFocusRequestKey).not.toBe(
      focusKeyBefore,
    );
  });
});

describe("ThreadScreen panel ongoing indicator", () => {
  function panelThread(overrides: Partial<ThreadResponse>): ThreadResponse {
    return makeThreadResponse({
      id: "thr_screen",
      projectId: "proj_screen",
      status: "idle",
      runtime: { displayStatus: "idle" },
      ...overrides,
    });
  }

  function indicator() {
    const props = mocks.surfaceProps.at(-1)!;
    return {
      label: props.ongoingIndicatorLabel,
      show: props.showOngoingIndicator,
    };
  }

  it.each([
    ["active", true],
    ["idle", false],
  ] as const)(
    "tells the timeline a %s panel thread's activity (%s)",
    (status, expected) => {
      renderScreen(SIDE_CHAT_PRESENTATION, {
        thread: panelThread({ status, runtime: { displayStatus: status } }),
      });

      expect(mocks.surfaceProps.at(-1)!.threadIsActive).toBe(expected);
    },
  );

  it("shows a background-only working indicator while runtime is idle", () => {
    renderScreen(SIDE_CHAT_PRESENTATION, {
      thread: panelThread({}),
      timeline: { ...TIMELINE, activeWorkflows: [workflowRow()] },
    });

    expect(indicator()).toEqual({
      label: "Background work running",
      show: true,
    });
  });

  it("keeps the normal working label while runtime is active", () => {
    renderScreen(SIDE_CHAT_PRESENTATION, {
      thread: panelThread({
        status: "active",
        runtime: { displayStatus: "active" },
      }),
      timeline: { ...TIMELINE, activeWorkflows: [workflowRow()] },
    });

    expect(indicator()).toEqual({ label: undefined, show: true });
  });

  it("shows a background indicator for an idle Claude thread with only a nested agent active", () => {
    renderScreen(SIDE_CHAT_PRESENTATION, {
      thread: panelThread({ activeBackgroundAgentCount: 1 }),
    });

    expect(indicator()).toEqual({
      label: "Background work running",
      show: true,
    });
  });

  it("hides the background indicator when the nested agent count returns to zero", () => {
    renderScreen(SIDE_CHAT_PRESENTATION, {
      thread: panelThread({ activeBackgroundAgentCount: 0 }),
    });

    expect(indicator()).toEqual({ label: undefined, show: false });
  });
});
