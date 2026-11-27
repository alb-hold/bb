// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingInteraction, ThreadListEntry } from "@bb/domain";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import type { UseThreadTimelineControllerResult } from "@/components/thread/timeline";
import type { ThreadTimelineEditMessageHandler } from "@/components/thread/timeline";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { CONTENT_MEASURE_MAX_WIDTH_CLASS } from "@/lib/content-measure";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { conversationRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import type { ThreadDetailSentMessageEdit } from "./ThreadDetailPromptArea";
import { ThreadScreen, type ThreadScreenPresentation } from "./ThreadScreen";
import { peekRetryOfClientRequestId } from "./restored-draft-retry";
import type { ThreadResponse } from "@bb/server-contract";

const mocks = vi.hoisted(() => ({
  children: [] as ThreadListEntry[],
  pendingInteractions: [] as PendingInteraction[] | undefined,
  pendingInteractionsIsError: false,
  pendingInteractionsIsFetching: false,
  pendingInteractionsRefetch: vi.fn(),
  pageShellProps: [] as Array<Record<string, unknown>>,
  promptAreaProps: [] as Array<Record<string, unknown>>,
  surfaceProps: [] as Array<Record<string, unknown>>,
  timeline: null as UseThreadTimelineControllerResult | null,
  toastWarning: vi.fn(),
  editMessageMutateAsync: vi.fn(),
}));

let activeScreenWrapper: ComponentType<{ children: ReactNode }> = ({
  children,
}) => <>{children}</>;

vi.mock("@/components/ui/app-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ui/app-toast")>();
  return {
    ...actual,
    appToast: { ...actual.appToast, warning: mocks.toastWarning },
  };
});

vi.mock("@/hooks/queries/thread-queries", () => ({
  isPendingInteractionStateUnknown: (
    interactions: readonly unknown[] | undefined,
    isFetching: boolean,
  ) => (interactions === undefined || interactions.length === 0) && isFetching,
  useChildThreads: () => ({ data: mocks.children }),
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
  return {
    useCreateThreadQueuedMessage: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useEditThreadMessage: () => ({
      mutateAsync: mocks.editMessageMutateAsync,
      isPending: false,
    }),
    useSendThreadMessage: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  };
});

vi.mock("@/components/thread/timeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/thread/timeline")>();
  return {
    ...actual,
    useThreadTimelineController: () => mocks.timeline,
    ThreadTimelineSurface: (props: Record<string, unknown>) => {
      mocks.surfaceProps.push(props);
      const addToChat = props.onSelectionAddToChat as
        ((text: string) => void) | undefined;
      return (
        <button type="button" onClick={() => addToChat?.("Quoted line")}>
          Add selection to chat
        </button>
      );
    },
  };
});

vi.mock("@/components/ui/page-shell.js", () => ({
  PageShell: (props: { children?: ReactNode; footer?: ReactNode }) => {
    mocks.pageShellProps.push(props as Record<string, unknown>);
    return (
      <div>
        {props.children}
        {props.footer}
      </div>
    );
  },
}));

vi.mock("./DeferredThreadDetailPromptArea", () => ({
  DeferredThreadDetailPromptArea: (props: Record<string, unknown>) => {
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

const TIMELINE: UseThreadTimelineControllerResult = {
  activeBackgroundCommands: [],
  activePromptMode: null,
  activeThinking: null,
  activeWorkflows: [],
  contextBoundarySeq: null,
  contextWindowUsage: undefined,
  goal: null,
  hasOlderTimelineRows: false,
  hasUnseenTimelineEvents: false,
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
};

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
  activeScreenWrapper = Wrapper;
  mocks.timeline = overrides.timeline ?? TIMELINE;
  return render(screenElement(presentation, overrides));
}

function screenElement(
  presentation: ThreadScreenPresentation,
  overrides: {
    hasUnseenTimelineEvents?: boolean;
    thread?: ThreadResponse;
    timeline?: UseThreadTimelineControllerResult;
  } = {},
) {
  const Wrapper = activeScreenWrapper;
  return (
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
        timelineEnabled={true}
        timelineHost={{
          environmentHostName: null,
          includePluginMessageActions: false,
          hasUnseenTimelineEvents: overrides.hasUnseenTimelineEvents ?? false,
          unreadDividerPlacement: null,
        }}
      />
    </Wrapper>
  );
}

function timelineWithRowIds(
  rowIds: readonly string[],
): UseThreadTimelineControllerResult {
  return {
    ...TIMELINE,
    timelineRows: rowIds.map((id) =>
      conversationRow({ id, role: "user", text: "/compact" }),
    ),
  };
}

function latestSentMessageEdit(): ThreadDetailSentMessageEdit | undefined {
  return mocks.promptAreaProps.at(-1)!.sentMessageEdit as
    ThreadDetailSentMessageEdit | undefined;
}

function startEditingMessage(messageId: string) {
  const onEditMessage = mocks.surfaceProps.at(-1)!
    .onEditMessage as ThreadTimelineEditMessageHandler;
  act(() => {
    onEditMessage({
      expectedRequestSequence: 1,
      input: [{ type: "text", text: "/compact", mentions: [] }],
      messageId,
      requestId: null,
      restoreToComposer: false,
    });
  });
}

function submitSentMessageEdit() {
  act(() => {
    latestSentMessageEdit()!.onSubmit({
      execution: null,
      input: [{ type: "text", text: "/compact keep it short", mentions: [] }],
    });
  });
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
  mocks.children = [];
  mocks.pendingInteractions = [];
  mocks.pendingInteractionsIsError = false;
  mocks.pendingInteractionsIsFetching = false;
  mocks.pendingInteractionsRefetch.mockClear();
  mocks.pageShellProps = [];
  mocks.promptAreaProps = [];
  mocks.surfaceProps = [];
  mocks.timeline = null;
  mocks.editMessageMutateAsync.mockReset();
  mocks.toastWarning.mockReset();
});

it("includes an idle signaled child in the parent banner", () => {
  mocks.children = [
    makeThreadListEntry({
      id: "child-signal",
      parentThreadId: THREAD.id,
      originKind: null,
      listIndicator: "check-terminal",
      hasPendingInteraction: false,
      status: "idle",
      runtime: { displayStatus: "idle" },
    }),
  ];
  renderScreen({ kind: "page" });
  expect(mocks.promptAreaProps.at(-1)!.childThreadsSection).toMatchObject({
    items: [
      {
        id: "child-signal",
        hasPendingInteraction: false,
        hasTerminalAttention: true,
      },
    ],
  });
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

  describe("undelivered messages", () => {
    function undeliveredTimeline(
      id: string,
    ): UseThreadTimelineControllerResult {
      return {
        ...TIMELINE,
        timelineRows: [
          conversationRow({
            id,
            role: "user",
            text: "never reached the provider",
            turnRequest: {
              requestId: null,
              isGrouped: false,
              kind: "message",
              status: "undelivered",
            },
          }),
        ],
      };
    }
    function threadDraft() {
      return getPromptDraftAccessor({
        kind: "thread",
        projectId: THREAD.projectId,
        threadId: THREAD.id,
      });
    }

    function userRowAt(id: string, status: "accepted" | "undelivered") {
      return conversationRow({
        id,
        role: "user",
        text: "never reached the provider",
        turnId: "turn_own",
        turnRequest: {
          isGrouped: false,
          requestId: `req_${id}`,
          kind: "message",
          status,
        },
      });
    }
    function timelineOf(
      ...rows: UseThreadTimelineControllerResult["timelineRows"]
    ): UseThreadTimelineControllerResult {
      return { ...TIMELINE, timelineRows: rows };
    }

    it("leaves an empty composer empty when opening a thread that already holds an undelivered row", () => {
      renderScreen(
        { kind: "page" },
        { timeline: undeliveredTimeline("undelivered_old") },
      );
      expect(threadDraft().getCurrent().text).toBe("");
    });

    it("fills an empty composer once when the latest message becomes undelivered while open", () => {
      const view = renderScreen(
        { kind: "page" },
        { timeline: timelineOf(userRowAt("live_row", "accepted")) },
      );
      expect(threadDraft().getCurrent().text).toBe("");
      mocks.timeline = timelineOf(userRowAt("live_row", "undelivered"));
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider",
      );
      threadDraft().setDraft({ text: "", mentions: [], attachments: [] });
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe("");
    });

    it("takes the restored draft back when a late echo clears the undelivered status", () => {
      const view = renderScreen(
        { kind: "page" },
        { timeline: timelineOf(userRowAt("late_echo_row", "accepted")) },
      );
      mocks.timeline = timelineOf(userRowAt("late_echo_row", "undelivered"));
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider",
      );
      mocks.timeline = timelineOf(userRowAt("late_echo_row", "accepted"));
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe("");
    });

    it("keeps an edited restored draft when a late echo clears the undelivered status", () => {
      const view = renderScreen(
        { kind: "page" },
        { timeline: timelineOf(userRowAt("edited_row", "accepted")) },
      );
      mocks.timeline = timelineOf(userRowAt("edited_row", "undelivered"));
      view.rerender(screenElement({ kind: "page" }));
      threadDraft().setDraft({
        text: "never reached the provider, edited",
        mentions: [],
        attachments: [],
      });
      mocks.timeline = timelineOf(userRowAt("edited_row", "accepted"));
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider, edited",
      );
    });

    it("fills an empty composer when the undelivered row is followed by its own turn row", () => {
      const view = renderScreen(
        { kind: "page" },
        {
          timeline: timelineOf(
            userRowAt("own_turn_row", "accepted"),
            turnRow({ turnId: "turn_own" }),
          ),
        },
      );
      mocks.timeline = timelineOf(
        userRowAt("own_turn_row", "undelivered"),
        turnRow({ turnId: "turn_own" }),
      );
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider",
      );
    });

    it("fills an empty composer when a new message arrives already undelivered", () => {
      const view = renderScreen(
        { kind: "page" },
        { timeline: timelineOf(userRowAt("loaded_row", "accepted")) },
      );
      mocks.timeline = timelineOf(
        userRowAt("loaded_row", "accepted"),
        userRowAt("arrived_row", "undelivered"),
      );
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider",
      );
    });

    it("fills an empty composer when the first message of an empty thread arrives undelivered", () => {
      const view = renderScreen({ kind: "page" }, { timeline: timelineOf() });
      mocks.timeline = timelineOf(userRowAt("first_row", "undelivered"));
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider",
      );
    });

    it("never auto-restores an undelivered row that a later turn follows", () => {
      const view = renderScreen(
        { kind: "page" },
        {
          timeline: timelineOf(
            userRowAt("older_row", "accepted"),
            turnRow({ turnId: "turn_later" }),
          ),
        },
      );
      mocks.timeline = timelineOf(
        userRowAt("older_row", "undelivered"),
        turnRow({ turnId: "turn_later" }),
      );
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe("");
    });

    it("leaves a draft the user is typing alone", () => {
      threadDraft().setDraft({
        text: "already typing",
        mentions: [],
        attachments: [],
      });
      renderScreen(
        { kind: "page" },
        { timeline: undeliveredTimeline("undelivered_typing") },
      );
      expect(threadDraft().getCurrent().text).toBe("already typing");
    });

    it("restores an undelivered message in front of the current draft", () => {
      threadDraft().setDraft({
        text: "already typing",
        mentions: [],
        attachments: [],
      });
      renderScreen(
        { kind: "page" },
        { timeline: undeliveredTimeline("undelivered_restore") },
      );
      const onEditMessage = mocks.surfaceProps.at(-1)!
        .onEditMessage as ThreadTimelineEditMessageHandler;
      act(() => {
        onEditMessage({
          expectedRequestSequence: 1,
          input: [
            { type: "text", text: "never reached the provider", mentions: [] },
          ],
          messageId: "undelivered_restore",
          requestId: "req_original",
          restoreToComposer: true,
        });
      });
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider\n\nalready typing",
      );
    });

    it("takes a manually restored draft back when a late echo clears the undelivered status", () => {
      threadDraft().setDraft({
        text: "already typing",
        mentions: [],
        attachments: [],
      });
      const view = renderScreen(
        { kind: "page" },
        { timeline: undeliveredTimeline("manual_restore_row") },
      );
      const onEditMessage = mocks.surfaceProps.at(-1)!
        .onEditMessage as ThreadTimelineEditMessageHandler;
      act(() => {
        onEditMessage({
          expectedRequestSequence: 1,
          input: [
            { type: "text", text: "never reached the provider", mentions: [] },
          ],
          messageId: "manual_restore_row",
          requestId: "req_original",
          restoreToComposer: true,
        });
      });
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider\n\nalready typing",
      );
      mocks.timeline = timelineOf(userRowAt("manual_restore_row", "accepted"));
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe("already typing");
    });

    it("keeps an edited manually restored draft when a late echo clears the undelivered status", () => {
      const view = renderScreen(
        { kind: "page" },
        { timeline: undeliveredTimeline("manual_edited_row") },
      );
      const onEditMessage = mocks.surfaceProps.at(-1)!
        .onEditMessage as ThreadTimelineEditMessageHandler;
      act(() => {
        onEditMessage({
          expectedRequestSequence: 1,
          input: [
            { type: "text", text: "never reached the provider", mentions: [] },
          ],
          messageId: "manual_edited_row",
          requestId: "req_original",
          restoreToComposer: true,
        });
      });
      threadDraft().setDraft({
        text: "never reached the provider, edited",
        mentions: [],
        attachments: [],
      });
      mocks.timeline = timelineOf(userRowAt("manual_edited_row", "accepted"));
      view.rerender(screenElement({ kind: "page" }));
      expect(threadDraft().getCurrent().text).toBe(
        "never reached the provider, edited",
      );
    });
  });

  describe("retry of a restored message", () => {
    function threadDraft() {
      return getPromptDraftAccessor({
        kind: "thread",
        projectId: THREAD.projectId,
        threadId: THREAD.id,
      });
    }

    function restoreManually(rowId: string, requestId: string | null) {
      const view = renderScreen(
        { kind: "page" },
        {
          timeline: {
            ...TIMELINE,
            timelineRows: [
              conversationRow({
                id: rowId,
                role: "user",
                text: "never reached the provider",
                turnId: "turn_own",
                turnRequest: {
                  isGrouped: false,
                  requestId,
                  kind: "message",
                  status: "undelivered",
                },
              }),
            ],
          },
        },
      );
      const onEditMessage = mocks.surfaceProps.at(-1)!
        .onEditMessage as ThreadTimelineEditMessageHandler;
      act(() => {
        onEditMessage({
          expectedRequestSequence: 1,
          input: [
            { type: "text", text: "never reached the provider", mentions: [] },
          ],
          messageId: rowId,
          requestId,
          restoreToComposer: true,
        });
      });
      return view;
    }

    it("names the original request when the restored draft is sent unedited", () => {
      threadDraft().setDraft({ text: "", mentions: [], attachments: [] });
      restoreManually("retry_unedited_row", "req_original");
      expect(
        peekRetryOfClientRequestId(THREAD.id, threadDraft().getCurrent()),
      ).toBe("req_original");
    });

    it("names no request when the restored draft was edited before sending", () => {
      threadDraft().setDraft({ text: "", mentions: [], attachments: [] });
      restoreManually("retry_edited_row", "req_original");
      threadDraft().setDraft({
        text: "never reached the provider, edited",
        mentions: [],
        attachments: [],
      });
      expect(
        peekRetryOfClientRequestId(THREAD.id, threadDraft().getCurrent()),
      ).toBeNull();
    });

    it("names the original request when the auto-restored draft is sent unedited", () => {
      threadDraft().setDraft({ text: "", mentions: [], attachments: [] });
      const view = renderScreen(
        { kind: "page" },
        {
          timeline: {
            ...TIMELINE,
            timelineRows: [
              conversationRow({
                id: "auto_retry_row",
                role: "user",
                text: "never reached the provider",
                turnId: "turn_own",
                turnRequest: {
                  isGrouped: false,
                  requestId: "req_auto",
                  kind: "message",
                  status: "accepted",
                },
              }),
            ],
          },
        },
      );
      mocks.timeline = {
        ...TIMELINE,
        timelineRows: [
          conversationRow({
            id: "auto_retry_row",
            role: "user",
            text: "never reached the provider",
            turnId: "turn_own",
            turnRequest: {
              isGrouped: false,
              requestId: "req_auto",
              kind: "message",
              status: "undelivered",
            },
          }),
        ],
      };
      view.rerender(screenElement({ kind: "page" }));
      expect(
        peekRetryOfClientRequestId(THREAD.id, threadDraft().getCurrent()),
      ).toBe("req_auto");
    });

    it("forgets the request once the late echo clears the undelivered status", () => {
      threadDraft().setDraft({ text: "", mentions: [], attachments: [] });
      const view = restoreManually("retry_echo_row", "req_original");
      mocks.timeline = {
        ...TIMELINE,
        timelineRows: [
          conversationRow({
            id: "retry_echo_row",
            role: "user",
            text: "never reached the provider",
            turnId: "turn_own",
            turnRequest: {
              isGrouped: false,
              requestId: "req_original",
              kind: "message",
              status: "accepted",
            },
          }),
        ],
      };
      view.rerender(screenElement({ kind: "page" }));
      expect(
        peekRetryOfClientRequestId(THREAD.id, threadDraft().getCurrent()),
      ).toBeNull();
    });
  });

  it("keeps a submitted edit quiet when its own rewrite removes the edited message first", async () => {
    let resolveEdit!: () => void;
    mocks.editMessageMutateAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveEdit = resolve;
      }),
    );
    const view = renderScreen(
      { kind: "page" },
      { timeline: timelineWithRowIds(["msg_1"]) },
    );
    startEditingMessage("msg_1");
    submitSentMessageEdit();

    mocks.timeline = timelineWithRowIds(["msg_2"]);
    view.rerender(screenElement({ kind: "page" }));
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(latestSentMessageEdit()).toBeDefined();

    await act(async () => {
      resolveEdit();
    });
    expect(latestSentMessageEdit()).toBeUndefined();
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });

  it("discards an unsubmitted edit whose message leaves the timeline", () => {
    const view = renderScreen(
      { kind: "page" },
      { timeline: timelineWithRowIds(["msg_1"]) },
    );
    startEditingMessage("msg_1");

    mocks.timeline = timelineWithRowIds(["msg_2"]);
    view.rerender(screenElement({ kind: "page" }));

    expect(mocks.toastWarning).toHaveBeenCalledWith(
      "The message being edited is no longer available.",
    );
    expect(latestSentMessageEdit()).toBeUndefined();
  });

  it("discards a failed edit whose message left the timeline while it was submitting", async () => {
    let rejectEdit!: (error: Error) => void;
    mocks.editMessageMutateAsync.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectEdit = reject;
      }),
    );
    const view = renderScreen(
      { kind: "page" },
      { timeline: timelineWithRowIds(["msg_1"]) },
    );
    startEditingMessage("msg_1");
    submitSentMessageEdit();
    mocks.timeline = timelineWithRowIds(["msg_2"]);
    view.rerender(screenElement({ kind: "page" }));
    expect(mocks.toastWarning).not.toHaveBeenCalled();

    await act(async () => {
      rejectEdit(new Error("edit failed"));
    });

    expect(mocks.toastWarning).toHaveBeenCalledWith(
      "The message being edited is no longer available.",
    );
    expect(latestSentMessageEdit()).toBeUndefined();
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

it("keeps the first phone disclosure hit area below the header", () => {
  renderScreen({ kind: "page" });
  const shell = mocks.pageShellProps.at(-1)!;
  expect(shell.scrollAreaClassName).toContain(
    "max-md:pointer-coarse:scroll-pt-7",
  );
  expect(shell.contentClassName).toContain("max-md:pointer-coarse:pt-7");
});
