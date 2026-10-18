import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deviceHandoffExpiredSignalLenientSchema,
  deviceHandoffSignalLenientSchema,
  type DeviceHandoffNoticeSignal,
  type DeviceHandoffShownSignal,
  type DeviceHandoffExpiredSignal,
  type DeviceHandoffSignal,
} from "@bb/server-contract";
import { wsManager } from "@/lib/ws";

type DeviceHandoffQueueSignal =
  | DeviceHandoffSignal
  | DeviceHandoffExpiredSignal
  | DeviceHandoffNoticeSignal;

interface DeviceHandoffQueueEntry {
  order: number;
  threadId: string | null;
  terminalSessionId: string | null;
  signal: DeviceHandoffQueueSignal;
  shownOn?: string;
}

interface QueueProgress {
  position: number;
  total: number;
}

interface DeviceHandoffQueueState {
  partitions: Record<string, DeviceHandoffQueueEntry[]>;
  progressByScope: Record<string, QueueProgress>;
  nextOrder: number;
}

const emptyQueue: DeviceHandoffQueueState = {
  partitions: {},
  progressByScope: {},
  nextOrder: 0,
};

function signalOrigin(signal: DeviceHandoffQueueSignal) {
  if (signal.type === "device-handoff-expired") {
    return {
      threadId: signal.threadId,
      terminalSessionId: signal.terminalSessionId,
    };
  }
  if (signal.type === "device-handoff-notice") {
    return { threadId: signal.threadId, terminalSessionId: null };
  }
  return {
    threadId: signal.request.origin.threadId ?? null,
    terminalSessionId: signal.request.origin.terminalSessionId ?? null,
  };
}

function originKey(origin: {
  threadId: string | null;
  terminalSessionId: string | null;
}): string {
  return JSON.stringify([origin.threadId, origin.terminalSessionId]);
}

function scopeKey(
  entry: Pick<DeviceHandoffQueueEntry, "threadId" | "terminalSessionId">,
): string | null {
  if (entry.threadId !== null) return `thread:${entry.threadId}`;
  if (entry.terminalSessionId !== null) {
    return `terminal:${entry.terminalSessionId}`;
  }
  return null;
}

function entriesForScope(
  queue: DeviceHandoffQueueState,
  scope: string,
): DeviceHandoffQueueEntry[] {
  return Object.values(queue.partitions)
    .flat()
    .filter((entry) => scopeKey(entry) === scope)
    .sort((left, right) => left.order - right.order);
}

function entriesForView(
  queue: DeviceHandoffQueueState,
  threadId: string | null,
  terminalSessionId: string | null,
): DeviceHandoffQueueEntry[] {
  if (threadId === null && terminalSessionId === null) return [];
  return Object.values(queue.partitions)
    .flat()
    .filter(
      (entry) =>
        (entry.threadId !== null && entry.threadId === threadId) ||
        (entry.terminalSessionId !== null &&
          entry.terminalSessionId === terminalSessionId),
    )
    .sort((left, right) => left.order - right.order);
}

function pruneExpiredQueue(
  queue: DeviceHandoffQueueState,
  now: number,
): DeviceHandoffQueueState {
  const allEntries = Object.values(queue.partitions).flat();
  const normalized = allEntries.map((entry) =>
    entry.signal.type === "device-handoff" && entry.signal.expiresAt <= now
      ? {
          ...entry,
          signal: {
            type: "device-handoff-expired" as const,
            id: entry.signal.id,
            threadId: entry.threadId,
            terminalSessionId: entry.terminalSessionId,
          },
        }
      : entry,
  );
  const live = normalized.filter(
    ({ signal }) =>
      signal.type !== "device-handoff-notice" || signal.expiresAt > now,
  );
  if (
    live.length === allEntries.length &&
    normalized.every((entry, index) => entry === allEntries[index])
  )
    return queue;

  const liveIds = new Set(live.map(({ signal }) => signal.id));
  const normalizedById = new Map(
    normalized.map((entry) => [entry.signal.id, entry]),
  );
  const partitions = Object.fromEntries(
    Object.entries(queue.partitions)
      .map(([key, entries]) => [
        key,
        entries
          .filter(({ signal }) => liveIds.has(signal.id))
          .map((entry) => normalizedById.get(entry.signal.id) ?? entry),
      ])
      .filter(([, entries]) => entries.length > 0),
  );
  const progressByScope = { ...queue.progressByScope };
  for (const scope of new Set(allEntries.map(scopeKey).filter(Boolean))) {
    if (!scope) continue;
    const scopeEntries = allEntries
      .filter((entry) => scopeKey(entry) === scope)
      .sort((left, right) => left.order - right.order);
    const liveScopeEntries = scopeEntries.filter(({ signal }) =>
      liveIds.has(signal.id),
    );
    if (liveScopeEntries.length === 0) {
      delete progressByScope[scope];
      continue;
    }
    const firstLiveOrder = liveScopeEntries[0]?.order ?? 0;
    const expiredBeforeCurrent = scopeEntries.filter(
      ({ signal, order }) =>
        (signal.type === "device-handoff" ||
          signal.type === "device-handoff-notice") &&
        signal.expiresAt <= now &&
        order < firstLiveOrder,
    ).length;
    const previous = progressByScope[scope] ?? {
      position: 1,
      total: scopeEntries.length,
    };
    progressByScope[scope] = {
      position: previous.position + expiredBeforeCurrent,
      total: Math.max(
        previous.position + expiredBeforeCurrent,
        previous.total - (scopeEntries.length - liveScopeEntries.length),
      ),
    };
  }
  return { ...queue, partitions, progressByScope };
}

function removeSignal(
  queue: DeviceHandoffQueueState,
  id: string,
): DeviceHandoffQueueState {
  const matching = Object.values(queue.partitions)
    .flat()
    .find((entry) => entry.signal.id === id);
  if (!matching) return queue;
  const partitions = Object.fromEntries(
    Object.entries(queue.partitions)
      .map(([key, entries]) => [
        key,
        entries.filter((entry) => entry.signal.id !== id),
      ])
      .filter(([, entries]) => entries.length > 0),
  );
  const scope = scopeKey(matching);
  if (scope === null) return { ...queue, partitions };
  const remainingCount = entriesForScope(
    { ...queue, partitions },
    scope,
  ).length;
  const progress = queue.progressByScope[scope];
  if (remainingCount === 0) {
    const { [scope]: _, ...progressByScope } = queue.progressByScope;
    return { ...queue, partitions, progressByScope };
  }
  return {
    ...queue,
    partitions,
    progressByScope: progress
      ? {
          ...queue.progressByScope,
          [scope]: {
            position: Math.min(progress.position, remainingCount),
            total: Math.max(remainingCount, progress.total - 1),
          },
        }
      : queue.progressByScope,
  };
}

export function useDeviceHandoffQueue(
  activeThreadId: string | null,
  activeTerminalSessionId: string | null,
) {
  const [queue, setQueue] = useState<DeviceHandoffQueueState>(emptyQueue);
  const expire = useCallback((signal: DeviceHandoffExpiredSignal) => {
    setQueue((current) => {
      const matching = Object.values(current.partitions)
        .flat()
        .find((entry) => entry.signal.id === signal.id);
      if (!matching) return current;
      if (matching.signal.type === "device-handoff-expired") return current;
      if (matching.signal.type !== "device-handoff") {
        return removeSignal(current, signal.id);
      }
      const partitions = Object.fromEntries(
        Object.entries(current.partitions).map(([key, entries]) => [
          key,
          entries.map((entry) =>
            entry.signal.id === signal.id ? { ...entry, signal } : entry,
          ),
        ]),
      );
      return { ...current, partitions };
    });
  }, []);
  const enqueue = useCallback(
    (signal: DeviceHandoffQueueSignal | DeviceHandoffShownSignal) => {
      if (signal.type === "device-handoff-shown") {
        setQueue((current) => {
          const partitions = Object.fromEntries(
            Object.entries(current.partitions).map(([key, entries]) => [
              key,
              entries.map((entry) =>
                entry.signal.id === signal.id
                  ? { ...entry, shownOn: signal.deviceLabel }
                  : entry,
              ),
            ]),
          );
          return { ...current, partitions };
        });
        return;
      }
      const now = Date.now();
      if (
        (signal.type === "device-handoff" ||
          signal.type === "device-handoff-notice") &&
        signal.expiresAt <= now
      )
        return;
      setQueue((current) => {
        const live = pruneExpiredQueue(current, now);
        const allEntries = Object.values(live.partitions).flat();
        const previousEntry = allEntries.find(
          (entry) => entry.signal.id === signal.id,
        );
        if (previousEntry) {
          if (signal.type === "device-handoff") {
            const partitions = Object.fromEntries(
              Object.entries(live.partitions).map(([key, entries]) => [
                key,
                entries.map((entry) =>
                  entry.signal.id === signal.id ? { ...entry, signal } : entry,
                ),
              ]),
            );
            return { ...live, partitions };
          }
          return live;
        }
        const origin = signalOrigin(signal);
        const key = originKey(origin);
        const entry = {
          order: live.nextOrder,
          threadId: origin.threadId,
          terminalSessionId: origin.terminalSessionId,
          signal,
        };
        const scope = scopeKey(entry);
        if (scope === null) return live;
        const scopeEntries = entriesForScope(live, scope);
        const progress = live.progressByScope[scope];
        return {
          partitions: {
            ...live.partitions,
            [key]: [...(live.partitions[key] ?? []), entry],
          },
          progressByScope: {
            ...live.progressByScope,
            [scope]: {
              position: progress?.position ?? 1,
              total: scopeEntries.length === 0 ? 1 : (progress?.total ?? 0) + 1,
            },
          },
          nextOrder: live.nextOrder + 1,
        };
      });
    },
    [],
  );

  useEffect(() => {
    wsManager.setDeviceHandoffView(activeThreadId, activeTerminalSessionId);
    const unsubscribe = wsManager.onDeviceHandoff((signal) => {
      if (signal.type === "device-handoff-acknowledged") {
        setQueue((current) => removeSignal(current, signal.id));
        return;
      }
      if (signal.type === "device-handoff-shown") {
        enqueue(signal);
        return;
      }
      if (signal.type === "device-handoff-expired") {
        expire(signal);
        return;
      }
      enqueue(signal);
    });
    const handleDeviceHandoff = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const parsed = deviceHandoffSignalLenientSchema.safeParse(event.detail);
      if (parsed.success) enqueue(parsed.data);
      const expired = deviceHandoffExpiredSignalLenientSchema.safeParse(
        event.detail,
      );
      if (expired.success) expire(expired.data);
    };
    window.addEventListener("bb-device-handoff", handleDeviceHandoff);
    return () => {
      unsubscribe();
      window.removeEventListener("bb-device-handoff", handleDeviceHandoff);
      wsManager.setDeviceHandoffView(null, null);
    };
  }, [activeThreadId, activeTerminalSessionId, enqueue, expire]);

  useEffect(() => {
    const expiring = Object.values(queue.partitions)
      .flat()
      .map(({ signal }) => signal)
      .filter(
        (signal): signal is DeviceHandoffSignal | DeviceHandoffNoticeSignal =>
          signal.type === "device-handoff" ||
          signal.type === "device-handoff-notice",
      );
    if (expiring.length === 0) return;
    const expiresAt = Math.min(...expiring.map((item) => item.expiresAt));
    const timer = window.setTimeout(
      () => setQueue((current) => pruneExpiredQueue(current, Date.now())),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [queue.partitions]);

  const activeQueue = useMemo(
    () => entriesForView(queue, activeThreadId, activeTerminalSessionId),
    [activeThreadId, activeTerminalSessionId, queue],
  );
  const activeScopes = [
    ...new Set(activeQueue.map(scopeKey).filter((scope) => scope !== null)),
  ];
  const activeProgress =
    activeScopes.length === 0
      ? undefined
      : activeScopes.reduce(
          (progress, scope) => {
            const scopeProgress = queue.progressByScope[scope] ?? {
              position: 1,
              total: entriesForScope(queue, scope).length,
            };
            return {
              position: progress.position + scopeProgress.position - 1,
              total: progress.total + scopeProgress.total,
            };
          },
          { position: 1, total: 0 },
        );
  const dismiss = useCallback(() => {
    setQueue((current) => {
      const live = pruneExpiredQueue(current, Date.now());
      const first = entriesForView(
        live,
        activeThreadId,
        activeTerminalSessionId,
      )[0];
      if (!first) return live;
      const scope = scopeKey(first);
      const partitions = Object.fromEntries(
        Object.entries(live.partitions)
          .map(([key, entries]) => [
            key,
            entries.filter((entry) => entry.signal.id !== first.signal.id),
          ])
          .filter(([, entries]) => entries.length > 0),
      );
      const remainingCount =
        scope === null
          ? 0
          : entriesForScope({ ...live, partitions }, scope).length;
      if (scope === null || remainingCount === 0) {
        const { [scope ?? ""]: _, ...progressByScope } = live.progressByScope;
        return { ...live, partitions, progressByScope };
      }
      const progress = live.progressByScope[scope];
      return {
        ...live,
        partitions,
        progressByScope: progress
          ? {
              ...live.progressByScope,
              [scope]: {
                position: progress.position + 1,
                total: progress.total,
              },
            }
          : live.progressByScope,
      };
    });
  }, [activeThreadId, activeTerminalSessionId]);
  const acknowledge = useCallback((id: string) => {
    wsManager.acknowledgeDeviceHandoff(id);
  }, []);

  const showHere = useCallback(
    async (id: string) => {
      const signal = await import("@/lib/api").then(({ claimDeviceHandoff }) =>
        claimDeviceHandoff(id),
      );
      enqueue(signal);
    },
    [enqueue],
  );

  const activeShownOn = activeQueue[0]?.shownOn;

  return {
    signal: activeQueue[0]?.signal ?? null,
    position: activeProgress?.position ?? 1,
    count: activeProgress?.total ?? 0,
    dismiss,
    acknowledge,
    showHere,
    shownOn: activeShownOn,
  };
}
