import { type ChildProcess, execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

function hasLiveGroupMembers(pid: number): boolean {
  return execFileSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
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
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  const pid = child.pid;
  return async () => {
    if (pid === undefined) return;
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null) {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
      }
    } else {
      killTestProcessGroup(child, "SIGKILL");
    }
    await closed;
    if (process.platform === "win32") return;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const live = hasLiveGroupMembers(pid);
      if (!live) return;
      if (Date.now() >= deadline)
        throw new Error(`Test process group ${pid} still has live writers`);
      await setTimeout(10);
    }
  };
}
