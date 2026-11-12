export const PLUGIN_STARTING_RECHECK_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 5_000,
];

export interface StartingPluginsRecheckDeps {
  isServerPluginsStarting: () => boolean;
  recheck: () => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  delaysMs?: readonly number[];
}

export interface StartingPluginsRecheck {
  afterReconcile: () => void;
  afterFailedReconcile: () => void;
  dispose: () => void;
}

export function createStartingPluginsRecheck(
  deps: StartingPluginsRecheckDeps,
): StartingPluginsRecheck {
  const delaysMs = deps.delaysMs ?? PLUGIN_STARTING_RECHECK_DELAYS_MS;
  let timer: unknown = null;
  let attempts = 0;
  const cancel = () => {
    if (timer === null) return;
    deps.clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    if (timer !== null) return;
    const delay = delaysMs[Math.min(attempts, delaysMs.length - 1)] ?? 5_000;
    attempts += 1;
    timer = deps.setTimeout(() => {
      timer = null;
      deps.recheck();
    }, delay);
  };
  return {
    afterReconcile() {
      if (!deps.isServerPluginsStarting()) {
        attempts = 0;
        cancel();
        return;
      }
      arm();
    },
    afterFailedReconcile() {
      if (attempts === 0) return;
      arm();
    },
    dispose: cancel,
  };
}
