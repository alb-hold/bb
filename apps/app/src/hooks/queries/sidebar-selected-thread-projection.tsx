import { createContext, useContext, useMemo, type ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { ThreadListEntry } from "@bb/domain";
import {
  THREAD_LIST_MAX_IDS,
  type SidebarBootstrapResponse,
} from "@bb/server-contract";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { sdk } from "@/lib/sdk";
import {
  sidebarNavigationQueryKey,
  sidebarSelectedThreadTargetQueryKey,
} from "./query-keys";
import { useSidebarNavigationPreview } from "./sidebar-navigation-query";

const SelectedSidebarThreadIdContext = createContext<string | undefined>(
  undefined,
);

export function SelectedSidebarThreadIdProvider({
  threadId,
  children,
}: {
  threadId: string | undefined;
  children: ReactNode;
}) {
  return (
    <SelectedSidebarThreadIdContext.Provider value={threadId}>
      {children}
    </SelectedSidebarThreadIdContext.Provider>
  );
}

export function useSelectedSidebarThreadId(): string | undefined {
  return useContext(SelectedSidebarThreadIdContext);
}

function hasSelectedThreadAncestryInBootstrap(
  selectedThreadId: string,
  navigation: SidebarBootstrapResponse,
): boolean {
  const threads = listSidebarNavigationThreads(navigation);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  let current = byId.get(selectedThreadId);
  if (!current) return false;
  let remaining = byId.size;
  while (current.parentThreadId !== null && remaining > 0) {
    const parent = byId.get(current.parentThreadId);
    if (!parent) return false;
    current = parent;
    remaining -= 1;
  }
  return true;
}

export function mergeSidebarSelectedTargetRows(
  preview: SidebarBootstrapResponse | null | undefined,
  selectedRows: readonly ThreadListEntry[] | undefined,
): SidebarBootstrapResponse | null | undefined {
  if (!preview || !selectedRows || selectedRows.length === 0) {
    return preview;
  }
  const existingIds = new Set(
    listSidebarNavigationThreads(preview).map((thread) => thread.id),
  );
  const additionsByProjectId = new Map<string, ThreadListEntry[]>();
  for (const row of selectedRows) {
    if (
      row.archivedAt !== null ||
      row.deletedAt !== null ||
      row.visibility === "hidden" ||
      existingIds.has(row.id)
    ) {
      continue;
    }
    existingIds.add(row.id);
    const bucket = additionsByProjectId.get(row.projectId);
    if (bucket) {
      bucket.push(row);
    } else {
      additionsByProjectId.set(row.projectId, [row]);
    }
  }
  if (additionsByProjectId.size === 0) {
    return preview;
  }
  const personalAdditions = additionsByProjectId.get(
    preview.personalProject.id,
  );
  const nextPersonalProject = personalAdditions
    ? {
        ...preview.personalProject,
        threads: [...preview.personalProject.threads, ...personalAdditions],
      }
    : preview.personalProject;
  let projectsChanged = false;
  const nextProjects = preview.projects.map((project) => {
    const additions = additionsByProjectId.get(project.id);
    if (!additions) return project;
    projectsChanged = true;
    return {
      ...project,
      threads: [...project.threads, ...additions],
    };
  });
  if (!personalAdditions && !projectsChanged) {
    return preview;
  }
  return {
    ...preview,
    personalProject: nextPersonalProject,
    projects: projectsChanged ? nextProjects : preview.projects,
  };
}

export function useSidebarNavigationPreviewWithSelected(
  selectedThreadId: string | undefined,
): SidebarBootstrapResponse | null | undefined {
  const preview = useSidebarNavigationPreview();
  const completeQuery = useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: skipToken,
    enabled: false,
    staleTime: Infinity,
  });
  const needsTarget =
    selectedThreadId !== undefined &&
    completeQuery.data === undefined &&
    preview !== null &&
    preview !== undefined &&
    !hasSelectedThreadAncestryInBootstrap(selectedThreadId, preview);
  const targetQuery = useQuery<ThreadListEntry[]>({
    queryKey: sidebarSelectedThreadTargetQueryKey(selectedThreadId ?? ""),
    queryFn: async ({ signal }) => {
      if (!selectedThreadId) return [];
      const selectedRows = await sdk.threads.list({
        archived: false,
        threadIds: [selectedThreadId],
        limit: 1,
        signal,
      });
      const selected = selectedRows.find((row) => row.id === selectedThreadId);
      if (
        !selected ||
        selected.archivedAt !== null ||
        selected.deletedAt !== null ||
        selected.visibility === "hidden"
      ) {
        return [];
      }
      if (selected.parentThreadId === null) {
        return [selected];
      }
      if (
        preview &&
        hasSelectedThreadAncestryInBootstrap(selected.parentThreadId, preview)
      ) {
        return [selected];
      }
      const { threads: ancestry } =
        await sdk.threads.experimental_listAncestors({
          threadIds: [selectedThreadId],
          signal,
        });
      const ancestorIds =
        ancestry.find((entry) => entry.threadId === selectedThreadId)
          ?.ancestorIds ?? [];
      const loadedIds = new Set(
        preview
          ? listSidebarNavigationThreads(preview).map((thread) => thread.id)
          : [],
      );
      loadedIds.add(selectedThreadId);
      const missing = ancestorIds.filter((id) => !loadedIds.has(id));
      const rows = [selected];
      for (let start = 0; start < missing.length; start += THREAD_LIST_MAX_IDS) {
        const threadIds = missing.slice(start, start + THREAD_LIST_MAX_IDS);
        rows.push(...await sdk.threads.list({
          archived: false,
          threadIds,
          limit: threadIds.length,
          signal,
        }));
      }
      return rows;
    },
    enabled: needsTarget,
    staleTime: 10_000,
  });

  return useMemo(
    () =>
      mergeSidebarSelectedTargetRows(
        preview,
        needsTarget ? targetQuery.data : undefined,
      ),
    [needsTarget, preview, targetQuery.data],
  );
}
