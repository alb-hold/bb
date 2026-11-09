import {
  useCallback,
  useContext,
  useLayoutEffect,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ThreadSecondaryPanelInlinePlaceholder } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { SecondaryPanelMinimumContext } from "@/components/secondary-panel/secondaryPanelSizing";
import { SecondaryPanelWidthPercentAtomContext } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import type { NativeTerminalThread } from "@bb/server-contract";
import type { ThreadResponse } from "@bb/server-contract";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { NativeThreadTerminalMain } from "@/components/thread/terminal/NativeThreadTerminalMain";
import {
  PluginComposerHostScopeProvider,
  usePluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { ThreadContextCardProvider } from "@/components/plugin/PluginThreadContextCard";
import { getThreadSecondaryPanelWidthPercentAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { useThreadPendingInteractions } from "@/hooks/queries/thread-queries";
import { useThreadTabs } from "@/hooks/queries/thread-tabs-query";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useLiveFileOpenTargets } from "@/hooks/useLiveFileOpenTargets";
import { toThreadActionTarget } from "@/lib/thread-actions/thread-action-target";
import { useTerminalMountGate } from "@/hooks/useTerminalMountGate";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import {
  CORE_THREAD_CONTEXT_CARD_ROWS,
  CORE_THREAD_CONTEXT_CARD_SECTIONS,
} from "./ThreadContextCardCore";
import {
  ThreadFrameStateProvider,
  useThreadFrameState,
} from "./ThreadFrameState";
import { ThreadFrameLayout } from "./ThreadFrameLayout";
import { ThreadFrameHeader } from "./ThreadFrameHeader";
import {
  NativeThreadFrameContext,
  type NativePanelTarget,
} from "./NativeThreadFrameContext";
import { resolveThreadWorkspaceOpenPath } from "./threadWorkspaceOpenPath";
import { usePaneContext } from "./PaneContext";

export function NativeThreadFrame(props: {
  thread: ThreadResponse;
  view: NativeTerminalThread;
  children: ReactNode;
}) {
  return (
    <ThreadFrameStateProvider threadId={props.thread.id}>
      <PluginComposerHostScopeProvider>
        <NativeThreadFrameBody {...props} />
      </PluginComposerHostScopeProvider>
    </ThreadFrameStateProvider>
  );
}
function NativeThreadFrameBody({
  thread,
  view,
  children,
}: {
  thread: ThreadResponse;
  view: NativeTerminalThread;
  children: ReactNode;
}) {
  useTerminalMountGate("terminal-thread-view-mount", thread.id, true);
  const { isBoundedPane, onRequestClose } = usePaneContext();
  const state = useThreadFrameState();
  const composerHost = usePluginComposerHost();
  const { data: config } = useSystemConfig();
  const isPointerCoarse = usePointerCoarse();
  const environmentQuery = useEnvironment(thread.environmentId, {
    staleTime: 5_000,
  });
  const environment = environmentQuery.data;
  const interactions = useThreadPendingInteractions(thread.id);
  const tabs = useThreadTabs(thread.id);
  const [activityTarget, setActivityTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [panelTarget, setPanelTarget] = useState<NativePanelTarget | null>(
    null,
  );
  const [onOpenLink, updateOpenLink] = useState<MarkdownPreviewLinkHandler>();
  const setOpenLink = useCallback(
    (handler: MarkdownPreviewLinkHandler | undefined) =>
      updateOpenLink(() => handler),
    [],
  );
  const context = useMemo(
    () => ({ panelTarget, setPanelTarget, setOpenLink }),
    [panelTarget, setOpenLink],
  );
  const renderPanel = useCallback(
    (args: NativePanelTarget["args"]) => (
      <NativeThreadPanelDestination
        args={args}
        isOpen={state.isSecondaryPanelOpen}
        setTarget={setPanelTarget}
      />
    ),
    [state.isSecondaryPanelOpen],
  );
  const setPanel = state.setThreadSecondaryPanel;
  const { closeDrawer, toggleDrawer } = state.secondaryPanelDrawerVisibility;
  const closePanel = useCallback(() => {
    if (state.isCompactViewport) closeDrawer();
    else setPanel(null);
  }, [state.isCompactViewport, closeDrawer, setPanel]);
  const togglePersisted = state.toggleDefaultPersistedSecondaryPanel;
  const togglePanel = useCallback(() => {
    if (state.isCompactViewport) toggleDrawer();
    else togglePersisted();
  }, [state.isCompactViewport, toggleDrawer, togglePersisted]);
  const available =
    environment !== undefined &&
    environment.hostLifecycle === "active" &&
    environment.status !== "destroyed";
  const openTargets = useLiveFileOpenTargets(
    available ? { kind: "host", hostId: environment.hostId } : null,
  );
  const workspaceOpenPath = resolveThreadWorkspaceOpenPath({
    canOpenWorkspace: openTargets.canOpenPreferredDirectoryTarget,
    environment,
    hasWorkspaceOpenTargets: openTargets.directoryOpenTargets.length > 0,
  });
  const target = toThreadActionTarget(
    thread,
    available &&
      environment.status === "ready" &&
      environment.path !== null &&
      thread.environmentId !== null
      ? { id: thread.environmentId, path: environment.path }
      : null,
  );
  const canMount =
    interactions.isSuccess &&
    tabs.isSuccess &&
    (thread.environmentId === null || !environmentQuery.isPending);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (canMount) setReady(true);
  }, [canMount]);
  return (
    <NativeThreadFrameContext.Provider value={context}>
      <ThreadContextCardProvider
        enabled={
          config?.experiments.threadContextCard === true &&
          !(state.isCompactViewport && isPointerCoarse)
        }
        coreRows={CORE_THREAD_CONTEXT_CARD_ROWS}
        coreSections={CORE_THREAD_CONTEXT_CARD_SECTIONS}
        threadId={thread.id}
        projectId={thread.projectId}
        environment={
          thread.environmentId === null ? null : { id: thread.environmentId }
        }
      >
        <ThreadFrameLayout
          isBoundedPane={isBoundedPane}
          open={state.isSecondaryPanelOpen}
          onToggle={togglePanel}
          onSwipeOpen={togglePanel}
          onClose={closePanel}
          panelGroupKey="thread-detail"
          resetKey={thread.id}
          contentKey={thread.id}
          drawerLabel="Thread details"
          drawerFallback={<div aria-busy="true" />}
          mainPanelId="thread-detail-timeline-panel"
          mainHeader={
            <ThreadFrameHeader
              thread={thread}
              threadActionTarget={target}
              workspaceOpenPath={workspaceOpenPath}
              openTargets={openTargets}
              isSecondaryPanelOpen={state.isSecondaryPanelOpen}
              toggleSecondaryPanel={togglePanel}
              onRequestClose={onRequestClose ?? undefined}
              nativeTerminalThread={view}
              setNativeActivityTarget={setActivityTarget}
            />
          }
          main={
            <>
              {ready ? (
                <NativeThreadTerminalMain
                  activityTarget={activityTarget}
                  onOpenLink={onOpenLink}
                  projectId={thread.projectId}
                  runtime={thread.runtime}
                  threadId={thread.id}
                  threadIsProvisioning={
                    thread.status === "pending" || thread.status === "starting"
                  }
                  view={view}
                />
              ) : (
                <div aria-busy="true" role="status">
                  Loading terminals...
                </div>
              )}
              {children}
            </>
          }
          collapse={{
            active: state.isConversationCollapsed,
            onToggle: state.toggleConversationCollapse,
          }}
          composerHost={composerHost}
          widthPercentAtom={getThreadSecondaryPanelWidthPercentAtom(thread.id)}
          renderPanel={renderPanel}
        />
        {state.threadFixedTabs.observers}
      </ThreadContextCardProvider>
    </NativeThreadFrameContext.Provider>
  );
}

function NativeThreadPanelDestination({
  args,
  isOpen,
  setTarget,
}: {
  args: NativePanelTarget["args"];
  isOpen: boolean;
  setTarget: (target: NativePanelTarget | null) => void;
}) {
  const width = useContext(SecondaryPanelWidthPercentAtomContext);
  const minimum = useContext(SecondaryPanelMinimumContext);
  const [ready, setReady] = useState(false);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!node) return;
    setTarget({ node, width, minimum, args, setReady });
    return () => setTarget(null);
  }, [node, setTarget, width, minimum, args]);
  return (
    <>
      {args.presentation === "inline" && !ready ? (
        <ThreadSecondaryPanelInlinePlaceholder
          isOpen={isOpen}
          isConversationCollapsed={args.isMainCollapsed}
          resizablePanelId={args.resizablePanelId}
        />
      ) : null}
      <div className="contents" ref={setNode} />
    </>
  );
}
