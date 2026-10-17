import { useCallback, useEffect, useState } from "react";
import {
  deviceHandoffExpiredSignalLenientSchema,
  deviceHandoffSignalLenientSchema,
  type DeviceHandoffExpiredSignal,
  type DeviceHandoffSignal,
} from "@bb/server-contract";
import { wsManager } from "@/lib/ws";

interface DeviceHandoffQueueState {
  signals: Array<DeviceHandoffSignal | DeviceHandoffExpiredSignal>;
  position: number;
  total: number;
}

const emptyQueue: DeviceHandoffQueueState = {
  signals: [],
  position: 1,
  total: 0,
};

function pruneExpiredQueue(
  queue: DeviceHandoffQueueState,
  now: number,
): DeviceHandoffQueueState {
  const firstLiveIndex = queue.signals.findIndex(
    (item) => item.type !== "device-handoff" || item.expiresAt > now,
  );
  if (firstLiveIndex === -1) return emptyQueue;
  const signals = queue.signals.filter(
    (item) => item.type !== "device-handoff" || item.expiresAt > now,
  );
  const expiredBeforeCurrent = firstLiveIndex;
  const expiredAfterCurrent =
    queue.signals.length - signals.length - expiredBeforeCurrent;
  const position = queue.position + expiredBeforeCurrent;
  return {
    signals,
    position,
    total: Math.max(position, queue.total - expiredAfterCurrent),
  };
}

export function useDeviceHandoffQueue() {
  const [queue, setQueue] = useState<DeviceHandoffQueueState>(emptyQueue);
  const enqueue = useCallback(
    (signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => {
      const now = Date.now();
      if (signal.type === "device-handoff" && signal.expiresAt <= now) return;
      setQueue((current) => {
        const live = pruneExpiredQueue(current, now);
        return {
          signals: [...live.signals, signal],
          position: live.signals.length === 0 ? 1 : live.position,
          total: live.signals.length === 0 ? 1 : live.total + 1,
        };
      });
    },
    [],
  );

  useEffect(() => {
    const unsubscribe = wsManager.onDeviceHandoff(enqueue);
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
    };
  }, [enqueue]);

  useEffect(() => {
    if (queue.signals.length === 0) return;
    const expiring = queue.signals.filter(
      (item): item is DeviceHandoffSignal => item.type === "device-handoff",
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
  }, [queue.signals]);

  const dismiss = useCallback(() => {
    setQueue((current) => {
      const live = pruneExpiredQueue(current, Date.now());
      if (live.signals.length === 0) return emptyQueue;
      const signals = live.signals.slice(1);
      if (signals.length === 0) return emptyQueue;
      return {
        signals,
        position: live.position + 1,
        total: live.total,
      };
    });
  }, []);
  return {
    signal: queue.signals[0] ?? null,
    position: queue.position,
    count: queue.total,
    dismiss,
  };
}
