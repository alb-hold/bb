import { DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS } from "@bb/config/full-stack-shutdown";
import { clearOwnedRuntimePidFile } from "./owned-runtime-supervisor.js";
import type { BbAppProcess } from "./bb-process.js";
import type { RuntimeOwnership } from "./types.js";

export interface OwnedRuntimeToStop {
  bbProcess: BbAppProcess | null;
  ownership: RuntimeOwnership;
  userDataPath: string | null;
}

export async function stopOwnedRuntimeProcess(
  runtime: OwnedRuntimeToStop | null,
): Promise<void> {
  if (runtime === null || runtime.ownership !== "spawned") {
    return;
  }

  try {
    await runtime.bbProcess?.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: 1_000,
      signal: "SIGTERM",
      timeoutMs: DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS,
    });
  } finally {
    if (runtime.userDataPath !== null) {
      await clearOwnedRuntimePidFile({ userDataPath: runtime.userDataPath });
    }
  }
}
