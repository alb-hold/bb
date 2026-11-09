import type { ComponentProps } from "react";
import type { ThreadResponse } from "@bb/server-contract";
import type { PluginThreadActionsInlineItem } from "@get-bb/plugin-sdk";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import { ThreadWorkspaceOpenButton } from "@/components/thread/ThreadWorkspaceOpenButton";
import { PluginThreadHeaderActions } from "@/components/plugin/PluginThreadHeaderActions";
import { ThreadContextCardHeaderButton } from "@/components/plugin/PluginThreadContextCard";
import { getThreadDetailActivityIndicator } from "@/lib/thread-activity-label";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import type { useLiveFileOpenTargets } from "@/hooks/useLiveFileOpenTargets";
import type { NativeTerminalThread } from "@bb/server-contract";
import { ThreadDetailHeader } from "./ThreadDetailHeader";

const THREAD_HEADER_ACTIONS_GROUP = "0_header";

type HeaderProps = ComponentProps<typeof ThreadDetailHeader>;
export function ThreadFrameHeader({
  thread,
  threadActionTarget,
  workspaceOpenPath,
  openTargets,
  isSecondaryPanelOpen,
  toggleSecondaryPanel,
  onRequestClose,
  nativeTerminalThread,
  setNativeActivityTarget,
}: {
  thread: ThreadResponse;
  threadActionTarget: HeaderProps["thread"];
  workspaceOpenPath: string | null;
  openTargets: Pick<
    ReturnType<typeof useLiveFileOpenTargets>,
    | "preferredDirectoryTarget"
    | "directoryOpenTargets"
    | "openPathInPreferredDirectoryTarget"
    | "openPathInDirectoryTarget"
  >;
  isSecondaryPanelOpen: boolean;
  toggleSecondaryPanel: () => void;
  onRequestClose: HeaderProps["onClosePane"];
  nativeTerminalThread: NativeTerminalThread | null;
  setNativeActivityTarget: HeaderProps["nativeActivityTargetRef"];
}) {
  const {
    preferredDirectoryTarget,
    directoryOpenTargets,
    openPathInDirectoryTarget,
    openPathInPreferredDirectoryTarget,
  } = openTargets;
  const threadTitle = getThreadDisplayTitle(thread);
  const responsiveWorkspaceActions: PluginThreadActionsInlineItem[] =
    workspaceOpenPath && preferredDirectoryTarget
      ? [
          preferredDirectoryTarget,
          ...directoryOpenTargets.filter(
            (target) => target.id !== preferredDirectoryTarget.id,
          ),
        ].map((target) => ({
          key: `workspace/${target.id}`,
          group: THREAD_HEADER_ACTIONS_GROUP,
          action: {
            icon: "FolderOpen",
            label: `Open workspace in ${target.label}`,
            run: async () => {
              if (target.id === preferredDirectoryTarget.id) {
                await openPathInPreferredDirectoryTarget({
                  lineNumber: null,
                  path: workspaceOpenPath,
                });
                return;
              }
              await openPathInDirectoryTarget({
                lineNumber: null,
                path: workspaceOpenPath,
                rememberTarget: true,
                targetId: target.id,
              });
            },
          },
        }))
      : [];
  const workspaceOpenButton =
    workspaceOpenPath && preferredDirectoryTarget ? (
      <ThreadWorkspaceOpenButton
        preferredTarget={preferredDirectoryTarget}
        targets={directoryOpenTargets}
        onOpenPreferredTarget={async () => {
          await openPathInPreferredDirectoryTarget({
            lineNumber: null,
            path: workspaceOpenPath,
          });
        }}
        onOpenTarget={async (targetId) => {
          await openPathInDirectoryTarget({
            lineNumber: null,
            path: workspaceOpenPath,
            rememberTarget: true,
            targetId,
          });
        }}
      />
    ) : undefined;
  return (
    <ThreadDetailHeader
      actionsMenu={({
        includeResponsiveActions,
        terminalSearchActions,
        headerActions,
        requestRename,
        onCloseAutoFocus,
      }) => (
        <ThreadActionsMenu
          thread={threadActionTarget}
          trigger={(triggerProps) => (
            <Button
              {...triggerProps}
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                triggerProps.className,
                "rounded-md p-0",
                "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
                HEADER_ICON_BUTTON_CLASS,
              )}
              aria-label="Thread actions"
              data-compact-touch="header"
              onClick={(event) => {
                triggerProps.onClick?.(event);
                event.stopPropagation();
              }}
            >
              <Icon
                name="MoreHorizontal"
                className={COARSE_POINTER_ICON_SIZE_CLASS}
              />
            </Button>
          )}
          inline={[
            ...terminalSearchActions,
            ...(includeResponsiveActions
              ? [
                  ...responsiveWorkspaceActions,
                  ...headerActions.map(
                    ({ key, action }): PluginThreadActionsInlineItem => ({
                      key,
                      group: THREAD_HEADER_ACTIONS_GROUP,
                      action: { ...action, run: () => action.run() },
                    }),
                  ),
                ]
              : []),
          ]}
          requestRename={requestRename}
          onCloseAutoFocus={onCloseAutoFocus}
        />
      )}
      isSecondaryPanelOpen={isSecondaryPanelOpen}
      onClosePane={onRequestClose ?? undefined}
      onToggleSecondaryPanel={toggleSecondaryPanel}
      pluginActions={
        <PluginThreadHeaderActions
          threadId={thread.id}
          projectId={thread.projectId}
        />
      }
      thread={threadActionTarget}
      threadTitle={threadTitle}
      activityIndicator={getThreadDetailActivityIndicator(thread)}
      needsInput={thread.nativeTerminal && thread.hasPendingInteraction}
      hasNativeTerminal={nativeTerminalThread != null}
      nativeActivityTargetRef={setNativeActivityTarget}
      checkTerminal={nativeTerminalThread?.terminal?.attention != null}
      contextCardButton={<ThreadContextCardHeaderButton />}
      workspaceOpenButton={workspaceOpenButton}
    />
  );
}
