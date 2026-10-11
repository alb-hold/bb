import { useLayoutEffect, useMemo, useRef } from "react";
import { useAtomValue, useStore } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { appToast } from "@/components/ui/app-toast";
import {
  experimental_THREAD_ACTION_GROUPS as GROUPS,
  type PluginThreadActionRegistration,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { useRouteState } from "@/hooks/useRouteState";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { resolveThread, useSidebarThreads } from "@/lib/plugin-sidebar-hooks";
import { getThreadRoutePath } from "@/lib/route-paths";
import {
  countPanes,
  findPaneByThread,
  isAtPaneLimit,
  listPanes,
  PANE_LIMIT_DESCRIPTION,
  PANE_LIMIT_TITLE,
  type SplitLayout,
  type SplitSide,
} from "@/lib/split-layout";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { notifyPaneLimit } from "@/lib/split-layout/notifyPaneLimit";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";

function coreThreadAction<Data>(
  registration: PluginThreadActionRegistration<Data>,
): PluginThreadActionRegistration<unknown> {
  return registration;
}

export function getThreadUrl(thread: PluginThreadActionTarget): string {
  return new URL(
    getThreadRoutePath({ projectId: thread.projectId, threadId: thread.id }),
    window.location.origin,
  ).toString();
}

interface SplitAvailability {
  available: boolean;
  focusedThreadId: string | null;
  otherPaneThreadIds: ReadonlySet<string>;
  layout: SplitLayout | null;
  openInSplit: (thread: PluginThreadActionTarget, side: SplitSide) => void;
}

function splitBlockedByPaneLimit(
  layout: SplitLayout | null,
  thread: PluginThreadActionTarget,
): boolean {
  return (
    isAtPaneLimit(layout) &&
    (layout === null ||
      findPaneByThread(layout.root, thread.projectId, thread.id) === null)
  );
}

const SPLIT_SIDE_CHOICES: readonly { id: SplitSide; label: string }[] = [
  { id: "top", label: "Open above" },
  { id: "bottom", label: "Open below" },
];

function useSplitAvailability(): SplitAvailability {
  const isCompact = useIsCompactViewport();
  const layout = useAtomValue(splitLayoutAtom);
  const store = useStore();
  const routeNavigate = useRouteNavigate();
  const { threadId } = useRouteState();
  const panes =
    layout !== null && countPanes(layout.root) > 1 ? listPanes(layout.root) : [];
  const focusedPane = panes.find(
    (pane) => pane.paneId === layout?.focusedPaneId,
  );
  const focusedThreadId =
    panes.length === 0
      ? (threadId ?? null)
      : focusedPane?.content.kind === "thread"
        ? focusedPane.content.threadId
        : null;
  const otherPaneThreadIdsKey = panes
    .flatMap((pane) =>
      pane !== focusedPane && pane.content.kind === "thread"
        ? [pane.content.threadId]
        : [],
    )
    .join("\n");
  return useMemo(
    () => ({
      available: !isCompact,
      focusedThreadId,
      otherPaneThreadIds: new Set(
        otherPaneThreadIdsKey === "" ? [] : otherPaneThreadIdsKey.split("\n"),
      ),
      layout,
      openInSplit: (thread: PluginThreadActionTarget, side: SplitSide) =>
        notifyPaneLimit(
          openThreadInSplit({
            store,
            navigate: routeNavigate,
            projectId: thread.projectId,
            threadId: thread.id,
            isCompact,
            side,
          }),
        ),
    }),
    [
      focusedThreadId,
      isCompact,
      layout,
      otherPaneThreadIdsKey,
      routeNavigate,
      store,
    ],
  );
}

interface ProjectMoveData {
  projects: readonly { id: string; name: string }[];
  viewedThreadId: string | null;
  showMovedThread: (threadId: string, projectId: string) => void;
}

function useProjectMoveData(): ProjectMoveData {
  const { projects } = useSidebarThreads();
  const { threadId } = useRouteState();
  const navigate = useNavigate();
  const projectsKey = JSON.stringify(
    projects.map((project) => [project.id, project.name]),
  );
  return useMemo(
    () => ({
      projects: (JSON.parse(projectsKey) as [string, string][]).map(
        ([id, name]) => ({ id, name }),
      ),
      viewedThreadId: threadId ?? null,
      showMovedThread: (movedThreadId: string, projectId: string) =>
        navigate(getThreadRoutePath({ projectId, threadId: movedThreadId }), {
          replace: true,
        }),
    }),
    [navigate, projectsKey, threadId],
  );
}

function afterMenuCloses(run: () => void): void {
  window.setTimeout(run, 0);
}

interface LifecycleHandlers {
  archive: (threadId: string) => Promise<void>;
  requestDelete: (threadId: string) => Promise<void>;
}

function useLifecycleHandlers(): LifecycleHandlers {
  const actions = useThreadActions();
  const queryClient = useQueryClient();
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });
  return useMemo(
    () => ({
      archive: async (threadId: string) => {
        try {
          latest.current.requestArchive(
            await resolveThread(queryClient, threadId),
          );
        } catch (error) {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to archive thread.",
          });
        }
      },
      requestDelete: async (threadId: string) => {
        try {
          latest.current.requestDelete(
            await resolveThread(queryClient, threadId),
          );
        } catch (error) {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to delete thread.",
          });
        }
      },
    }),
    [queryClient],
  );
}

export const CORE_THREAD_ACTIONS: readonly PluginThreadActionRegistration<unknown>[] =
  [
    coreThreadAction({
      id: "split",
      group: GROUPS.open,
      title: "Open beside",
      icon: "Columns2",
      useData: useSplitAvailability,
      item: ({ thread, data }) => {
        if (!data.available || data.focusedThreadId === thread.id) return null;
        if (splitBlockedByPaneLimit(data.layout, thread)) {
          return {
            label: "Open beside",
            detail: `${PANE_LIMIT_TITLE}. ${PANE_LIMIT_DESCRIPTION}`,
            icon: "Columns2",
            disabled: true,
            run: () => undefined,
          };
        }
        return {
          label: data.otherPaneThreadIds.has(thread.id)
            ? "Focus split"
            : "Open beside",
          icon: "Columns2",
          run: () => data.openInSplit(thread, "right"),
        };
      },
    }),
    coreThreadAction({
      id: "splitVertical",
      group: GROUPS.open,
      title: "Open above or below",
      icon: "Rows2",
      useData: useSplitAvailability,
      item: ({ thread, data }) =>
        !data.available ||
        data.focusedThreadId === thread.id ||
        data.otherPaneThreadIds.has(thread.id) ||
        splitBlockedByPaneLimit(data.layout, thread)
          ? null
          : {
              label: "Open above or below",
              icon: "Rows2",
              choices: {
                items: SPLIT_SIDE_CHOICES.map((choice) => ({
                  id: choice.id,
                  label: choice.label,
                  icon: choice.id === "top" ? "ArrowUp" : "ArrowDown",
                })),
              },
              run: ({ value }) => {
                const side = SPLIT_SIDE_CHOICES.find(
                  (choice) => choice.id === value,
                )?.id;
                if (side !== undefined) data.openInSplit(thread, side);
              },
            },
    }),
    coreThreadAction({
      id: "newThreadInEnvironment",
      group: GROUPS.organize,
      order: 10,
      title: "New thread in environment",
      icon: "MessageSquarePlus",
      useData: useIsCompactViewport,
      item: ({ thread, data: isCompact, navigate }) => {
        const environment = thread.environment;
        if (!isCompact || environment === null || environment.path === null) {
          return null;
        }
        return {
          label: "New thread in environment",
          icon: "MessageSquarePlus",
          run: () =>
            navigate.toCompose({
              projectId: thread.projectId,
              environmentId: environment.id,
              placement: {
                sectionId: thread.sectionId,
                pinned: thread.pinnedAt !== null,
              },
              focusPrompt: true,
            }),
        };
      },
    }),
    coreThreadAction({
      id: "copyLink",
      group: GROUPS.organize,
      order: 20,
      title: "Copy thread link",
      icon: "Copy",
      item: ({ thread }) => ({
        label: "Copy thread link",
        icon: "Copy",
        run: () =>
          copyToClipboardWithToast(getThreadUrl(thread), {
            successMessage: "Thread link copied",
            errorMessage: "Failed to copy thread link",
          }).then(() => undefined),
      }),
    }),
    coreThreadAction({
      id: "read",
      group: GROUPS.organize,
      order: 30,
      title: "Mark read / unread",
      icon: "MailOpen",
      item: ({ thread, sdk }) => ({
        label: thread.isUnread ? "Mark read" : "Mark unread",
        icon: thread.isUnread ? "MailOpen" : "Mail",
        run: async () => {
          try {
            if (thread.isUnread) {
              await sdk.threads.markRead({ threadId: thread.id });
            } else {
              await sdk.threads.markUnread({ threadId: thread.id });
            }
          } catch (error) {
            showMutationErrorToast({
              error,
              fallbackMessage: thread.isUnread
                ? "Failed to mark thread read"
                : "Failed to mark thread unread",
            });
          }
        },
      }),
    }),
    coreThreadAction({
      id: "pin",
      group: GROUPS.organize,
      order: 40,
      title: "Pin",
      icon: "Pin",
      item: ({ thread, sdk }) => {
        const isPinned = thread.pinnedAt !== null;
        return {
          label: isPinned ? "Unpin" : "Pin",
          icon: isPinned ? "PinOff" : "Pin",
          run: async () => {
            try {
              if (isPinned) {
                await sdk.threads.unpin({ threadId: thread.id });
              } else {
                await sdk.threads.pin({ threadId: thread.id });
              }
            } catch (error) {
              showMutationErrorToast({
                error,
                fallbackMessage: isPinned
                  ? "Failed to unpin thread."
                  : "Failed to pin thread.",
              });
            }
          },
        };
      },
    }),
    coreThreadAction({
      id: "moveToProject",
      group: GROUPS.organize,
      order: 55,
      title: "Move to project",
      icon: "FolderOpen",
      useData: useProjectMoveData,
      item: ({ thread, data, sdk }) => {
        if (data.projects.length < 2) return null;
        return {
          label: "Move to project",
          icon: "FolderOpen",
          choices: {
            heading: "Move to project",
            items: data.projects.map((project) => ({
              id: project.id,
              label: project.name,
              selected: project.id === thread.projectId,
              disabled: project.id === thread.projectId,
            })),
          },
          run: async ({ value }) => {
            if (value === undefined || value === thread.projectId) return;
            try {
              await sdk.threads.experimental_moveToProject({
                threadId: thread.id,
                projectId: value,
              });
              appToast.success("Thread moved to project");
              if (data.viewedThreadId === thread.id) {
                data.showMovedThread(thread.id, value);
              }
            } catch (error) {
              showMutationErrorToast({
                error,
                fallbackMessage: "Thread could not be moved.",
              });
            }
          },
        };
      },
    }),
    coreThreadAction({
      id: "rename",
      group: GROUPS.organize,
      order: 60,
      title: "Rename",
      icon: "Edit",
      item: ({ thread }) => ({
        label: "Rename",
        icon: "Edit",
        run: ({ requestRename }) => requestRename(thread.id),
      }),
    }),
    coreThreadAction({
      id: "archive",
      group: GROUPS.lifecycle,
      title: "Archive",
      icon: "Archive",
      useData: useLifecycleHandlers,
      item: ({ thread, data, sdk }) => {
        const isArchived = thread.archivedAt !== null;
        return {
          label: isArchived ? "Unarchive" : "Archive",
          icon: isArchived ? "ArchiveRestore" : "Archive",
          run: async () => {
            if (!isArchived) {
              afterMenuCloses(() => void data.archive(thread.id));
              return;
            }
            try {
              await sdk.threads.unarchive({ threadId: thread.id });
            } catch (error) {
              showMutationErrorToast({
                error,
                fallbackMessage: "Failed to unarchive thread.",
              });
            }
          },
        };
      },
    }),
    coreThreadAction({
      id: "delete",
      group: GROUPS.lifecycle,
      title: "Delete",
      icon: "Trash2",
      useData: useLifecycleHandlers,
      item: ({ thread, data }) => ({
        label: "Delete",
        icon: "Trash2",
        variant: "destructive",
        run: () => afterMenuCloses(() => void data.requestDelete(thread.id)),
      }),
    }),
  ];
