import { useEffect, useMemo, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { NO_MACHINE_GROUP_KEY } from "../model/machine-thread-groups.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import {
  CHRONOLOGICAL_CONTAINER_ID,
  resolveSidebarProjectId,
} from "../model/project-thread-groups.js";
import { sectionKeyForThreadSection } from "../model/section-keys.js";
import type { CollapsibleSidebarSectionId } from "../model/sidebar-section-id.js";
import {
  useBbContext,
  useSdk,
  type PluginSidebarThreadsState,
} from "@get-bb/plugin-sdk/app";
import type { OrganizationMode as SidebarOrganizationMode } from "../../shared/preferences.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import {
  revealEnvironmentIdsAtom,
  revealMachineKeysAtom,
  revealProjectIdsAtom,
  revealSidebarSectionIdsAtom,
  revealThreadSectionKeysAtom,
  sidebarOrganizationModeAtom,
} from "../preferences/atoms.js";
import { usePreferencesReady } from "../preferences/PreferencesSync.js";
import { useExpandThreadAncestors } from "./useReadStatusGrouping.js";

interface ThreadSidebarExpansionArgs {
  organizationMode: SidebarOrganizationMode;
  isPinned: boolean;
  thread: Pick<SidebarThread, "host" | "sectionId">;
  sidebarProjectId: string;
  personalProjectId: string | null;
}

interface ThreadSidebarExpansion {
  sectionKey?: string;
  machineKey?: string;
  projectId?: string;
  sidebarSectionId?: CollapsibleSidebarSectionId;
}

export function getThreadSidebarExpansion({
  organizationMode,
  isPinned,
  thread,
  sidebarProjectId,
  personalProjectId,
}: ThreadSidebarExpansionArgs): ThreadSidebarExpansion {
  if (isPinned) {
    return { sidebarSectionId: "pinned" };
  }

  if (organizationMode === "machine") {
    return {
      machineKey: thread.host?.id ?? NO_MACHINE_GROUP_KEY,
    };
  }

  if (organizationMode === "chronological") {
    const sectionKey = sectionKeyForThreadSection(
      CHRONOLOGICAL_CONTAINER_ID,
      thread.sectionId,
    );
    return sectionKey ? { sectionKey } : { sidebarSectionId: "threads" };
  }

  if (sidebarProjectId === personalProjectId) {
    return { sidebarSectionId: "threads" };
  }

  return { projectId: sidebarProjectId };
}

type UnreadTreeRow = NonNullable<
  NonNullable<
    PluginSidebarThreadsState["experimental_activePages"]
  >["unreadTree"]
>[number];

export interface SidebarUnreadEntry {
  id: string;
  parentThreadId: string | null;
  isUnread: boolean;
  isHidden?: boolean;
}

export interface SidebarUnreadRevealState {
  previousUnreadIds: ReadonlySet<string> | null;
}

export const INITIAL_SIDEBAR_UNREAD_REVEAL_STATE: SidebarUnreadRevealState = {
  previousUnreadIds: null,
};

export function stepSidebarUnreadReveal(
  state: SidebarUnreadRevealState,
  {
    selectedThreadId,
    entries,
  }: {
    selectedThreadId: string | undefined;
    entries: readonly SidebarUnreadEntry[] | null;
  },
): { ancestorIds: ReadonlySet<string>; state: SidebarUnreadRevealState } {
  if (entries === null) {
    return { ancestorIds: new Set(), state };
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const unreadIds = new Set<string>();
  const revealIds = new Set<string>();
  for (const entry of entries) {
    if (entry.isHidden || !entry.isUnread) continue;
    unreadIds.add(entry.id);
    if (
      state.previousUnreadIds !== null &&
      !state.previousUnreadIds.has(entry.id) &&
      entry.id !== selectedThreadId
    ) {
      revealIds.add(entry.id);
    }
  }
  const ancestorIds = new Set<string>();
  for (const threadId of revealIds) {
    let parentId = byId.get(threadId)?.parentThreadId ?? null;
    while (parentId !== null && !ancestorIds.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      ancestorIds.add(parent.id);
      parentId = parent.parentThreadId;
    }
  }
  return {
    ancestorIds,
    state: { previousUnreadIds: unreadIds },
  };
}

function toSidebarUnreadEntries(
  unreadTree: readonly UnreadTreeRow[],
): SidebarUnreadEntry[] {
  return unreadTree.map((row) => ({
    id: row.id,
    parentThreadId: row.parentThreadId,
    isUnread: (row.lastReadAt ?? 0) < row.latestAttentionAt,
  }));
}

function hasCompleteSelectedThreadAncestry(
  selectedThreadId: string,
  threadById: ReadonlyMap<string, SidebarThread>,
): boolean {
  let current = threadById.get(selectedThreadId);
  if (!current) return false;
  let remaining = threadById.size;
  while (current.parentThreadId !== null && remaining > 0) {
    const parent = threadById.get(current.parentThreadId);
    if (!parent) return false;
    current = parent;
    remaining -= 1;
  }
  return true;
}

export function useSidebarThreadReveal(): void {
  const sdk = useSdk();
  const { threadId: routedThreadId } = useBbContext();
  const { status, projects, personalProject, activePages } =
    useSidebarData(true);
  const preferencesReady = usePreferencesReady();
  const organizationMode = useAtomValue(sidebarOrganizationModeAtom);
  const expandThreadAncestors = useExpandThreadAncestors();
  const revealEnvironmentIds = useSetAtom(revealEnvironmentIdsAtom);
  const revealProjectIds = useSetAtom(revealProjectIdsAtom);
  const revealMachineKeys = useSetAtom(revealMachineKeysAtom);
  const revealThreadSectionKeys = useSetAtom(revealThreadSectionKeysAtom);
  const revealSidebarSectionIds = useSetAtom(revealSidebarSectionIdsAtom);
  const threads = useMemo<SidebarThread[]>(
    () => projects.flatMap((project) => project.threads),
    [projects],
  );
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const personalProjectId = personalProject?.id ?? null;
  const isPartial = activePages?.hasNextPage === true;
  const unreadEntries = useMemo<readonly SidebarUnreadEntry[] | null>(() => {
    if (status !== "ready") return null;
    if (isPartial) {
      return activePages?.unreadTree
        ? toSidebarUnreadEntries(activePages.unreadTree)
        : null;
    }
    return threads.map((thread) => ({
      id: thread.id,
      parentThreadId: thread.parentThreadId,
      isUnread: thread.isUnread,
      isHidden: thread.isHidden,
    }));
  }, [activePages, isPartial, status, threads]);
  const unreadState = useRef(INITIAL_SIDEBAR_UNREAD_REVEAL_STATE);

  useEffect(() => {
    if (!preferencesReady) return;
    const { ancestorIds, state } = stepSidebarUnreadReveal(
      unreadState.current,
      {
        selectedThreadId: routedThreadId ?? undefined,
        entries: unreadEntries,
      },
    );
    unreadState.current = state;
    if (ancestorIds.size > 0) {
      expandThreadAncestors(ancestorIds, false);
    }
  }, [expandThreadAncestors, preferencesReady, routedThreadId, unreadEntries]);

  const needsTargetedSelectedReveal =
    routedThreadId !== null &&
    routedThreadId !== undefined &&
    preferencesReady &&
    status === "ready" &&
    isPartial &&
    !hasCompleteSelectedThreadAncestry(routedThreadId, threadById);

  useEffect(() => {
    if (!needsTargetedSelectedReveal || !routedThreadId) {
      return;
    }
    const controller = new AbortController();
    const revealSelection = async () => {
      const selected = await sdk.threads.get({
        threadId: routedThreadId,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        selected.archivedAt !== null ||
        selected.deletedAt !== null ||
        selected.visibility === "hidden"
      ) {
        return;
      }
      const { threads: ancestry } =
        await sdk.threads.experimental_listAncestors({
          threadIds: [routedThreadId],
          signal: controller.signal,
        });
      if (controller.signal.aborted) return;
      const ancestorIds =
        ancestry.find((entry) => entry.threadId === routedThreadId)
          ?.ancestorIds ?? [];
      if (ancestorIds.length > 0) {
        expandThreadAncestors(new Set(ancestorIds), true);
      }
      if (selected.environmentId !== null) {
        revealEnvironmentIds(new Set([selected.environmentId]));
      }
      const rootId = ancestorIds[ancestorIds.length - 1];
      const loadedRoot = rootId ? threadById.get(rootId) : undefined;
      let sidebarProjectId = selected.projectId;
      let isPinned = selected.pinnedAt !== null;
      let sectionId = selected.sectionId;
      let host: SidebarThread["host"] = null;
      if (loadedRoot) {
        sidebarProjectId = loadedRoot.projectId;
        isPinned = isPinned || loadedRoot.isPinned;
        sectionId = loadedRoot.sectionId;
        host = loadedRoot.host;
      } else if (rootId) {
        const root = await sdk.threads.get({
          threadId: rootId,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        sidebarProjectId = root.projectId;
        isPinned = isPinned || root.pinnedAt !== null;
        sectionId = root.sectionId;
      }
      const expansion = getThreadSidebarExpansion({
        organizationMode,
        isPinned,
        thread: { host, sectionId },
        sidebarProjectId,
        personalProjectId,
      });
      if (expansion.machineKey) {
        revealMachineKeys(new Set([expansion.machineKey]));
      }
      if (expansion.sectionKey) {
        revealThreadSectionKeys(new Set([expansion.sectionKey]));
      }
      if (expansion.projectId) {
        revealProjectIds(new Set([expansion.projectId]));
      }
      if (expansion.sidebarSectionId) {
        revealSidebarSectionIds(new Set([expansion.sidebarSectionId]));
      }
    };
    void revealSelection().catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [
    expandThreadAncestors,
    needsTargetedSelectedReveal,
    organizationMode,
    personalProjectId,
    revealEnvironmentIds,
    revealMachineKeys,
    revealProjectIds,
    revealSidebarSectionIds,
    revealThreadSectionKeys,
    routedThreadId,
    sdk,
    threadById,
  ]);

  useSidebarThreadRevealCore({
    selectedThreadId: routedThreadId ?? undefined,
    threads,
    threadsReady: status === "ready" && !needsTargetedSelectedReveal,
    preferencesReady,
    personalProjectId,
  });
}

export interface SidebarThreadRevealState {
  previousThreadId: string | undefined;
  pendingNavigation: string | undefined;
}

export const INITIAL_SIDEBAR_THREAD_REVEAL_STATE: SidebarThreadRevealState = {
  previousThreadId: undefined,
  pendingNavigation: undefined,
};

interface SidebarThreadRevealStepInputs {
  selectedThreadId: string | undefined;
  threadById: ReadonlyMap<string, SidebarThread>;
  threadsReady: boolean;
  preferencesReady: boolean;
}

interface SidebarThreadRevealStep {
  state: SidebarThreadRevealState;
  revealIds: ReadonlySet<string>;
  navigationRevealId: string | undefined;
}

export function stepSidebarThreadReveal(
  state: SidebarThreadRevealState,
  {
    selectedThreadId,
    threadById,
    threadsReady,
    preferencesReady,
  }: SidebarThreadRevealStepInputs,
): SidebarThreadRevealStep {
  let { previousThreadId, pendingNavigation } = state;
  if (previousThreadId !== selectedThreadId) {
    previousThreadId = selectedThreadId;
    pendingNavigation = selectedThreadId;
  }
  if (!preferencesReady || !threadsReady) {
    return {
      state: {
        previousThreadId,
        pendingNavigation,
      },
      revealIds: new Set(),
      navigationRevealId: undefined,
    };
  }
  const revealIds = new Set<string>();
  const navigationRevealId = pendingNavigation;
  if (navigationRevealId && threadById.has(navigationRevealId)) {
    revealIds.add(navigationRevealId);
    pendingNavigation = undefined;
  }
  return {
    state: {
      previousThreadId,
      pendingNavigation,
    },
    revealIds,
    navigationRevealId,
  };
}

interface ThreadRevealExpansionArgs {
  thread: SidebarThread;
  threadById: ReadonlyMap<string, SidebarThread>;
  effectivePinnedThreadIds: ReadonlySet<string>;
  organizationMode: SidebarOrganizationMode;
  personalProjectId: string | null;
}

export function resolveThreadRevealExpansion({
  thread,
  threadById,
  effectivePinnedThreadIds,
  organizationMode,
  personalProjectId,
}: ThreadRevealExpansionArgs) {
  const threadIdsToExpand = new Set<string>();
  const environmentIdsToExpand = new Set<string>();
  let currentThread: SidebarThread | undefined = thread;
  let remainingHops = threadById.size;
  while (currentThread && remainingHops > 0) {
    const environmentId = currentThread.environment?.id ?? null;
    if (environmentId !== null) {
      environmentIdsToExpand.add(environmentId);
    }
    const parentThreadId = currentThread.parentThreadId;
    if (parentThreadId === null) {
      break;
    }
    const parentThread = threadById.get(parentThreadId);
    if (!parentThread) {
      break;
    }
    threadIdsToExpand.add(parentThread.id);
    currentThread = parentThread;
    remainingHops -= 1;
  }
  const expansion = getThreadSidebarExpansion({
    organizationMode,
    isPinned: effectivePinnedThreadIds.has(thread.id),
    thread,
    sidebarProjectId: resolveSidebarProjectId(thread, threadById),
    personalProjectId,
  });
  return { threadIdsToExpand, environmentIdsToExpand, expansion };
}

interface SidebarThreadRevealInputs {
  selectedThreadId: string | undefined;
  threads: readonly SidebarThread[];
  threadsReady: boolean;
  preferencesReady: boolean;
  personalProjectId: string | null;
}

function useSidebarThreadRevealCore({
  selectedThreadId,
  threads,
  threadsReady,
  preferencesReady,
  personalProjectId,
}: SidebarThreadRevealInputs): void {
  const organizationMode = useAtomValue(sidebarOrganizationModeAtom);
  const expandThreadAncestors = useExpandThreadAncestors();
  const revealEnvironmentIds = useSetAtom(revealEnvironmentIdsAtom);
  const revealProjectIds = useSetAtom(revealProjectIdsAtom);
  const revealMachineKeys = useSetAtom(revealMachineKeysAtom);
  const revealThreadSectionKeys = useSetAtom(revealThreadSectionKeysAtom);
  const revealSidebarSectionIds = useSetAtom(revealSidebarSectionIdsAtom);
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const effectivePinnedThreadIds = useMemo(
    () => buildPinnedSidebarState({ threads }).effectivePinnedThreadIds,
    [threads],
  );
  const revealState = useRef(INITIAL_SIDEBAR_THREAD_REVEAL_STATE);

  useEffect(() => {
    const step = stepSidebarThreadReveal(revealState.current, {
      selectedThreadId,
      threadById,
      threadsReady,
      preferencesReady,
    });
    revealState.current = step.state;
    for (const threadId of step.revealIds) {
      const thread = threadById.get(threadId);
      if (!thread || thread.isHidden) {
        continue;
      }
      const { threadIdsToExpand, environmentIdsToExpand, expansion } =
        resolveThreadRevealExpansion({
          thread,
          threadById,
          effectivePinnedThreadIds,
          organizationMode,
          personalProjectId,
        });

      expandThreadAncestors(
        threadIdsToExpand,
        threadId === step.navigationRevealId,
      );
      revealEnvironmentIds(environmentIdsToExpand);
      if (expansion.machineKey) {
        revealMachineKeys(new Set([expansion.machineKey]));
      }
      if (expansion.sectionKey) {
        revealThreadSectionKeys(new Set([expansion.sectionKey]));
      }
      if (expansion.projectId) {
        revealProjectIds(new Set([expansion.projectId]));
      }
      if (expansion.sidebarSectionId) {
        revealSidebarSectionIds(new Set([expansion.sidebarSectionId]));
      }
    }
  }, [
    selectedThreadId,
    threadsReady,
    preferencesReady,
    personalProjectId,
    organizationMode,
    threads,
    threadById,
    effectivePinnedThreadIds,
    expandThreadAncestors,
    revealEnvironmentIds,
    revealProjectIds,
    revealMachineKeys,
    revealThreadSectionKeys,
    revealSidebarSectionIds,
  ]);
}
