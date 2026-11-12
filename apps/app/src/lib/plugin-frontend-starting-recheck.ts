export const PLUGIN_STARTING_RECHECK_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 5_000,
];
export const PLUGIN_STARTING_RECHECK_MAX_ATTEMPTS = 64;

export interface StartingPluginsRecheckDeps {
  isServerPluginsStarting: () => boolean;
  recheck: () => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  delaysMs?: readonly number[];
  maxAttempts?: number;
}

export interface StartingPluginsRecheck {
  afterReconcile: () => void;
  dispose: () => void;
}

export function createStartingPluginsRecheck(
  deps: StartingPluginsRecheckDeps,
): StartingPluginsRecheck {
  const delaysMs = deps.delaysMs ?? PLUGIN_STARTING_RECHECK_DELAYS_MS;
  const maxAttempts = deps.maxAttempts ?? PLUGIN_STARTING_RECHECK_MAX_ATTEMPTS;
  let timer: unknown = null;
  let attempts = 0;
  const cancel = () => {
    if (timer === null) return;
    deps.clearTimeout(timer);
    timer = null;
  };
  return {
    afterReconcile() {
      if (!deps.isServerPluginsStarting()) {
        attempts = 0;
        cancel();
        return;
      }
      if (timer !== null || attempts >= maxAttempts) return;
      const delay = delaysMs[Math.min(attempts, delaysMs.length - 1)] ?? 5_000;
      attempts += 1;
      timer = deps.setTimeout(() => {
        timer = null;
        deps.recheck();
      }, delay);
    },
    dispose: cancel,
  };
}
