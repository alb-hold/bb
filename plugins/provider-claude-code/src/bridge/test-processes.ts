import { type ChildProcess, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function hasLiveGroupMembers(pid: number, deadline: number): boolean {
  return execFileSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: Math.max(1, deadline - Date.now()),
  })
    .trim()
    .split("\n")
    .some((line) => {
      const [group, state] = line.trim().split(/\s+/u);
      return Number(group) === pid && !state?.startsWith("Z");
    });
}

function recordWindowsDescendants(
  pid: number,
  descendants: Set<number>,
  deadline: number,
): void {
  const rows = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ],
    { encoding: "utf8", timeout: Math.max(1, deadline - Date.now()) },
  )
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const parents = new Set([pid]);
  for (const parent of parents) {
    for (const [candidate, owner] of rows) {
      if (
        owner === parent &&
        candidate !== undefined &&
        Number.isSafeInteger(candidate) &&
        candidate > 0 &&
        !parents.has(candidate)
      ) {
        descendants.add(candidate);
        parents.add(candidate);
      }
    }
  }
}

function isWindowsProcessAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

function killWindowsProcess(pid: number, deadline: number): void {
  if (!isWindowsProcessAlive(pid)) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], {
      stdio: "pipe",
      timeout: Math.max(1, deadline - Date.now()),
    });
  } catch (error) {
    if (isWindowsProcessAlive(pid)) throw error;
  }
}

export function killTestProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals | number = "SIGTERM",
): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (process.platform === "win32") return child.kill(signal);
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return process.kill(-pid, signal);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      throw error;
    return false;
  }
}

export function trackTestProcess(child: ChildProcess): () => Promise<void> {
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const pid = child.pid;
  const descendants = new Set<number>();
  let discoveryError: Error | undefined;
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  const record = (deadline: number) => {
    if (
      pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    try {
      recordWindowsDescendants(pid, descendants, deadline);
    } catch (error) {
      discoveryError =
        error instanceof Error ? error : new Error(String(error));
    }
  };
  if (process.platform === "win32" && pid !== undefined) {
    record(Date.now() + 5_000);
    discoveryTimer = setInterval(() => record(Date.now() + 5_000), 250);
    discoveryTimer.unref();
    void exited.then(() => clearInterval(discoveryTimer));
  }
  return async () => {
    if (pid === undefined) return;
    const deadline = Date.now() + 5_000;
    const stillWriting = () =>
      new Error(`Test process group ${pid} still has live writers`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (process.platform === "win32") {
        clearInterval(discoveryTimer);
        record(deadline);
        if (child.exitCode === null && child.signalCode === null)
          killWindowsProcess(pid, deadline);
        for (const descendant of descendants) {
          if (Date.now() >= deadline) throw stillWriting();
          killWindowsProcess(descendant, deadline);
        }
      } else {
        killTestProcessGroup(child, "SIGKILL");
      }
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(stillWriting()),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      }
      if (process.platform === "win32") {
        for (;;) {
          if (Date.now() >= deadline) throw stillWriting();
          if (![...descendants].some(isWindowsProcessAlive)) break;
          await delay(10);
        }
        if (discoveryError) throw discoveryError;
        return;
      }
      for (;;) {
        if (Date.now() >= deadline) throw stillWriting();
        let live: boolean;
        try {
          live = hasLiveGroupMembers(pid, deadline);
        } catch (error) {
          if (Date.now() >= deadline) throw stillWriting();
          throw error;
        }
        if (!live) return;
        await delay(10);
      }
    } finally {
      clearInterval(discoveryTimer);
      clearTimeout(timer);
    }
  };
}
