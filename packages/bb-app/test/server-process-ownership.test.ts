import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const launcherEntry = join(fixtureDir, "orphan-launcher.mjs");
const serverEntry = join(fixtureDir, "orphan-server.mjs");
const shutdownLauncherEntry = join(fixtureDir, "sigterm-launcher.mjs");
const slowChildEntry = join(fixtureDir, "slow-stop-child.mjs");
const scratchDirs: string[] = [];
const activeChildren = new Set<number>();
const childErrors = new WeakMap<ChildProcess, { stderr: string }>();

afterEach(() => {
  for (const pid of activeChildren) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  activeChildren.clear();
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-server-ownership-"));
  scratchDirs.push(dir);
  return dir;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function spawnFixture(entry: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", entry],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const captured = { stderr: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    captured.stderr += chunk.toString();
  });
  childErrors.set(child, captured);
  if (child.pid !== undefined) activeChildren.add(child.pid);
  return child;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Process did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      if (child.pid !== undefined) activeChildren.delete(child.pid);
      resolve();
    });
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForText(
  child: ChildProcess,
  path: string,
  text: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(text)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Launcher exited before ${text}: ${childErrors.get(child)?.stderr ?? ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${text}: ${childErrors.get(child)?.stderr ?? ""}`,
  );
}

async function waitForFileText(
  path: string,
  text: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const contents = readFileSync(path, "utf8");
      if (contents.includes(text)) return contents;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${text} in ${path}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExitByPid(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

describe("server process ownership", () => {
  it("runs normal server shutdown when its launcher is SIGKILLed", async () => {
    const dir = scratchDir();
    const port = await freePort();
    const pidFile = join(dir, "server.pid");
    const marker = join(dir, "shutdown.log");
    const launcherReady = join(dir, "launcher.pid");
    const launcher = spawnFixture(launcherEntry, {
      BB_ORPHAN_DIR: dir,
      BB_ORPHAN_LAUNCHER_READY: launcherReady,
      BB_ORPHAN_MARKER: marker,
      BB_ORPHAN_PID_FILE: pidFile,
      BB_ORPHAN_SERVER_ENTRY: serverEntry,
      BB_SERVER_PORT: String(port),
    });
    let serverPid: number | null = null;
    let serverExited = false;
    try {
      await waitForFile(launcherReady);
      serverPid = Number(await waitForFile(pidFile));
      activeChildren.add(serverPid);
      process.kill(launcher.pid!, "SIGKILL");
      await waitForExit(launcher, 2_000);
      await waitForProcessExitByPid(serverPid, 10_000);
      serverExited = true;
      const shutdown = await waitForFileText(
        marker,
        "shutdown-finished",
        1_000,
      );
      expect(shutdown).toBe("shutdown-started\nshutdown-finished\n");
      if (serverPid !== null) activeChildren.delete(serverPid);
    } finally {
      if (
        serverPid !== null &&
        !serverExited &&
        activeChildren.has(serverPid)
      ) {
        try {
          process.kill(serverPid, "SIGKILL");
        } catch {}
        activeChildren.delete(serverPid);
      }
    }
  });

  it("finishes the launcher SIGTERM shutdown with its server child inside six seconds", async () => {
    const dir = scratchDir();
    const marker = join(dir, "shutdown.log");
    const launcher = spawnFixture(shutdownLauncherEntry, {
      BB_SHUTDOWN_CHILD_ENTRY: slowChildEntry,
      BB_SHUTDOWN_LOG_DIR: join(dir, "logs"),
      BB_SHUTDOWN_MARKER: marker,
      BB_SERVER_CHILD_PID_FILE: join(dir, "server.pid"),
      BB_DAEMON_CHILD_PID_FILE: join(dir, "daemon.pid"),
    });
    try {
      await waitForText(launcher, marker, "launcher:ready");
      activeChildren.add(Number(readFileSync(join(dir, "server.pid"), "utf8")));
      activeChildren.add(Number(readFileSync(join(dir, "daemon.pid"), "utf8")));
      const startedAt = Date.now();
      process.kill(launcher.pid!, "SIGTERM");
      await waitForExit(launcher, 10_000);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(6_000);
      const shutdown = readFileSync(marker, "utf8");
      expect(shutdown).toContain("server:stopped");
      expect(shutdown).toContain("daemon:stopped");
      expect(shutdown).toContain("launcher:stopped");
      for (const childPidFile of [
        join(dir, "server.pid"),
        join(dir, "daemon.pid"),
      ]) {
        const pid = Number(readFileSync(childPidFile, "utf8"));
        await waitForProcessExitByPid(pid, 2_000);
        activeChildren.delete(pid);
      }
    } finally {
      for (const childPidFile of [
        join(dir, "server.pid"),
        join(dir, "daemon.pid"),
      ]) {
        if (!existsSync(childPidFile)) continue;
        const pid = Number(readFileSync(childPidFile, "utf8"));
        if (!activeChildren.has(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        activeChildren.delete(pid);
      }
    }
  });
});
