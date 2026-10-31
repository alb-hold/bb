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
  return async () => {
    if (pid === undefined) return;
    const deadline = Date.now() + 5_000;
    const stillWriting = () =>
      new Error(`Test process group ${pid} still has live writers`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) {
          execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
            timeout: Math.max(1, deadline - Date.now()),
          });
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
      if (process.platform === "win32") return;
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
      clearTimeout(timer);
    }
  };
}
