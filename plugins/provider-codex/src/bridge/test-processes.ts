import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const TEST_PROCESS_GROUP_EXIT_TIMEOUT_MS = 15_000;
export const TEST_PROCESS_CLEANUP_HOOK_TIMEOUT_MS =
  TEST_PROCESS_GROUP_EXIT_TIMEOUT_MS + 10_000;

interface GroupScan {
  live: boolean;
  writer: string | undefined;
}

function scanGroup(pid: number, deadline: number): GroupScan {
  const rows = execFileSync("ps", ["-axo", "pgid=,stat=,pid=,command="], {
    encoding: "utf8",
    timeout: Math.max(1, deadline - Date.now()),
  })
    .trim()
    .split("\n");
  for (const line of rows) {
    const match = line.trim().match(/^(\d+)\s+(\S+)(?:\s+(\d+)\s+(.+))?$/u);
    if (match && Number(match[1]) === pid && !match[2]?.startsWith("Z"))
      return {
        live: true,
        writer:
          match[3] === undefined ? undefined : `pid ${match[3]} (${match[4]})`,
      };
  }
  return { live: false, writer: undefined };
}

const windowsSnapshotArguments = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }',
];

function recordWindowsDescendants(
  pid: number,
  descendants: Map<number, string>,
  snapshot: string,
): void {
  const rows = snapshot
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
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "pipe",
      timeout: Math.max(1, deadline - Date.now()),
    });
  } catch (error) {
    if (isWindowsProcessAlive(pid)) throw error;
  }
}

class LiveWriterEpermError extends Error {}

export function killTestProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals | number = "SIGTERM",
  deadline = Date.now() + TEST_PROCESS_GROUP_EXIT_TIMEOUT_MS,
): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (process.platform === "win32") return child.kill(signal);
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return process.kill(-pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      if (Date.now() >= deadline)
        throw new Error(
          `kill EPERM for test process group ${pid} (deadline expired before diagnosis)`,
          { cause: error },
        );
      const scan = scanGroup(pid, deadline);
      if (!scan.live) return false;
      throw new LiveWriterEpermError(
        `kill EPERM for test process group ${pid} with live writer${scan.writer ? `: ${scan.writer}` : ""}`,
        { cause: error },
      );
    }
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      throw error;
    return false;
  }
}

export function killSurvivingTestProcessGroupMembers(
  child: ChildProcess,
  deadline = Date.now() + TEST_PROCESS_GROUP_EXIT_TIMEOUT_MS,
): boolean {
  const pid = child.pid;
  if (pid === undefined || process.platform === "win32") return false;
  if (!scanGroup(pid, deadline).live) return false;
  try {
    return process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

export type TestProcessCleanup = (sharedDeadline?: number) => Promise<void>;

export async function drainTestProcessCleanups(
  cleanups: TestProcessCleanup[],
  timeoutMs = TEST_PROCESS_GROUP_EXIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = cleanups.splice(0);
  const results = await Promise.allSettled(
    pending.map((cleanup) => cleanup(deadline)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      failures
        .map((failure) =>
          failure instanceof Error ? failure.message : String(failure),
        )
        .join("; "),
    );
}

export function trackTestProcess(
  child: ChildProcess,
  timeoutMs = TEST_PROCESS_GROUP_EXIT_TIMEOUT_MS,
): TestProcessCleanup {
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const pid = child.pid;
  const descendants = new Map<number, string>();
  let discoveryError: Error | undefined;
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  let discovery: Promise<void> | undefined;
  let stopping = false;
  const record = () => {
    if (
      stopping ||
      discovery !== undefined ||
      pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    const pending = new Promise<void>((resolve) => {
      execFile(
        "powershell.exe",
        windowsSnapshotArguments,
        { encoding: "utf8", timeout: 5_000 },
        (error, stdout) => {
          if (error) discoveryError = error;
          else if (child.exitCode === null && child.signalCode === null)
            recordWindowsDescendants(pid, descendants, stdout);
          resolve();
        },
      );
    });
    discovery = pending;
    void pending.then(() => {
      if (discovery === pending) discovery = undefined;
    });
  };
  if (process.platform === "win32" && pid !== undefined) {
    record();
    discoveryTimer = setInterval(record, 250);
    discoveryTimer.unref();
    void exited.then(() => clearInterval(discoveryTimer));
  }
  return async (sharedDeadline) => {
    if (pid === undefined) return;
    const deadline = sharedDeadline ?? Date.now() + timeoutMs;
    let lastWriter: string | undefined;
    const noteWriter = () => {
      if (process.platform === "win32" || Date.now() >= deadline) return;
      try {
        lastWriter = scanGroup(pid, deadline).writer ?? lastWriter;
      } catch {}
    };
    const stillWriting = () => {
      const expired = Date.now() >= deadline;
      if (!expired && lastWriter === undefined) noteWriter();
      return new Error(
        `Test process group ${pid} still has live writers${lastWriter ? `: ${lastWriter}` : expired ? " (deadline expired before diagnosis)" : ""}`,
      );
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (process.platform === "win32") {
        stopping = true;
        clearInterval(discoveryTimer);
        if (discovery) {
          try {
            await Promise.race([
              discovery,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(stillWriting()),
                  Math.max(0, deadline - Date.now()),
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        if (Date.now() >= deadline) throw stillWriting();
        if (child.exitCode === null && child.signalCode === null) {
          recordWindowsDescendants(
            pid,
            descendants,
            execFileSync("powershell.exe", windowsSnapshotArguments, {
              encoding: "utf8",
              timeout: Math.max(1, deadline - Date.now()),
            }),
          );
          killWindowsProcess(pid, deadline);
        }
        for (const [descendant, identity] of descendants) {
          if (Date.now() >= deadline) throw stillWriting();
          killWindowsProcess(descendant, deadline, identity);
        }
      } else {
        let namedEperm: LiveWriterEpermError | undefined;
        for (;;) {
          try {
            killTestProcessGroup(child, "SIGKILL", deadline);
            break;
          } catch (error) {
            if (error instanceof LiveWriterEpermError) namedEperm = error;
            else if (namedEperm === undefined) throw error;
            if (Date.now() >= deadline) throw namedEperm ?? error;
            await delay(50);
          }
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        noteWriter();
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
        let scan: GroupScan;
        try {
          scan = scanGroup(pid, deadline);
        } catch (error) {
          if (Date.now() >= deadline) throw stillWriting();
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ETIMEDOUT"
          ) {
            await delay(10);
            continue;
          }
          throw error;
        }
        if (!scan.live) return;
        lastWriter = scan.writer ?? lastWriter;
        await delay(10);
      }
    } finally {
      clearInterval(discoveryTimer);
      clearTimeout(timer);
    }
  };
}
