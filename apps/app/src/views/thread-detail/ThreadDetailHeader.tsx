import type { ThreadListIndicatorKind } from "@bb/client-core";
import { ThreadActivityLabel } from "@/components/thread/ThreadActivityLabel";
import { preloadThreadSecondaryPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Button } from "@bb/shared-ui/button";
import { useAtomValue } from "jotai";
import type {
  PluginThreadActionEntry,
  PluginThreadActionsInlineItem,
  PluginThreadActionTarget,
} from "@get-bb/plugin-sdk";
import { COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { SplitButton } from "@/components/ui/split-button.js";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import {
  getBbDesktopInfo,
  MACOS_TITLE_BAR_TRAILING_TOGGLE_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { useIsSidebarFramed } from "@/components/ui/sidebar.js";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useAppCommandRunner,
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { useSidebarRename } from "@/components/sidebar/SidebarInlineRename";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { ThreadTitle } from "@/components/thread/ThreadTitleMentions";
import { ThreadStatusGlyph } from "@/components/thread/ThreadStatusGlyph";
import { ThreadUsageAndAgents } from "@/components/thread/ThreadUsageSummary";
import { useThreadHeaderActionEntries } from "@/lib/thread-actions/thread-action-registry";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import {
  RIGHT_PANEL_TOGGLE_ICON_NAME,
  RIGHT_PANEL_TOGGLE_SHORTCUT_HINT_CLASS,
} from "@/components/secondary-panel/panelToggleControlState";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@bb/shared-ui/context-selection";
import { usePaneContext } from "./PaneContext";
import { PaneMaximizeButton } from "./PaneMaximizeButton";

const THREAD_HEADER_ACTION_BUTTON_CLASS = cn(
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
  "border-border/70 bg-transparent font-normal hover:bg-state-hover",
);
const NARROW_SPLIT_HEADER_MAX_WIDTH = 560;

export interface ThreadDetailHeaderActionsMenuArgs {
  includeResponsiveActions: boolean;
  terminalSearchActions: PluginThreadActionsInlineItem[];
  headerActions: readonly PluginThreadActionEntry[];
  requestRename: (threadId: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}

interface ThreadDetailHeaderProps {
  actionsMenu: ((args: ThreadDetailHeaderActionsMenuArgs) => ReactNode) | null;
  contextCardButton?: ReactNode;
  isSecondaryPanelOpen: boolean;
  onClosePane?: () => void;
  onToggleSecondaryPanel: () => void;
  pluginActions?: ReactNode;
  thread: PluginThreadActionTarget;
  threadTitle: string;
  activityIndicator?: ThreadListIndicatorKind;
  needsInput?: boolean;
  checkTerminal?: boolean;
  hasNativeTerminal?: boolean;
  nativeActivityTargetRef?: Ref<HTMLDivElement>;
  workspaceOpenButton?: ReactNode;
}

export function ThreadDetailHeader({
  actionsMenu,
  isSecondaryPanelOpen,
  onClosePane,
  onToggleSecondaryPanel,
  pluginActions,
  thread,
  threadTitle,
  activityIndicator = "none",
  needsInput = false,
  checkTerminal = false,
  hasNativeTerminal = false,
  nativeActivityTargetRef,
  workspaceOpenButton,
  contextCardButton,
}: ThreadDetailHeaderProps) {
  const commandRunner = useAppCommandRunner();
  const findShortcut = useAppCommandShortcut("terminal.find");
  const isCompactViewport = useIsCompactViewport();
  const threadId = thread.id;
  const headerActions = useThreadHeaderActionEntries(thread);
  const [primaryAction, ...secondaryActions] = headerActions;
  const { renameThreadAsync } = useThreadActions();
  const handleRename = useCallback(
    (nextTitle: string) => renameThreadAsync(threadId, nextTitle),
    [renameThreadAsync, threadId],
  );
  const {
    editor,
    isEditing,
    startEditing,
    startEditingFromDoubleClick,
    startEditingFromMenu,
    onCloseAutoFocus,
  } = useSidebarRename({
    kind: "thread",
    id: threadId,
    name: threadTitle,
    label: "Thread name",
    onSave: handleRename,
  });
  const [desktopInfo] = useState(getBbDesktopInfo);
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const panelShortcut = useAppCommandShortcut("panel.toggle");
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const isSidebarFramed = useIsSidebarFramed();
  const headerRef = useRef<HTMLElement>(null!);
  const {
    beginPaneDrag,
    isFocused,
    isTopRow,
    ownsWindowTopLeft,
    reservesWindowPanelToggle,
    secondaryPanelHost,
  } = usePaneContext();
  useAppCommandHandler("thread.rename", () => {
    if (!isFocused) return false;
    startEditing();
    return true;
  });
  const isWindowPanelOpen =
    useContext(SecondaryPanelHostLayoutContext)?.isOpen === true;
  const isSplitPaneHeader = beginPaneDrag !== undefined;
  const [measuredPaneWidth, setMeasuredPaneWidth] = useState(0);
  const usesResponsiveActionOverflow =
    (isSplitPaneHeader || isCompactViewport) &&
    measuredPaneWidth > 0 &&
    measuredPaneWidth < NARROW_SPLIT_HEADER_MAX_WIDTH;
  const usesCompactAgentDrawer =
    isCompactViewport ||
    (measuredPaneWidth > 0 &&
      measuredPaneWidth < NARROW_SPLIT_HEADER_MAX_WIDTH);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const pane = header.closest<HTMLElement>("[data-split-pane-id]");
    const measuredElement = isSplitPaneHeader ? (pane ?? header) : header;
    const measure = () => {
      const width = measuredElement.getBoundingClientRect().width;
      if (width > 0) {
        setMeasuredPaneWidth(width);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(measuredElement);
    return () => {
      observer.disconnect();
    };
  }, [isSplitPaneHeader]);
  const handleTitlePointerDown = (event: ReactPointerEvent) => {
    if (isEditing || !beginPaneDrag || event.button !== 0) {
      return;
    }
    beginPaneDrag(event, threadTitle);
  };
  const handleTitleDoubleClick = () => {
    if (!isEditing) startEditingFromDoubleClick();
  };
  const [searchFits, setSearchFits] = useState<boolean | null>(null);
  const searchInMenu =
    actionsMenu !== null &&
    (searchFits === null
      ? measuredPaneWidth > 0 && measuredPaneWidth <= 360
      : !searchFits);
  useLayoutEffect(() => {
    if (!hasNativeTerminal) return;
    const header = headerRef.current;
    const title = header.querySelector(
      "[data-thread-detail-header-title]",
    )?.parentElement;
    const titleWidth = title?.getBoundingClientRect().width ?? 0;
    if (titleWidth <= 0) return;
    const searchWidth =
      header
        .querySelector("[data-terminal-search-trigger]")
        ?.getBoundingClientRect().width ?? 0;
    const available = titleWidth + (searchWidth > 0 ? searchWidth + 4 : 0);
    setSearchFits(available >= 120 + 44 + 4);
  }, [hasNativeTerminal, measuredPaneWidth, searchInMenu]);
  const searchTerminal = () => {
    const pane =
      headerRef.current.closest("[data-split-pane-id]") ??
      headerRef.current.parentElement;
    commandRunner.dispatch(
      "terminal.find",
      pane?.querySelector("[data-terminal-renderer]") ?? null,
    );
  };
  const rightPanelIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;
  const mountRightPanelToggle = secondaryPanelHost === null;
  const showRightPanelToggle =
    mountRightPanelToggle && (!isSecondaryPanelOpen || isCompactViewport);
  const rightPanelLabel =
    isSecondaryPanelOpen && showRightPanelToggle
      ? "Hide right panel"
      : "Show right panel";

  const center = (
    <>
      <div
        data-pane-header-focus-tab={
          isSplitPaneHeader && isFocused ? "" : undefined
        }
        className={cn(
          "@container/thread-header relative flex min-w-0 flex-1 items-center gap-2",
          isSplitPaneHeader && "-my-1 -ml-2 rounded-md px-2 py-1",
          isSplitPaneHeader && isFocused && CONTEXT_SELECTION_SURFACE_CLASS,
        )}
      >
        {(needsInput || checkTerminal) && !hasNativeTerminal ? (
          <ThreadStatusGlyph
            indicator={needsInput ? "needs-input" : "check-terminal"}
            size="compact"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <p
            data-thread-detail-header-title=""
            className={cn(
              "relative min-w-0 max-w-full flex-1 truncate text-sm font-normal transition-colors",
              isEditing && "overflow-visible",
              isSplitPaneHeader &&
                !isFocused &&
                dimsInactiveSplits &&
                CONTEXT_INACTIVE_TEXT_CLASS,
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
              beginPaneDrag &&
                !isEditing &&
                "cursor-grab touch-none select-none",
            )}
            onDoubleClick={handleTitleDoubleClick}
            onPointerDown={beginPaneDrag ? handleTitlePointerDown : undefined}
          >
            {isEditing ? editor : <ThreadTitle title={threadTitle} />}
          </p>
          {hasNativeTerminal ? (
            <div ref={nativeActivityTargetRef} className="h-4 shrink-0" />
          ) : (
            <ThreadActivityLabel
              indicator={
                needsInput
                  ? "needs-input"
                  : checkTerminal
                    ? "check-terminal"
                    : activityIndicator
              }
            />
          )}
        </div>
        <ThreadUsageAndAgents
          compact={usesCompactAgentDrawer}
          compactSummary={!isCompactViewport}
          threadId={threadId}
        />
      </div>
      {actionsMenu == null ? null : (
        <span
          className={cn(
            "flex items-center",
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
          )}
        >
          {actionsMenu({
            includeResponsiveActions: usesResponsiveActionOverflow,
            terminalSearchActions:
              hasNativeTerminal && searchInMenu
                ? [
                    {
                      key: "terminal-search",
                      group: "terminal",
                      action: {
                        icon: "Search",
                        label: "Search terminal output",
                        run: searchTerminal,
                      },
                    },
                  ]
                : [],
            headerActions,
            requestRename: startEditingFromMenu,
            onCloseAutoFocus,
          })}
        </span>
      )}
    </>
  );

  const actions = (
    <>
      <div
        className="flex items-center gap-1"
        data-thread-header-workflow-actions=""
      >
        {hasNativeTerminal && !searchInMenu ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={HEADER_ICON_BUTTON_CLASS}
            data-compact-touch="header"
            data-terminal-search-trigger=""
            aria-label="Search terminal output"
            aria-keyshortcuts={findShortcut?.ariaKeyshortcuts}
            onClick={searchTerminal}
          >
            <Icon name="Search" className="size-4" />
          </Button>
        ) : null}
        {pluginActions}
        {!usesResponsiveActionOverflow && workspaceOpenButton ? (
          <span className="inline-flex" data-thread-header-responsive-action="">
            {workspaceOpenButton}
          </span>
        ) : null}
        {!usesResponsiveActionOverflow && primaryAction ? (
          <span className="inline-flex" data-thread-header-responsive-action="">
            {secondaryActions.length > 0 ? (
              <SplitButton
                className={THREAD_HEADER_ACTION_BUTTON_CLASS}
                primaryAction={{
                  disabled: primaryAction.action.disabled,
                  label: primaryAction.action.label,
                  onSelect: () => void primaryAction.action.run(),
                }}
                secondaryActions={secondaryActions.map(({ key, action }) => ({
                  id: key,
                  disabled: action.disabled,
                  label: action.label,
                  onSelect: () => void action.run(),
                }))}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={THREAD_HEADER_ACTION_BUTTON_CLASS}
                disabled={primaryAction.action.disabled}
                onClick={() => void primaryAction.action.run()}
              >
                {primaryAction.action.label}
              </Button>
            )}
          </span>
        ) : null}
      </div>
      <div
        className="ml-1 flex items-center gap-0.5"
        data-thread-header-pane-actions=""
      >
        <PaneMaximizeButton />
        {onClosePane ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
              CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            )}
            aria-label="Close pane"
            onClick={onClosePane}
          >
            <Icon name="CloseThreadPane" />
          </Button>
        ) : null}
        {contextCardButton}
        {mountRightPanelToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HEADER_ICON_BUTTON_CLASS,
              CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
              "relative",
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
              isTopRow &&
                isSidebarFramed &&
                MACOS_TITLE_BAR_TRAILING_TOGGLE_CLASS,
              !showRightPanelToggle && "hidden",
            )}
            inert={!showRightPanelToggle}
            data-compact-touch="header"
            aria-label={
              panelShortcut
                ? `${rightPanelLabel} (${panelShortcut.label})`
                : rightPanelLabel
            }
            aria-keyshortcuts={panelShortcut?.ariaKeyshortcuts}
            aria-expanded={isSecondaryPanelOpen}
            onPointerEnter={preloadThreadSecondaryPanel}
            onFocus={preloadThreadSecondaryPanel}
            onPointerDown={preloadThreadSecondaryPanel}
            onClick={onToggleSecondaryPanel}
          >
            <Icon name={rightPanelIconName} />
            <AppCommandShortcutHint
              shortcut={panelShortcut}
              className={RIGHT_PANEL_TOGGLE_SHORTCUT_HINT_CLASS}
            />
          </Button>
        ) : null}
        {reservesWindowPanelToggle && !isWindowPanelOpen ? (
          <span
            aria-hidden
            className={cn(
              HEADER_ICON_BUTTON_CLASS,
              isTopRow &&
                isSidebarFramed &&
                MACOS_TITLE_BAR_TRAILING_TOGGLE_CLASS,
            )}
          />
        ) : null}
      </div>
    </>
  );

  return (
    <AppPageHeader
      headerRef={headerRef}
      center={center}
      centerClassName="flex-1"
      actions={actions}
      isWindowDragRegion={isTopRow}
      ownsWindowTopLeft={ownsWindowTopLeft}
      className={beginPaneDrag ? "z-[21]" : undefined}
    />
  );
}
