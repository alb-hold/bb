import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deviceHandoffExpiredSignalLenientSchema,
  deviceHandoffSignalLenientSchema,
  type DeviceHandoffExpiredSignal,
  type DeviceHandoffSignal,
} from "@bb/server-contract";
import { wsManager } from "@/lib/ws";

type DeviceHandoffQueueSignal =
  | DeviceHandoffSignal
  | DeviceHandoffExpiredSignal;

interface DeviceHandoffQueueEntry {
  order: number;
  threadId: string | null;
  signal: DeviceHandoffQueueSignal;
}

interface ThreadQueueProgress {
  position: number;
  total: number;
}

interface DeviceHandoffQueueState {
  partitions: Record<string, DeviceHandoffQueueEntry[]>;
  progressByThread: Record<string, ThreadQueueProgress>;
  nextOrder: number;
}

const emptyQueue: DeviceHandoffQueueState = {
  partitions: {},
  progressByThread: {},
  nextOrder: 0,
};

function queueThreadKey(threadId: string | null): string {
  return threadId ?? "";
}

function signalOrigin(signal: DeviceHandoffQueueSignal) {
  if (signal.type === "device-handoff-expired") {
    return { threadId: signal.threadId, terminalSessionId: null };
  }
  return {
    threadId: signal.request.origin.threadId ?? null,
    terminalSessionId: signal.request.origin.terminalSessionId ?? null,
  };
}

function partitionKey(origin: ReturnType<typeof signalOrigin>): string {
  return JSON.stringify([origin.threadId, origin.terminalSessionId]);
}

function entriesForThread(
  queue: DeviceHandoffQueueState,
  threadId: string | null,
): DeviceHandoffQueueEntry[] {
  return Object.values(queue.partitions)
    .flat()
    .filter((entry) => entry.threadId === threadId)
    .sort((left, right) => left.order - right.order);
}

function pruneExpiredQueue(
  queue: DeviceHandoffQueueState,
  now: number,
): DeviceHandoffQueueState {
  let partitions = queue.partitions;
  let progressByThread = queue.progressByThread;
  for (const threadId of new Set(
    Object.values(queue.partitions)
      .flat()
      .map((entry) => entry.threadId),
  )) {
    const entries = entriesForThread(queue, threadId);
    const firstLiveIndex = entries.findIndex(
      ({ signal }) =>
        signal.type !== "device-handoff" || signal.expiresAt > now,
    );
    if (firstLiveIndex === -1) {
      partitions = Object.fromEntries(
        Object.entries(partitions).filter(([, partition]) =>
          partition.every((entry) => entry.threadId !== threadId),
        ),
      );
      const { [queueThreadKey(threadId)]: _, ...remainingProgress } =
        progressByThread;
      progressByThread = remainingProgress;
      continue;
    }
    const live = entries.filter(
      ({ signal }) =>
        signal.type !== "device-handoff" || signal.expiresAt > now,
    );
    const expiredBeforeCurrent = firstLiveIndex;
    const expiredAfterCurrent =
      entries.length - live.length - expiredBeforeCurrent;
    const previousProgress = progressByThread[queueThreadKey(threadId)] ?? {
      position: 1,
      total: entries.length,
    };
    progressByThread = {
      ...progressByThread,
      [queueThreadKey(threadId)]: {
        position: previousProgress.position + expiredBeforeCurrent,
        total: Math.max(
          previousProgress.position + expiredBeforeCurrent,
          previousProgress.total - expiredAfterCurrent,
        ),
      },
    };
    if (live.length !== entries.length) {
      const liveIds = new Set(live.map((entry) => entry.signal.id));
      partitions = Object.fromEntries(
        Object.entries(partitions)
          .map(([key, partition]) => [
            key,
            partition.filter(
              (entry) =>
                entry.threadId !== threadId || liveIds.has(entry.signal.id),
            ),
          ])
          .filter(([, partition]) => partition.length > 0),
      );
    }
  }
  if (
    partitions === queue.partitions &&
    progressByThread === queue.progressByThread
  ) {
    return queue;
  }
  return { ...queue, partitions, progressByThread };
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
      .map(([key, partition]) => [
        key,
        partition.filter((entry) => entry.signal.id !== id),
      ])
      .filter(([, partition]) => partition.length > 0),
  );
  const threadKey = queueThreadKey(matching.threadId);
  const remainingCount = entriesForThread(
    { ...queue, partitions },
    matching.threadId,
  ).length;
  if (remainingCount === 0) {
    const { [threadKey]: _, ...progressByThread } = queue.progressByThread;
    return { ...queue, partitions, progressByThread };
  }
  const progress = queue.progressByThread[threadKey];
  return {
    ...queue,
    partitions,
    progressByThread: progress
      ? {
          ...queue.progressByThread,
          [threadKey]: {
            position: Math.min(progress.position, remainingCount),
            total: Math.max(remainingCount, progress.total - 1),
          },
        }
      : queue.progressByThread,
  };
}

export function useDeviceHandoffQueue(activeThreadId: string | null) {
  const [queue, setQueue] = useState<DeviceHandoffQueueState>(emptyQueue);
  const enqueue = useCallback((signal: DeviceHandoffQueueSignal) => {
    const now = Date.now();
    if (signal.type === "device-handoff" && signal.expiresAt <= now) return;
    setQueue((current) => {
      const live = pruneExpiredQueue(current, now);
      const allEntries = Object.values(live.partitions).flat();
      if (allEntries.some((entry) => entry.signal.id === signal.id)) {
        return live;
      }
      const origin = signalOrigin(signal);
      const key = partitionKey(origin);
      const threadKey = queueThreadKey(origin.threadId);
      const threadEntries = entriesForThread(live, origin.threadId);
      const progress = live.progressByThread[threadKey];
      return {
        partitions: {
          ...live.partitions,
          [key]: [
            ...(live.partitions[key] ?? []),
            {
              order: live.nextOrder,
              threadId: origin.threadId,
              signal,
            },
          ],
        },
        progressByThread: {
          ...live.progressByThread,
          [threadKey]: {
            position: progress?.position ?? 1,
            total: threadEntries.length === 0 ? 1 : (progress?.total ?? 0) + 1,
          },
        },
        nextOrder: live.nextOrder + 1,
      };
    });
  }, []);

  useEffect(() => {
    wsManager.setDeviceHandoffView(activeThreadId);
    const unsubscribe = wsManager.onDeviceHandoff((signal) => {
      if (signal.type === "device-handoff-acknowledged") {
        setQueue((current) => removeSignal(current, signal.id));
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
      if (expired.success) enqueue(expired.data);
    };
    window.addEventListener("bb-device-handoff", handleDeviceHandoff);
    return () => {
      unsubscribe();
      window.removeEventListener("bb-device-handoff", handleDeviceHandoff);
      wsManager.setDeviceHandoffView(null);
    };
  }, [activeThreadId, enqueue]);

  useEffect(() => {
    const expiring = Object.values(queue.partitions)
      .flat()
      .map(({ signal }) => signal)
      .filter(
        (signal): signal is DeviceHandoffSignal =>
          signal.type === "device-handoff",
      );
    if (expiring.length === 0) return;
    const expiresAt = Math.min(...expiring.map((item) => item.expiresAt));
    const timer = window.setTimeout(
      () => {
        setQueue((current) => pruneExpiredQueue(current, Date.now()));
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [queue.partitions]);

  const activeQueue = useMemo(
    () => entriesForThread(queue, activeThreadId),
    [activeThreadId, queue],
  );
  const activeProgress = queue.progressByThread[queueThreadKey(activeThreadId)];
  const dismiss = useCallback(() => {
    setQueue((current) => {
      const live = pruneExpiredQueue(current, Date.now());
      const first = entriesForThread(live, activeThreadId)[0];
      if (!first) return live;
      const partitions = Object.fromEntries(
        Object.entries(live.partitions)
          .map(([key, partition]) => [
            key,
            partition.filter((entry) => entry.signal.id !== first.signal.id),
          ])
          .filter(([, partition]) => partition.length > 0),
      );
      const remainingCount = entriesForThread(
        { ...live, partitions },
        activeThreadId,
      ).length;
      if (remainingCount === 0) {
        const { [queueThreadKey(activeThreadId)]: _, ...progressByThread } =
          live.progressByThread;
        return { ...live, partitions, progressByThread };
      }
      const progress = live.progressByThread[queueThreadKey(activeThreadId)];
      return {
        ...live,
        partitions,
        progressByThread: progress
          ? {
              ...live.progressByThread,
              [queueThreadKey(activeThreadId)]: {
                position: progress.position + 1,
                total: progress.total,
              },
            }
          : live.progressByThread,
      };
    });
  }, [activeThreadId]);
  const acknowledgeShown = useCallback((id: string) => {
    wsManager.acknowledgeDeviceHandoff(id);
  }, []);

  return {
    signal: activeQueue[0]?.signal ?? null,
    position: activeProgress?.position ?? 1,
    count: activeProgress?.total ?? 0,
    dismiss,
    acknowledgeShown,
  };
}
