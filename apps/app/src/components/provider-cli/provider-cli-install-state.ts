import type { QueryClient } from "@tanstack/react-query";
import type { ProviderCliInstallLogDialogState } from "@/components/dialogs/ProviderCliInstallLogDialog";
import type { ProviderCliInstallFailure } from "./provider-cli-install-store";

interface ProviderCliInstallSnapshot {
  runningJobKey: string | null;
  queuedJobKeys: ReadonlySet<string>;
  logDialogState: ProviderCliInstallLogDialogState | null;
  failuresByJobKey: ReadonlyMap<string, ProviderCliInstallFailure>;
}

const EMPTY_QUEUED_JOB_KEYS: ReadonlySet<string> = new Set();
const EMPTY_FAILURES_BY_JOB_KEY: ReadonlyMap<
  string,
  ProviderCliInstallFailure
> = new Map();

const INITIAL_SNAPSHOT: ProviderCliInstallSnapshot = {
  runningJobKey: null,
  queuedJobKeys: EMPTY_QUEUED_JOB_KEYS,
  logDialogState: null,
  failuresByJobKey: EMPTY_FAILURES_BY_JOB_KEY,
};

let snapshot: ProviderCliInstallSnapshot = INITIAL_SNAPSHOT;
let queryClient: QueryClient | null = null;
const listeners = new Set<() => void>();

export function setSnapshot(patch: Partial<ProviderCliInstallSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeProviderCliInstalls(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getProviderCliInstallSnapshot(): ProviderCliInstallSnapshot {
  return snapshot;
}

export function registerProviderCliInstallQueryClient(
  client: QueryClient,
): void {
  queryClient = client;
}

export function openProviderCliInstallLog(
  logDialogState: ProviderCliInstallLogDialogState,
): void {
  setSnapshot({ logDialogState });
}

export function closeProviderCliInstallLog(): void {
  setSnapshot({ logDialogState: null });
}

export function getInstallQueryClient() {
  return queryClient;
}

export function resetInstallSnapshot() {
  snapshot = INITIAL_SNAPSHOT;
  queryClient = null;
  listeners.clear();
}
