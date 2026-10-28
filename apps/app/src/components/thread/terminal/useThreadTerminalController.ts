import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  TerminalCreateTarget,
  TerminalSession,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import {
  terminalQueryScopeForTarget,
  useCloseTerminal,
  useCreateTerminal,
  useRenameTerminal,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import {
  useRemoveFixedRightTerminalTab,
  useSetFixedRightTerminalActiveTerminal,
} from "@/lib/fixed-panel-tabs";
import { applyTerminalSessionUpsert } from "@/hooks/cache-owners/terminal-cache-owner";
import {
  isVisibleTerminalSession,
  omitSupersededDisconnectedSessions,
  shouldCloseUnretainedDisconnectedTerminalSession,
  shouldShowRetainedTerminalSession,
} from "@/lib/terminal-session-visibility";
import {
  useMountedTerminalIds,
  useMountedTerminalRegistration,
} from "./mounted-terminals";
import {
  resolveTerminalScopeKey,
  type ThreadTerminalTarget,
} from "./terminal-scope";
import { normalizeTerminalTitle } from "./thread-terminal-title";
import { useTerminalStart, type TerminalStart } from "./pending-terminals";
import {
  clearTerminalCurrentCwd,
  setTerminalCurrentCwd,
  shouldUseTerminalCwdTitle,
  terminalCwdTitle,
  terminalSpawnCwd,
} from "./terminal-shell-state";
import { queueThreadProgressUpdate } from "@/lib/terminal-progress-updates";

export const DEFAULT_TERMINAL_COLS = 100;
export const DEFAULT_TERMINAL_ROWS = 30;
const EMPTY_TERMINAL_SESSIONS: readonly TerminalSession[] = [];
const TERMINAL_TITLE_RENAME_DEBOUNCE_MS = 250;
const TERMINAL_PROGRESS_UPDATE_INTERVAL_MS = 250;

export type { ThreadTerminalTarget };

export interface ThreadTerminalControllerArgs {
  canCreateTerminal?: boolean;
  fixedPanelTarget?: TerminalCreateTarget;
  fixedTerminalId?: string;
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
  panelStateId?: string;
  preferredTerminalId?: string;
  syncThreadId?: string | null;
  terminalId?: string;
  target: TerminalCreateTarget;
}

export interface ThreadTerminalController {
  activeSession: TerminalSession | null;
  handleActiveTerminalCwdChange: (cwd: string) => void;
  handleActiveTerminalSessionChange: (session: TerminalSession) => void;
  handleActiveTerminalTitleChange: ThreadTerminalTitleChangeHandler;
  handleActiveTerminalProgressChange: (progress: number | null) => void;
  handleActiveTerminalUserInput: ThreadTerminalActionHandler;
  handleCreateTerminal: ThreadTerminalActionHandler;
  handleSelectTerminal: ThreadTerminalIdHandler;
  hasTerminalQueryError: boolean;
  isCreateTerminalPending: boolean;
  isPanelOpen: boolean;
  shouldMountTerminalView: boolean;
  shouldRetainActiveTerminalView: boolean;
  start: TerminalStart | null;
  terminalsLoading: boolean;
  terminalBodyMessage: string;
}

interface TerminalTitleRenameRequest {
  terminalId: string;
  title: string;
}

type ThreadTerminalActionHandler = () => void;
type ThreadTerminalIdHandler = (terminalId: string) => void;
type ThreadTerminalTitleChangeHandler = (title: string) => void;
type TerminalTitleRenameTimeout = number;
type TerminalCloseMode = "force" | "if-clean";

export function shouldAutoCloseCleanTerminalSession({
  dirtyTerminalIds,
  session,
  uiCreatedTerminalIds,
}: {
  dirtyTerminalIds: ReadonlySet<string>;
  session: TerminalSession;
  uiCreatedTerminalIds: ReadonlySet<string>;
}): boolean {
  return (
    session.lastUserInputAt === null &&
    uiCreatedTerminalIds.has(session.id) &&
    !dirtyTerminalIds.has(session.id)
  );
}

interface TerminalPanelVisibility {
  hasPanelOpened: boolean;
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
}

export function resolveTerminalPanelMount({
  hasPanelOpened,
  isPanelOpen,
  isPanelPersistedOpen,
}: TerminalPanelVisibility): {
  hasPanelOpened: boolean;
  shouldFetchTerminals: boolean;
  shouldMountTerminalView: boolean;
} {
  const nextHasPanelOpened = isPanelOpen
    ? true
    : isPanelPersistedOpen && hasPanelOpened;
  return {
    hasPanelOpened: nextHasPanelOpened,
    shouldFetchTerminals: isPanelOpen,
    shouldMountTerminalView:
      isPanelOpen || (isPanelPersistedOpen && nextHasPanelOpened),
  };
}

function terminalSessionBelongsToTarget(
  session: TerminalSession,
  target: TerminalCreateTarget,
): boolean {
  return (
    target.kind !== "host_path" ||
    (session.threadId === null &&
      session.environmentId === null &&
      session.hostId === target.hostId &&
      (target.cwd === null || session.initialCwd === target.cwd))
  );
}

export function selectActiveTerminalSession({
  sessions,
  target,
  terminalId,
}: {
  sessions: readonly TerminalSession[];
  target: TerminalCreateTarget;
  terminalId: string;
}): TerminalSession | null {
  return (
    sessions.find(
      (session) =>
        session.id === terminalId &&
        isVisibleTerminalSession(session) &&
        terminalSessionBelongsToTarget(session, target),
    ) ?? null
  );
}

export function shouldAutoCloseCleanTerminalSessionsForPanel({
  isPanelOpen,
  isPanelPersistedOpen,
}: {
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
}): boolean {
  return !isPanelOpen && !isPanelPersistedOpen;
}

export function pickActiveTerminalId(
  sessions: readonly TerminalSession[],
  preferredTerminalId: string | null,
  fixedTerminalId?: string,
): string | null {
  if (fixedTerminalId !== undefined) {
    return sessions.some((session) => session.id === fixedTerminalId)
      ? fixedTerminalId
      : null;
  }
  if (
    preferredTerminalId &&
    sessions.some((session) => session.id === preferredTerminalId)
  ) {
    return preferredTerminalId;
  }
  return sessions[0]?.id ?? null;
}

export function useThreadTerminalController({
  canCreateTerminal = true,
  fixedPanelTarget,
  fixedTerminalId,
  isPanelOpen,
  isPanelPersistedOpen,
  panelStateId,
  preferredTerminalId,
  syncThreadId,
  terminalId,
  target,
}: ThreadTerminalControllerArgs): ThreadTerminalController {
  const queryClient = useQueryClient();
  const terminalTargetId = resolveTerminalScopeKey(target);
  const fixedPanelStateId = panelStateId ?? terminalTargetId;
  const resolvedSyncThreadId =
    syncThreadId ?? (target.kind === "thread" ? target.threadId : null);
  const resolvedFixedPanelTarget = fixedPanelTarget ?? target;
  const setActiveFixedTerminal = useSetFixedRightTerminalActiveTerminal(
    fixedPanelStateId,
    resolvedSyncThreadId,
  );
  const removeFixedTerminalTab = useRemoveFixedRightTerminalTab(
    fixedPanelStateId,
    resolvedSyncThreadId,
  );
  const uiCreatedTerminalIdsRef = useRef<Set<string>>(new Set());
  const terminalCwdsRef = useRef(new Map<string, string>());
  const terminalCwdTitlesRef = useRef(new Map<string, string>());
  const terminalProgramTitlesRef = useRef(new Map<string, string>());
  const lastProgressUpdateRef = useRef<{
    threadId: string;
    terminalId: string;
    value: number | null;
    sentAt: number;
  } | null>(null);
  const pendingProgressUpdateRef = useRef<{
    threadId: string;
    terminalId: string;
    value: number;
  } | null>(null);
  const progressUpdateTimeoutRef = useRef<number | null>(null);
  const dirtyTerminalIdsRef = useRef<Set<string>>(new Set());
  const closingCleanTerminalIdsRef = useRef<Set<string>>(new Set());
  const closingDisconnectedTerminalIdsRef = useRef<Set<string>>(new Set());
  const latestRequestedTitleRenameRef =
    useRef<TerminalTitleRenameRequest | null>(null);
  const pendingTitleRenameTimeoutRef =
    useRef<TerminalTitleRenameTimeout | null>(null);
  const [retainedTerminalViewId, setRetainedTerminalViewId] = useState<
    string | null
  >(null);
  const [retainedExitedSession, setRetainedExitedSession] =
    useState<TerminalSession | null>(null);
  const [hasPanelOpened, setHasPanelOpened] = useState(isPanelOpen);
  const panelMount = resolveTerminalPanelMount({
    hasPanelOpened,
    isPanelOpen,
    isPanelPersistedOpen,
  });
  if (panelMount.hasPanelOpened !== hasPanelOpened) {
    setHasPanelOpened(panelMount.hasPanelOpened);
  }
  const { shouldMountTerminalView } = panelMount;
  const terminalsQuery = useTerminals(terminalQueryScopeForTarget(target), {
    enabled: panelMount.shouldFetchTerminals,
  });
  const createTerminal = useCreateTerminal();
  const closeTerminalMutation = useCloseTerminal();
  const renameTerminal = useRenameTerminal();
  const start = useTerminalStart(terminalId ?? "");
  const isCreateTerminalPending = createTerminal.isPending;
  const isCloseTerminalPending = closeTerminalMutation.isPending;
  const closingTerminalVariables = closeTerminalMutation.variables;
  const sessions = useMemo(() => {
    const currentSessions =
      terminalsQuery.data?.sessions ?? EMPTY_TERMINAL_SESSIONS;
    const scopedSessions =
      target.kind === "host_path"
        ? currentSessions.filter((session) =>
            terminalSessionBelongsToTarget(session, target),
          )
        : currentSessions;
    if (
      retainedExitedSession === null ||
      scopedSessions.some((session) => session.id === retainedExitedSession.id)
    ) {
      return scopedSessions;
    }
    return [...scopedSessions, retainedExitedSession];
  }, [retainedExitedSession, target, terminalsQuery.data?.sessions]);
  const paneRetainedTerminalIds = useMemo(
    () =>
      new Set<string>(
        retainedTerminalViewId === null ? [] : [retainedTerminalViewId],
      ),
    [retainedTerminalViewId],
  );
  const visibleSessions = useMemo(
    () =>
      omitSupersededDisconnectedSessions(sessions).filter((session) =>
        shouldShowRetainedTerminalSession({
          retainedTerminalIds: paneRetainedTerminalIds,
          session,
        }),
      ),
    [paneRetainedTerminalIds, sessions],
  );
  const activeTerminalId = useMemo(
    () =>
      pickActiveTerminalId(
        visibleSessions,
        preferredTerminalId ?? terminalId ?? null,
        fixedTerminalId ?? terminalId,
      ),
    [fixedTerminalId, preferredTerminalId, terminalId, visibleSessions],
  );
  const activeSession =
    visibleSessions.find((session) => session.id === activeTerminalId) ?? null;
  useMountedTerminalRegistration({
    isMounted: shouldMountTerminalView,
    scopeKey: terminalTargetId,
    terminalId: activeTerminalId,
  });
  const mountedTerminalIds = useMountedTerminalIds(terminalTargetId);
  const shouldRetainActiveTerminalView =
    activeSession?.status === "disconnected" &&
    activeSession.id === retainedTerminalViewId;

  useEffect(() => {
    if (!shouldMountTerminalView) {
      setRetainedTerminalViewId(null);
      return;
    }
    if (activeSession?.status === "running") {
      setRetainedTerminalViewId(activeSession.id);
      return;
    }
    if (
      retainedTerminalViewId !== null &&
      activeTerminalId !== retainedTerminalViewId
    ) {
      setRetainedTerminalViewId(null);
      setRetainedExitedSession(null);
    }
  }, [
    activeSession,
    activeSession?.status,
    activeTerminalId,
    retainedTerminalViewId,
    shouldMountTerminalView,
  ]);

  useEffect(() => {
    if (!isPanelOpen || terminalsQuery.isLoading || terminalsQuery.error) {
      return;
    }
    if (
      preferredTerminalId !== undefined ||
      terminalId !== undefined ||
      activeTerminalId === null
    ) {
      return;
    }
    setActiveFixedTerminal(activeTerminalId, resolvedFixedPanelTarget);
  }, [
    activeTerminalId,
    isPanelOpen,
    preferredTerminalId,
    resolvedFixedPanelTarget,
    setActiveFixedTerminal,
    terminalId,
    terminalsQuery.error,
    terminalsQuery.isLoading,
  ]);

  useEffect(() => {
    return () => {
      if (pendingTitleRenameTimeoutRef.current === null) {
        return;
      }
      window.clearTimeout(pendingTitleRenameTimeoutRef.current);
    };
  }, []);

  const sendTerminalProgressUpdate = useCallback(
    (threadId: string, terminalId: string, value: number | null) => {
      const request =
        value === null
          ? { threadId, terminalId, action: "progress-clear" as const }
          : {
              threadId,
              terminalId,
              action: "progress-set" as const,
              progress: { value },
            };
      lastProgressUpdateRef.current = {
        threadId,
        terminalId,
        value,
        sentAt: Date.now(),
      };
      void queueThreadProgressUpdate(threadId, () =>
        sdk.threads.experimental_updateRowState(request),
      )
        .catch(() => undefined);
    },
    [],
  );

  const clearTerminalProgress = useCallback(
    (threadId: string | null, terminalId: string | null) => {
      const pendingUpdate = pendingProgressUpdateRef.current;
      const matchesTarget = (update: {
        threadId: string;
        terminalId: string;
      }) =>
        (threadId === null || update.threadId === threadId) &&
        (terminalId === null || update.terminalId === terminalId);
      const pendingMatches =
        pendingUpdate !== null && matchesTarget(pendingUpdate);
      if (pendingMatches) {
        pendingProgressUpdateRef.current = null;
        if (progressUpdateTimeoutRef.current !== null) {
          window.clearTimeout(progressUpdateTimeoutRef.current);
          progressUpdateTimeoutRef.current = null;
        }
      }
      if (threadId === null || terminalId === null) return;
      sendTerminalProgressUpdate(threadId, terminalId, null);
    },
    [sendTerminalProgressUpdate],
  );

  const queueTerminalProgressUpdate = useCallback(
    (threadId: string, terminalId: string, value: number) => {
      const lastUpdate = lastProgressUpdateRef.current;
      const pendingUpdate = pendingProgressUpdateRef.current;
      if (
        pendingUpdate?.threadId === threadId &&
        pendingUpdate.terminalId === terminalId &&
        pendingUpdate.value === value
      ) {
        return;
      }
      if (
        lastUpdate?.threadId === threadId &&
        lastUpdate.terminalId === terminalId &&
        lastUpdate.value === value
      ) {
        if (pendingUpdate?.threadId === threadId) {
          pendingProgressUpdateRef.current = null;
          if (progressUpdateTimeoutRef.current !== null) {
            window.clearTimeout(progressUpdateTimeoutRef.current);
            progressUpdateTimeoutRef.current = null;
          }
        }
        return;
      }

      const elapsed =
        lastUpdate?.threadId === threadId
          ? Date.now() - lastUpdate.sentAt
          : TERMINAL_PROGRESS_UPDATE_INTERVAL_MS;
      if (elapsed >= TERMINAL_PROGRESS_UPDATE_INTERVAL_MS) {
        if (progressUpdateTimeoutRef.current !== null) {
          window.clearTimeout(progressUpdateTimeoutRef.current);
          progressUpdateTimeoutRef.current = null;
        }
        pendingProgressUpdateRef.current = null;
        sendTerminalProgressUpdate(threadId, terminalId, value);
        return;
      }

      pendingProgressUpdateRef.current = { threadId, terminalId, value };
      if (progressUpdateTimeoutRef.current !== null) return;
      progressUpdateTimeoutRef.current = window.setTimeout(() => {
        progressUpdateTimeoutRef.current = null;
        const nextUpdate = pendingProgressUpdateRef.current;
        pendingProgressUpdateRef.current = null;
        if (nextUpdate === null) return;
        const previousUpdate = lastProgressUpdateRef.current;
        if (
          previousUpdate?.threadId === nextUpdate.threadId &&
          previousUpdate.terminalId === nextUpdate.terminalId &&
          previousUpdate.value === nextUpdate.value
        ) {
          return;
        }
        sendTerminalProgressUpdate(
          nextUpdate.threadId,
          nextUpdate.terminalId,
          nextUpdate.value,
        );
      }, TERMINAL_PROGRESS_UPDATE_INTERVAL_MS - elapsed);
    },
    [sendTerminalProgressUpdate],
  );

  const activeSessionId = activeSession?.id;
  const activeSessionInitialCwd = activeSession?.initialCwd;
  const startTerminal = useCallback(() => {
    if (!canCreateTerminal || isCreateTerminalPending) {
      return;
    }
    const activeCwd =
      activeSessionId && activeSessionInitialCwd
        ? terminalSpawnCwd({
            currentCwd: terminalCwdsRef.current.get(activeSessionId),
            initialCwd: activeSessionInitialCwd,
          })
        : undefined;
    const request = {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
      ...(activeCwd === undefined ? {} : { cwd: activeCwd }),
    };
    const created = createTerminal.mutateAsync({
      ...request,
      target: resolvedFixedPanelTarget,
    });
    void created
      .then((session) => {
        uiCreatedTerminalIdsRef.current.add(session.id);
        setActiveFixedTerminal(session.id, resolvedFixedPanelTarget);
      })
      .catch(() => undefined);
  }, [
    canCreateTerminal,
    createTerminal,
    activeSessionId,
    activeSessionInitialCwd,
    isCreateTerminalPending,
    resolvedFixedPanelTarget,
    setActiveFixedTerminal,
  ]);

  const handleActiveTerminalCwdChange = useCallback(
    (cwd: string) => {
      if (!activeSession) return;
      terminalCwdsRef.current.set(activeSession.id, cwd);
      setTerminalCurrentCwd(activeSession.id, cwd);
      if (
        !shouldUseTerminalCwdTitle({
          currentTitle: activeSession.title,
          defaultTitle: ["bash", "zsh", "fish"].includes(activeSession.title)
            ? activeSession.title
            : "",
          previousCwdTitle:
            terminalCwdTitlesRef.current.get(activeSession.id) ?? null,
          previousProgramTitle:
            terminalProgramTitlesRef.current.get(activeSession.id) ?? null,
        })
      ) {
        return;
      }
      const title = terminalCwdTitle(cwd);
      terminalCwdTitlesRef.current.set(activeSession.id, title);
      if (title !== activeSession.title && activeSession.status === "running") {
        renameTerminal.mutate({ terminalId: activeSession.id, title });
      }
    },
    [activeSession, renameTerminal],
  );

  const closeTerminal = useCallback(
    ({
      mode,
      onSettled,
      onSuccess,
      terminalId,
    }: {
      mode: TerminalCloseMode;
      onSettled?: () => void;
      onSuccess?: (session: TerminalSession) => void;
      terminalId: string;
    }) => {
      closeTerminalMutation.mutate(
        { mode, terminalId },
        {
          onSettled: () => onSettled?.(),
          onSuccess: (session) => {
            if (session !== null) onSuccess?.(session);
          },
        },
      );
    },
    [closeTerminalMutation],
  );

  useEffect(() => {
    if (!isPanelOpen || terminalsQuery.isLoading || terminalsQuery.error) {
      return;
    }
    for (const session of sessions) {
      if (
        !shouldCloseUnretainedDisconnectedTerminalSession({
          retainedTerminalIds: mountedTerminalIds,
          session,
        }) ||
        closingDisconnectedTerminalIdsRef.current.has(session.id)
      ) {
        continue;
      }
      closingDisconnectedTerminalIdsRef.current.add(session.id);
      closeTerminal({
        mode: "force",
        terminalId: session.id,
        onSuccess: (closedSession) => {
          if (closedSession.status !== "exited") {
            return;
          }
          uiCreatedTerminalIdsRef.current.delete(closedSession.id);
          dirtyTerminalIdsRef.current.delete(closedSession.id);
          closingCleanTerminalIdsRef.current.delete(closedSession.id);
          removeFixedTerminalTab(closedSession.id);
        },
        onSettled: () => {
          closingDisconnectedTerminalIdsRef.current.delete(session.id);
        },
      });
    }
  }, [
    closeTerminal,
    isPanelOpen,
    mountedTerminalIds,
    removeFixedTerminalTab,
    sessions,
    terminalsQuery.error,
    terminalsQuery.isLoading,
  ]);

  const replaceDisconnectedTerminal = useCallback(
    (terminalId: string) => {
      if (
        !canCreateTerminal ||
        isCreateTerminalPending ||
        isCloseTerminalPending
      ) {
        return;
      }
      closeTerminal({
        mode: "force",
        terminalId,
        onSuccess: () => {
          uiCreatedTerminalIdsRef.current.delete(terminalId);
          dirtyTerminalIdsRef.current.delete(terminalId);
          closingCleanTerminalIdsRef.current.delete(terminalId);
          removeFixedTerminalTab(terminalId);
          startTerminal();
        },
      });
    },
    [
      canCreateTerminal,
      closeTerminal,
      isCloseTerminalPending,
      isCreateTerminalPending,
      removeFixedTerminalTab,
      startTerminal,
    ],
  );

  useEffect(() => {
    if (
      !shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen,
        isPanelPersistedOpen,
      })
    ) {
      return;
    }
    for (const session of visibleSessions) {
      if (
        !shouldAutoCloseCleanTerminalSession({
          dirtyTerminalIds: dirtyTerminalIdsRef.current,
          session,
          uiCreatedTerminalIds: uiCreatedTerminalIdsRef.current,
        }) ||
        closingCleanTerminalIdsRef.current.has(session.id)
      ) {
        continue;
      }
      closingCleanTerminalIdsRef.current.add(session.id);
      closeTerminal({
        mode: "if-clean",
        terminalId: session.id,
        onSuccess: (closedSession) => {
          if (closedSession.status !== "exited") {
            return;
          }
          uiCreatedTerminalIdsRef.current.delete(closedSession.id);
          dirtyTerminalIdsRef.current.delete(closedSession.id);
          removeFixedTerminalTab(closedSession.id);
        },
        onSettled: () => {
          closingCleanTerminalIdsRef.current.delete(session.id);
        },
      });
    }
  }, [
    closeTerminal,
    isPanelOpen,
    isPanelPersistedOpen,
    removeFixedTerminalTab,
    visibleSessions,
  ]);

  const handleCreateTerminal = useCallback(() => {
    if (activeSession?.status === "disconnected") {
      replaceDisconnectedTerminal(activeSession.id);
      return;
    }
    startTerminal();
  }, [activeSession, replaceDisconnectedTerminal, startTerminal]);

  const handleSelectTerminal = useCallback(
    (terminalId: string) => {
      setActiveFixedTerminal(terminalId, resolvedFixedPanelTarget);
    },
    [resolvedFixedPanelTarget, setActiveFixedTerminal],
  );

  const handleActiveTerminalSessionChange = useCallback(
    (session: TerminalSession) => {
      if (session.status === "exited") {
        clearTerminalProgress(session.threadId, session.id);
        clearTerminalCurrentCwd(session.id);
        terminalCwdsRef.current.delete(session.id);
        terminalCwdTitlesRef.current.delete(session.id);
        terminalProgramTitlesRef.current.delete(session.id);
        setRetainedExitedSession(session);
        applyTerminalSessionUpsert({ queryClient, session });
        return;
      }
      applyTerminalSessionUpsert({ queryClient, session });
    },
    [clearTerminalProgress, queryClient],
  );

  const handleActiveTerminalUserInput = useCallback(() => {
    if (!activeTerminalId) {
      return;
    }
    dirtyTerminalIdsRef.current.add(activeTerminalId);
  }, [activeTerminalId]);

  const handleActiveTerminalProgressChange = useCallback(
    (progress: number | null) => {
      const threadId = activeSession?.threadId;
      if (!threadId) return;
      if (progress === null) {
        clearTerminalProgress(threadId, activeSession.id);
        return;
      }
      queueTerminalProgressUpdate(threadId, activeSession.id, progress);
    },
    [
      activeSession?.id,
      activeSession?.threadId,
      clearTerminalProgress,
      queueTerminalProgressUpdate,
    ],
  );

  const handleActiveTerminalTitleChange: ThreadTerminalTitleChangeHandler =
    useCallback(
      (title) => {
        if (!activeSession || activeSession.status !== "running") {
          return;
        }
        const normalizedTitle = normalizeTerminalTitle({ title });
        if (!normalizedTitle || normalizedTitle === activeSession.title) {
          return;
        }
        if (
          !shouldUseTerminalCwdTitle({
            currentTitle: activeSession.title,
            defaultTitle: ["bash", "zsh", "fish"].includes(activeSession.title)
              ? activeSession.title
              : "",
            previousCwdTitle:
              terminalCwdTitlesRef.current.get(activeSession.id) ?? null,
            previousProgramTitle:
              terminalProgramTitlesRef.current.get(activeSession.id) ?? null,
          })
        ) {
          return;
        }
        terminalProgramTitlesRef.current.set(activeSession.id, normalizedTitle);

        const request: TerminalTitleRenameRequest = {
          terminalId: activeSession.id,
          title: normalizedTitle,
        };
        const latestRequest = latestRequestedTitleRenameRef.current;
        if (
          latestRequest !== null &&
          latestRequest.terminalId === request.terminalId &&
          latestRequest.title === request.title
        ) {
          return;
        }

        latestRequestedTitleRenameRef.current = request;
        if (pendingTitleRenameTimeoutRef.current !== null) {
          window.clearTimeout(pendingTitleRenameTimeoutRef.current);
        }
        pendingTitleRenameTimeoutRef.current = window.setTimeout(() => {
          pendingTitleRenameTimeoutRef.current = null;
          const onSettled = () => {
            const currentRequest = latestRequestedTitleRenameRef.current;
            if (
              currentRequest !== null &&
              currentRequest.terminalId === request.terminalId &&
              currentRequest.title === request.title
            ) {
              latestRequestedTitleRenameRef.current = null;
            }
          };
          renameTerminal.mutate(
            {
              terminalId: request.terminalId,
              title: request.title,
            },
            { onSettled },
          );
        }, TERMINAL_TITLE_RENAME_DEBOUNCE_MS);
      },
      [activeSession, renameTerminal],
    );

  const terminalIsReplacing =
    activeSession?.status === "disconnected" &&
    isCloseTerminalPending &&
    closingTerminalVariables?.terminalId === activeSession.id;
  const terminalIsStarting = isCreateTerminalPending || terminalIsReplacing;

  const inactiveTerminalBodyMessage = canCreateTerminal
    ? "Starting terminal..."
    : "Terminals unavailable.";

  const terminalsLoading = terminalsQuery.isLoading;
  const terminalBodyMessage = terminalIsStarting
    ? inactiveTerminalBodyMessage
    : terminalsLoading
      ? "Loading terminals..."
      : "No terminals";

  return {
    activeSession,
    handleActiveTerminalCwdChange,
    handleActiveTerminalSessionChange,
    handleActiveTerminalTitleChange,
    handleActiveTerminalProgressChange,
    handleActiveTerminalUserInput,
    handleCreateTerminal,
    handleSelectTerminal,
    hasTerminalQueryError:
      terminalsQuery.error !== null && terminalsQuery.data === undefined,
    isCreateTerminalPending,
    isPanelOpen,
    shouldMountTerminalView,
    shouldRetainActiveTerminalView,
    start,
    terminalsLoading,
    terminalBodyMessage,
  };
}
