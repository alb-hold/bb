import { useSyncExternalStore } from "react";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";

const TICK_MS = 1_000;

const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let unsubscribeVisibility: (() => void) | null = null;

function tick(): void {
  for (const listener of listeners) listener();
}

function startInterval(): void {
  if (intervalId === null && isDocumentVisible()) {
    intervalId = setInterval(tick, TICK_MS);
  }
}

function stopInterval(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function handleVisibilityChange(): void {
  if (!isDocumentVisible()) {
    stopInterval();
    return;
  }
  if (listeners.size > 0 && intervalId === null) {
    tick();
    startInterval();
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    unsubscribeVisibility = subscribeToDocumentVisibility(
      handleVisibilityChange,
    );
    startInterval();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopInterval();
      unsubscribeVisibility?.();
      unsubscribeVisibility = null;
    }
  };
}

function subscribeWithoutTick(): () => void {
  return () => {};
}

function getSnapshot(): number {
  return Math.ceil(Date.now() / TICK_MS) * TICK_MS;
}

export function useSecondTick(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeWithoutTick,
    getSnapshot,
    getSnapshot,
  );
}
