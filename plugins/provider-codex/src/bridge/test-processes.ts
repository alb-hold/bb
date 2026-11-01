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
  descendants: Map<number, string>,
  deadline: number,
): void {
  const rows = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }',
    ],
    { encoding: "utf8", timeout: Math.max(1, deadline - Date.now()) },
  )
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u));
  const parents = new Set([pid]);
  for (const parent of parents) {
    for (const [candidateText, ownerText, identity] of rows) {
      const candidate = Number(candidateText);
      const owner = Number(ownerText);
      if (
        owner === parent &&
        identity !== undefined &&
        /^\d+$/u.test(identity) &&
        Number.isSafeInteger(candidate) &&
        candidate > 0 &&
        !parents.has(candidate)
      ) {
        descendants.set(candidate, identity);
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

function windowsProcessIdentity(pid: number, deadline: number): string {
  return execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | ForEach-Object { $_.CreationDate.ToFileTimeUtc() }`,
    ],
    { encoding: "utf8", timeout: Math.max(1, deadline - Date.now()) },
  ).trim();
}

function killWindowsProcess(
  pid: number,
  deadline: number,
  identity?: string,
): void {
  if (!isWindowsProcessAlive(pid)) return;
  try {
    if (identity !== undefined) {
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'Stop';
          $target = $null;
          try {
            $target = [System.Diagnostics.Process]::GetProcessById(${pid});
            $null = $target.Handle;
            $current = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';
            if ($null -eq $current -or $current.CreationDate.ToFileTimeUtc().ToString() -ne '${identity}') { exit 0 }
            & taskkill.exe /PID ${pid} /F;
            if ($LASTEXITCODE -ne 0 -and !$target.HasExited) { exit $LASTEXITCODE }
          } finally {
            if ($null -ne $target) { $target.Dispose() }
          }`,
        ],
        { stdio: "pipe", timeout: Math.max(1, deadline - Date.now()) },
      );
      return;
    }
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
  const descendants = new Map<number, string>();
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
        for (const [descendant, identity] of descendants) {
          if (Date.now() >= deadline) throw stillWriting();
          killWindowsProcess(descendant, deadline, identity);
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
          if (
            ![...descendants].some(
              ([descendant, identity]) =>
                isWindowsProcessAlive(descendant) &&
                windowsProcessIdentity(descendant, deadline) === identity,
            )
          )
            break;
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
