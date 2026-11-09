import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import { useAtom } from "jotai";
import { useThread } from "@/hooks/queries/thread-queries";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useThreadFixedTabs } from "@/components/plugin/PluginThreadFixedTabs";
import { resolveGitDiffTabStatus } from "@/components/secondary-panel/gitDiffTabEligibility";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import {
  useReconciledFixedPanelTabsState,
  useTouchFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useThreadSecondaryPanelDrawerVisibility } from "./useThreadSecondaryPanelVisibility";
import {
  getActiveFixedSecondaryTab,
  useSetThreadSecondaryPanelSelection,
  useToggleThreadSecondaryPanelSelection,
} from "./threadSecondaryPanelSelection";

function useFrameState(threadId: string) {
  const { data: thread } = useThread(threadId, { enabled: false });
  const environmentQuery = useEnvironment(thread?.environmentId, {
    enabled: false,
  });
  const environment = environmentQuery.data;
  const executionUnavailable =
    environment !== undefined &&
    (environment.hostLifecycle !== "active" ||
      environment.status === "destroyed");
  const gitDiffTabStatus = resolveGitDiffTabStatus({
    environmentId: thread?.environmentId ?? null,
    environmentIsGitRepo: environment?.isGitRepo,
    environmentLoadFailed: environmentQuery.isError,
    environmentOwnsPath: environment?.managed,
    hasResolvedThread: thread !== undefined,
    threadArchived: thread?.archivedAt != null || executionUnavailable,
  });
  const canUseGitUi = !executionUnavailable && gitDiffTabStatus === "eligible";
  const threadEnvironmentId =
    canUseGitUi && environment !== undefined && thread?.environmentId
      ? thread.environmentId
      : null;
  const threadTabEnvironmentId = thread?.environmentId ?? null;
  const threadFixedTabs = useThreadFixedTabs({
    threadId: thread?.id ?? null,
    environmentId: threadTabEnvironmentId,
  });
  const threadFixedViewTabs = useMemo(
    () => threadFixedTabs.entries.map((entry) => entry.tab),
    [threadFixedTabs.entries],
  );
  const fixedPanelTabsState = useReconciledFixedPanelTabsState({
    fixedTabs: threadFixedViewTabs,
    isAuthoritative:
      threadFixedTabs.isReady &&
      (gitDiffTabStatus === "eligible" || gitDiffTabStatus === "ineligible"),
    panelStateId: threadId,
    syncThreadId: threadId,
  });
  const isPersistedSecondaryPanelOpen = fixedPanelTabsState.secondary.isOpen;
  const activeFixedSecondaryTab = getActiveFixedSecondaryTab({
    fixedPanelTabsState,
  });
  const activeFixedSecondaryTabId = activeFixedSecondaryTab?.id ?? null;
  const isCompactViewport = useIsCompactViewport();
  const renderSecondaryPanelAsDrawer = isCompactViewport;
  const secondaryPanelDrawerVisibility =
    useThreadSecondaryPanelDrawerVisibility({
      isCompactViewport: renderSecondaryPanelAsDrawer,
      threadId,
    });
  const isWorkspacePanelOpen = renderSecondaryPanelAsDrawer
    ? secondaryPanelDrawerVisibility.isDrawerVisible
    : isPersistedSecondaryPanelOpen;
  const isSecondaryPanelOpen = isWorkspacePanelOpen;
  const touchFixedPanelTabsState = useTouchFixedPanelTabsState(
    threadId,
    threadId,
  );
  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(
    threadId,
    threadId,
  );
  const setThreadSecondaryPanel = useSetThreadSecondaryPanelSelection(
    threadId,
    threadId,
  );
  const closeThreadSecondaryPanel = useCallback(() => {
    setThreadSecondaryPanel(null);
  }, [setThreadSecondaryPanel]);
  const toggleDefaultPersistedSecondaryPanel =
    useToggleThreadSecondaryPanelSelection(threadId, threadId);
  const [storedConversationCollapsed, setStoredConversationCollapsed] = useAtom(
    getThreadConversationCollapsedAtom(threadId),
  );
  const toggleConversationCollapse = useCallback(() => {
    setStoredConversationCollapsed((collapsed) => !collapsed);
  }, [setStoredConversationCollapsed]);
  return {
    threadEnvironmentId,
    threadTabEnvironmentId,
    threadFixedTabs,
    fixedPanelTabsState,
    isPersistedSecondaryPanelOpen,
    activeFixedSecondaryTab,
    activeFixedSecondaryTabId,
    isCompactViewport,
    renderSecondaryPanelAsDrawer,
    secondaryPanelDrawerVisibility,
    isSecondaryPanelOpen,
    touchFixedPanelTabsState,
    updateFixedPanelTabsState,
    setThreadSecondaryPanel,
    closeThreadSecondaryPanel,
    toggleDefaultPersistedSecondaryPanel,
    isConversationCollapsed: storedConversationCollapsed,
    toggleConversationCollapse,
  };
}

const ThreadFrameStateContext = createContext<ReturnType<
  typeof useFrameState
> | null>(null);
export const useOptionalThreadFrameState = () =>
  useContext(ThreadFrameStateContext);
export function useThreadFrameState() {
  const state = useOptionalThreadFrameState();
  if (!state) throw new Error("Thread frame state is missing");
  return state;
}
export function ThreadFrameStateProvider({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  const state = useFrameState(threadId);
  return (
    <ThreadFrameStateContext.Provider value={state}>
      {children}
    </ThreadFrameStateContext.Provider>
  );
}
