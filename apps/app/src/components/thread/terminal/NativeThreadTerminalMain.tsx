import {
  NATIVE_TERMINAL_SETUP_DELAY_MS,
  nativeTerminalMayNeedSetup,
} from "@bb/domain";
import { useQuery } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { threadDefaultExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import { useEffect, useState, type FocusEvent } from "react";
import { isRunningThreadRuntimeDisplayStatus } from "@bb/client-core";
import { Button } from "@bb/shared-ui/button";
import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import type { NativeTerminalThread } from "@bb/server-contract";
import type { ThreadRuntimeState } from "@bb/domain";
import { NativeTerminalPanel } from "./NativeTerminalPanel";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import {
  useNativeTerminalThread,
  useOpenNativeTerminal,
} from "@/hooks/queries/native-terminal-queries";
import { useThreadPendingInteractions } from "@/hooks/queries/thread-queries";
import { useThreadTerminals } from "@/hooks/queries/thread-terminal-queries";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { formatModelLabel } from "@/hooks/useThreadCreationOptions";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";
import { NativeActivityNotice } from "./NativeActivityNotice";
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
  onOpenLink?: MarkdownPreviewLinkHandler;
  projectId: string;
  runtime: ThreadRuntimeState;
  threadId: string;
  threadIsProvisioning: boolean;
  view: NativeTerminalThread;
}

export function NativeThreadTerminalMain({
  onOpenLink,
  projectId,
  runtime,
  threadId,
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
  const state = resolveNativeTerminalState({
    session,
    threadIsProvisioning,
    threadIsRunning: isRunningThreadRuntimeDisplayStatus(runtime.displayStatus),
  });
  const providerLabel = view.displayName;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (view.nativeSessionId !== null || session?.status !== "running") return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(
        0,
        Math.max(session.createdAt, session.lastUserInputAt ?? 0) +
          NATIVE_TERMINAL_SETUP_DELAY_MS -
          Date.now(),
      ),
    );
    return () => window.clearTimeout(timer);
  }, [
    view.nativeSessionId,
    session?.id,
    session?.status,
    session?.createdAt,
    session?.lastUserInputAt,
  ]);
  const setupWaiting = nativeTerminalMayNeedSetup({
    nativeSessionId: view.nativeSessionId,
    terminal: session,
    now,
  });
  const waitingPrompts = nativeTerminalWaitingPrompts(
    interactionsQuery.data ?? [],
  );
  const paneIsFocused = useOptionalPaneContext()?.isFocused ?? true;
  const isTouchDevice = useMediaQuery("(pointer: coarse)");
  const { refetch } = nativeQuery;
  const terminalsUpdatedAt = terminalsQuery.dataUpdatedAt;
  const [composerEngaged, setComposerEngaged] = useState(false);
  const onFocusWithin = (event: FocusEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest("form[data-native-terminal-prompt]") !== null
    ) {
      setComposerEngaged(true);
    }
  };

  useEffect(() => {
    if (!paneIsFocused) setComposerEngaged(false);
  }, [paneIsFocused]);

  useEffect(() => {
    if (state.kind === "live") return;
    void refetch();
  }, [refetch, state.kind, terminalsUpdatedAt]);

  if (state.kind === "live") {
    return (
      <div
        className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
        data-native-terminal-thread={view.providerId}
        data-no-sidebar-swipe=""
        onFocus={onFocusWithin}
      >
        {setupWaiting || session?.attention ? (
          <div
            role="status"
            className={`shrink-0 px-3 py-1 text-xs ${session?.attention ? "text-attention" : "text-muted-foreground"}`}
          >
            {session?.attention
              ? "Check terminal"
              : `${providerLabel} hasn't started a session yet`}
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
        <NativeTerminalPanel
          autoFocus={paneIsFocused && !isTouchDevice && !composerEngaged}
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
          executionLabel={executionLabel || undefined}
          providerLabel={providerLabel}
          threadId={threadId}
        />
      </div>
    );
  }

  if (state.kind === "preparing" || state.kind === "reconnecting") {
    return (
      <div
        className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
        data-native-terminal-thread={view.providerId}
      >
        {state.kind === "preparing"
          ? `Preparing the workspace for ${providerLabel}…`
          : `Reconnecting to ${providerLabel}…`}
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
      ? "Exited, resume to continue"
      : `${providerLabel} session ended`;

  if (session?.status === "exited" && !historyExpired) {
    return (
      <div
        className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
        data-native-terminal-thread={view.providerId}
        data-no-sidebar-swipe=""
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border-seam px-3 py-2 text-sm">
          <div className="min-w-0">
            <span className="font-medium">
              {endedLabel}
              {state.exitCode !== null && state.exitCode !== 0
                ? ` (exit ${state.exitCode})`
                : ""}
            </span>
            {view.nativeSessionId === null ? null : (
              <span className="ml-2 text-muted-foreground">
                Session {view.nativeSessionId}
              </span>
            )}
          </div>
          <Button
            disabled={openNative.isPending}
            onClick={() => openNative.mutate({ threadId })}
          >
            {view.nativeSessionId === null ? "Start session" : "Resume session"}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <NativeTerminalPanel
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

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm"
      data-native-terminal-thread={view.providerId}
    >
      <p className="font-medium text-foreground">
        {endedLabel}
        {state.exitCode !== null && state.exitCode !== 0
          ? ` (exit ${state.exitCode})`
          : ""}
      </p>
      {historyExpired ? (
        <p className="text-muted-foreground">
          Terminal history expired. Resume to continue.
        </p>
      ) : null}
      {view.nativeSessionId === null ? null : (
        <p className="text-muted-foreground">Session {view.nativeSessionId}</p>
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
