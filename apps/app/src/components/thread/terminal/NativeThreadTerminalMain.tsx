import { effectiveDisplayStatus } from "@bb/domain";
import { useQuery } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { threadDefaultExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { isRunningThreadRuntimeDisplayStatus } from "@bb/client-core";
import { Button } from "@bb/shared-ui/button";
import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import type { NativeTerminalThread } from "@bb/server-contract";
import type { ThreadRuntimeState } from "@bb/domain";
import { createPortal } from "react-dom";
import { NativeTerminalPanel } from "./NativeTerminalPanel";
import { CopyButton } from "@/components/ui/copy-button";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import {
  useNativeTerminalThread,
  useOpenNativeTerminal,
} from "@/hooks/queries/native-terminal-queries";
import { useThreadPendingInteractions } from "@/hooks/queries/thread-queries";
import { useThreadTerminals } from "@/hooks/queries/thread-terminal-queries";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { formatModelLabel } from "@/hooks/thread-creation-options/selection-state";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";
import { NativeActivityNotice } from "./NativeActivityNotice";
import { NativeTerminalActivity } from "./NativeComposerStatus";
import { NativeThreadMirrorSection } from "./NativeThreadMirrorSection";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";
import { useNativeActivityNotice } from "@/hooks/useNativeActivityUnconfirmed";
import {
  NativeTerminalWaitingBanner,
  nativeTerminalWaitingPrompts,
} from "./NativeTerminalWaitingBanner";
import {
  resolveNativeTerminalSession,
  resolveNativeTerminalState,
} from "./native-terminal-state";

interface NativeThreadTerminalMainProps {
  activityTarget?: HTMLElement | null;
  onOpenLink?: MarkdownPreviewLinkHandler;
  projectId: string;
  runtime: ThreadRuntimeState;
  threadId: string;
  threadIsArchived?: boolean;
  threadIsProvisioning: boolean;
  view: NativeTerminalThread;
}

function SessionIdentity({ id }: { id: string }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1 text-muted-foreground">
      <span className="truncate font-mono" title={id}>Session {id}</span>
      <CopyButton text={id} label="Copy session ID" />
    </div>
  );
}

export function NativeThreadTerminalMain({
  activityTarget = null,
  onOpenLink,
  projectId,
  runtime,
  threadId,
  threadIsArchived = false,
  threadIsProvisioning,
  view,
}: NativeThreadTerminalMainProps) {
  const profile = useQuery({
    queryKey: [
      ...threadDefaultExecutionOptionsQueryKey(threadId),
      "provider-report",
    ],
    queryFn: ({ signal }) => sdk.threads.executionProfile({ threadId, signal }),
    staleTime: 30_000,
  }).data;
  const report = profile?.executed;
  const modelLabel = view.model ? formatModelLabel(view.model) : undefined;
  const formatExecution = (metadata: typeof report) =>
    [
      metadata?.model ? formatModelLabel(metadata.model) : null,
      metadata?.reasoningLevel
        ? reasoningLevelLabel(metadata.reasoningLevel, undefined)
        : null,
      PERMISSION_MODE_OPTIONS.find(
        (option) => option.value === metadata?.permissionMode,
      )?.label,
    ]
      .filter(Boolean)
      .join(" · ");
  const executionLabel = [
    report && formatExecution(report)
      ? `Last reported: ${formatExecution(report)}`
      : null,
    profile?.nextTurn && formatExecution(profile.nextTurn)
      ? `Default: ${formatExecution(profile.nextTurn)}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  const activityNotice = useNativeActivityNotice(runtime);
  const terminalsQuery = useThreadTerminals(threadId);
  const interactionsQuery = useThreadPendingInteractions(threadId);
  const nativeQuery = useNativeTerminalThread(threadId);
  const openNative = useOpenNativeTerminal();
  const session = resolveNativeTerminalSession({
    listedSessions: terminalsQuery.data?.sessions,
    listUpdatedAt: terminalsQuery.dataUpdatedAt,
    view,
    viewUpdatedAt: nativeQuery.dataUpdatedAt,
  });
  const paneIsFocused = useOptionalPaneContext()?.isFocused ?? true;
  const idleTerminalId =
    session?.closeReason === "native-idle-reaped" ? session.id : undefined;
  const [resumedTerminalId, setResumedTerminalId] = useState<string>();
  const resumeAttempt = useRef<string>(undefined);
  const resumeOnAttach =
    paneIsFocused &&
    !threadIsArchived &&
    idleTerminalId !== undefined &&
    resumedTerminalId !== idleTerminalId;
  const { mutate: open } = openNative;
  useEffect(() => {
    if (!resumeOnAttach || resumeAttempt.current === idleTerminalId) return;
    resumeAttempt.current = idleTerminalId;
    open(
      { threadId },
      { onSettled: () => setResumedTerminalId(idleTerminalId) },
    );
  }, [idleTerminalId, open, resumeOnAttach, threadId]);
  const [prevProvisioning, setPrevProvisioning] = useState(threadIsProvisioning);
  const [
    awaitingTerminalAfterProvisioning,
    setAwaitingTerminalAfterProvisioning,
  ] = useState(false);
  if (prevProvisioning !== threadIsProvisioning) {
    setPrevProvisioning(threadIsProvisioning);
    if (prevProvisioning && !threadIsProvisioning && session === null) {
      setAwaitingTerminalAfterProvisioning(true);
    } else if (threadIsProvisioning) {
      setAwaitingTerminalAfterProvisioning(false);
    }
  }
  if (awaitingTerminalAfterProvisioning && session !== null) {
    setAwaitingTerminalAfterProvisioning(false);
  }
  const state = resolveNativeTerminalState({
    session:
      idleTerminalId !== undefined && (resumeOnAttach || openNative.isPending)
        ? null
        : session,
    terminalIsStarting:
      Boolean(view.starting) ||
      resumeOnAttach ||
      openNative.isPending ||
      awaitingTerminalAfterProvisioning,
    threadIsProvisioning,
    threadIsRunning: isRunningThreadRuntimeDisplayStatus(runtime.displayStatus),
  });
  const providerLabel = view.displayName;
  const setupWaiting = runtime.nativeSetupWaiting === true;
  const effectiveStatus = effectiveDisplayStatus(
    { status: runtime.displayStatus },
    runtime,
  );
  const waitingPrompts = nativeTerminalWaitingPrompts(
    interactionsQuery.data ?? [],
  );
  const prompt = view.prompt ?? null;
  const reply = view.reply ?? null;
  const hasTerminalOutput = Boolean(
    view.hasOutput || session?.firstLiveFrame !== undefined || reply !== null,
  );
  const isTouchDevice = useMediaQuery("(pointer: coarse)");
  const { refetch } = nativeQuery;
  const terminalsUpdatedAt = terminalsQuery.dataUpdatedAt;
  const [composerEngaged, setComposerEngaged] = useState(false);
  if (!paneIsFocused && composerEngaged) setComposerEngaged(false);
  const isComposerEngaged = paneIsFocused && composerEngaged;
  const onFocusWithin = (event: FocusEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest("form[data-native-terminal-prompt]") !== null
    ) {
      setComposerEngaged(true);
    }
  };

  useEffect(() => {
    if (!awaitingTerminalAfterProvisioning) return;
    let active = true;
    void Promise.resolve(refetch()).finally(() => {
      if (active) setAwaitingTerminalAfterProvisioning(false);
    });
    return () => {
      active = false;
    };
  }, [awaitingTerminalAfterProvisioning, refetch]);

  useEffect(() => {
    if (state.kind === "live") return;
    void refetch();
  }, [refetch, state.kind, terminalsUpdatedAt]);

  const headerActivity = activityTarget
    ? createPortal(
        <NativeTerminalActivity
          error={effectiveStatus === "error"}
          exited={state.kind === "ended"}
          indicator={
            interactionsQuery.data?.some(
              (interaction) => interaction.status === "pending",
            )
              ? "needs-input"
              : session?.status === "running" && session.attention
                ? "check-terminal"
                : isRunningThreadRuntimeDisplayStatus(runtime.displayStatus)
                  ? activityNotice.unconfirmed
                    ? "activity-unreported"
                    : "working"
                  : setupWaiting
                    ? "needs-input"
                    : "none"
          }
        />,
        activityTarget,
      )
    : null;

  if (state.kind === "live") {
    return (
      <div
        className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
        data-native-terminal-thread={view.providerId}
        data-no-sidebar-swipe=""
        onFocus={onFocusWithin}
      >
        {setupWaiting &&
        waitingPrompts.length === 0 &&
        !activityNotice.unconfirmed ? (
          <div
            role="status"
            className="flex shrink-0 items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground"
          >
            {`${providerLabel} hasn't started a session yet`}
          </div>
        ) : null}
        <NativeTerminalWaitingBanner
          prompts={waitingPrompts}
          providerLabel={providerLabel}
        />
        <NativeActivityNotice
          hostId={view.terminal?.hostId ?? null}
          notice={activityNotice}
          pendingPromptCount={waitingPrompts.length}
          threadId={threadId}
        />
        {headerActivity}
        {!hasTerminalOutput ? (
          <NativeThreadMirrorSection
            prompt={prompt}
            reply={reply}
            starting
          />
        ) : null}
        <NativeTerminalPanel
          initialSession={session ?? undefined}
          attentionShownAsBanner
          starting={!hasTerminalOutput}
          autoFocus={paneIsFocused && !isTouchDevice && !isComposerEngaged}
          isPanelOpen
          isPanelPersistedOpen
          onOpenLink={onOpenLink}
          onCloseStart={() => {}}
          onRetryStart={() => {}}
          target={{ kind: "thread", threadId }}
          terminalId={state.terminalId}
        />
        <NativeTerminalPromptBar
          projectId={projectId}
          modelLabel={modelLabel}
          executionLabel={executionLabel || undefined}
          providerLabel={providerLabel}
          threadId={threadId}
        />
      </div>
    );
  }

  if (state.kind === "preparing" || state.kind === "reconnecting") {
    const isPreparing = state.kind === "preparing";
    const label = isPreparing
      ? "Starting terminal…"
      : `Reconnecting to ${providerLabel}…`;
    if (prompt !== null || reply !== null) {
      return (
        <div
          className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
          data-native-terminal-thread={view.providerId}
        >
          <NativeThreadMirrorSection
            prompt={prompt}
            reply={reply}
            starting={isPreparing}
          />
          {isPreparing ? null : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {label}
            </div>
          )}
        </div>
      );
    }
    return (
      <div
        className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
        data-native-terminal-thread={view.providerId}
        data-native-terminal-starting={isPreparing ? "" : undefined}
        role="status"
      >
        {label}
      </div>
    );
  }

  if (session === null && terminalsQuery.isLoading) {
    return (
      <div
        aria-busy="true"
        className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
        data-native-terminal-thread={view.providerId}
        role="status"
      >
        Loading terminals...
      </div>
    );
  }

  const historyExpired =
    !terminalsQuery.isLoading &&
    !terminalsQuery.isFetching &&
    !terminalsQuery.isError &&
    terminalsQuery.data !== undefined &&
    terminalsQuery.dataUpdatedAt >= nativeQuery.dataUpdatedAt &&
    (session?.status === "exited" || view.nativeSessionId !== null) &&
    !terminalsQuery.data.sessions.some(
      (terminal) => terminal.id === session?.id,
    );
  const endedLabel =
    runtime.nativeSessionExit === "clean"
      ? "Resume to continue"
      : `${providerLabel} session ended`;

  if (session?.status === "exited" && !historyExpired) {
    return (
      <div
        className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
        data-native-terminal-thread={view.providerId}
        data-no-sidebar-swipe=""
      >
        {headerActivity}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border-seam px-3 py-2 text-sm">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
            <span className="font-medium">
              {endedLabel}
              {state.exitCode !== null
                ? ` (exit ${state.exitCode})`
                : ""}
            </span>
            {session.closeReason && session.closeReason !== "process-exit" ? (
              <span className="text-muted-foreground">{session.closeReason.replaceAll("-", " ")}</span>
            ) : null}
            {view.nativeSessionId === null ? null : (
              <SessionIdentity id={view.nativeSessionId} />
            )}
          </div>
          <Button
            disabled={openNative.isPending}
            onClick={() => openNative.mutate({ threadId })}
          >
            {view.nativeSessionId === null ? "Start session" : "Resume session"}
          </Button>
        </div>
        <NativeThreadMirrorSection
          prompt={prompt}
          reply={reply}
          starting={false}
        />
        <div className="min-h-0 flex-1">
          <NativeTerminalPanel
            initialSession={session ?? undefined}
            attentionShownAsBanner
            retainNativeOutput
            autoFocus={false}
            isPanelOpen
            isPanelPersistedOpen
            onOpenLink={onOpenLink}
            onCloseStart={() => {}}
            onRetryStart={() => openNative.mutate({ threadId })}
            target={{ kind: "thread", threadId }}
            terminalId={session.id}
          />
        </div>
      </div>
    );
  }

  if (prompt !== null || reply !== null) {
    return (
      <div
        className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
        data-native-terminal-thread={view.providerId}
      >
        {headerActivity}
        <NativeThreadMirrorSection
          prompt={prompt}
          reply={reply}
          starting={false}
        />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-sm">
          <p className="font-medium text-foreground">
            {endedLabel}
            {state.exitCode !== null ? ` (exit ${state.exitCode})` : ""}
          </p>
          {historyExpired ? (
            <p className="text-muted-foreground">
              Terminal history expired. Resume to continue.
            </p>
          ) : null}
          {view.nativeSessionId === null ? null : (
            <SessionIdentity id={view.nativeSessionId} />
          )}
          <Button
            disabled={openNative.isPending}
            onClick={() => {
              openNative.mutate({ threadId });
            }}
          >
            {view.nativeSessionId === null ? "Start session" : "Resume session"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm"
      data-native-terminal-thread={view.providerId}
    >
      {headerActivity}
      <p className="font-medium text-foreground">
        {endedLabel}
        {state.exitCode !== null
          ? ` (exit ${state.exitCode})`
          : ""}
      </p>
      {historyExpired ? (
        <p className="text-muted-foreground">
          Terminal history expired. Resume to continue.
        </p>
      ) : null}
      {view.nativeSessionId === null ? null : (
        <SessionIdentity id={view.nativeSessionId} />
      )}
      <Button
        disabled={openNative.isPending}
        onClick={() => {
          openNative.mutate({ threadId });
        }}
      >
        {view.nativeSessionId === null ? "Start session" : "Resume session"}
      </Button>
    </div>
  );
}
