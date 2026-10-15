import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS } from "@bb/config/full-stack-shutdown";
import { afterEach, describe, expect, it } from "vitest";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const launcherEntry = join(fixtureDir, "orphan-launcher.mjs");
const serverEntry = join(fixtureDir, "orphan-server.mjs");
const shutdownLauncherEntry = join(fixtureDir, "sigterm-launcher.mjs");
const slowChildEntry = join(fixtureDir, "slow-stop-child.mjs");
const realServerEntry = join(fixtureDir, "real-server-entry.mjs");
const realLauncherEntry = join(fixtureDir, "real-server-launcher.mjs");
const detachedHolderEntry = join(fixtureDir, "detached-holder.mjs");
const reportLauncherEntry = join(fixtureDir, "report-stuck-child.mjs");
const disconnectQueueEntry = join(fixtureDir, "launcher-disconnect-queue.mjs");
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
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const captured = { stderr: "" };
  child.stdout?.on("data", (chunk: Buffer) => { captured.stderr += chunk.toString(); });
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
  it("queues a launcher disconnect that arrives before shutdown registration", async () => {
    const dir = scratchDir();
    const marker = join(dir, "disconnect.log");
    const child = spawnFixture(disconnectQueueEntry, {
      BB_DISCONNECT_MARKER: marker,
    });
    await waitForExit(child, 5_000);
    expect(readFileSync(marker, "utf8")).toBe("shutdown\nexit:0\n");
  });

  it("runs production shutdown on parent loss and releases its database and port", async () => {
    const dir = scratchDir();
    const port = await freePort();
    const ready = join(dir, "ready");
    const agentPidFile = join(dir, "agent.pid");
    const holderPidFile = join(dir, "holder.pid");
    const launcher = spawnFixture(realLauncherEntry, {
      BB_OWNERSHIP_DIR: dir, BB_ORPHAN_READY: ready,
      BB_SERVER_PID_FILE: join(dir, "server.pid"),
      BB_AGENT_ENTRY: detachedHolderEntry,
      BB_AGENT_PID_FILE: agentPidFile,
      BB_AGENT_READY: join(dir, "agent.ready"),
      BB_HOLDER_ENTRY: detachedHolderEntry,
      BB_HOLDER_PID_FILE: holderPidFile,
      BB_NATIVE_HOLDER_READY: join(dir, "native-holder.ready"),
      BB_RUN_SHUTDOWN_MARKER: join(dir, "run-shutdown.log"),
      BB_REAL_LAUNCHER_PID: join(dir, "launcher.pid"),
      BB_REAL_SERVER_ENTRY: realServerEntry, BB_SERVER_PORT: String(port),
    });
    let serverPid: number | null = null;
    let agentPid: number | null = null;
    let holderPid: number | null = null;
    try {
      await waitForFile(join(dir, "server.pid"), 45_000);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        try { await fetch(`http://127.0.0.1:${port}/`); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      expect(await fetch(`http://127.0.0.1:${port}/`).then(() => true)).toBe(true);
      serverPid = Number((await waitForFile(join(dir, "server.pid"), 1_000)).trim());
      activeChildren.add(serverPid);
      agentPid = Number(await waitForFile(agentPidFile));
      activeChildren.add(agentPid);
      holderPid = Number(await waitForFile(holderPidFile));
      activeChildren.add(holderPid);
      await waitForFile(join(dir, "agent.ready"));
      await waitForFile(join(dir, "native-holder.ready"));
      process.kill(launcher.pid!, "SIGKILL");
      await waitForExit(launcher, 2_000);
      await waitForProcessExitByPid(serverPid, 10_000);
      activeChildren.delete(serverPid);
      const shutdownLog = readFileSync(
        join(dir, "run-shutdown.log"),
        "utf8",
      );
      expect(shutdownLog).toContain("server-close");
      expect(shutdownLog).toContain("db-close");
      expect(isProcessRunning(agentPid)).toBe(true);
      expect(isProcessRunning(holderPid)).toBe(true);
      const Database = createRequire(import.meta.url)("better-sqlite3");
      const db = new Database(join(dir, "bb.db"));
      db.close();
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      if (serverPid !== null && activeChildren.has(serverPid)) {
        try { process.kill(serverPid, "SIGKILL"); } catch {}
        activeChildren.delete(serverPid);
      }
      for (const pid of [agentPid, holderPid]) {
        if (pid === null || !activeChildren.has(pid)) continue;
        try { process.kill(pid, "SIGKILL"); } catch {}
        activeChildren.delete(pid);
      }
    }
  }, 120_000);

  it("keeps a standalone server alive without an IPC parent channel", async () => {
    const dir = scratchDir();
    const port = await freePort();
    const server = spawn(process.execPath, ["--conditions=source", "--import", "tsx", realServerEntry], {
      cwd: process.cwd(),
      env: { ...process.env, BB_DATA_DIR: dir, BB_ORPHAN_READY: join(dir, "ready"), BB_SERVER_PID_FILE: join(dir, "server.pid"), BB_SERVER_BIND_HOST: "127.0.0.1", BB_SERVER_PORT: String(port), BB_HOST_DAEMON_PORT: String(port + 1), BB_TELEMETRY: "false", NODE_ENV: "test" },
      stdio: "ignore",
    });
    if (server.pid !== undefined) activeChildren.add(server.pid);
    try {
      await waitForFile(join(dir, "server.pid"), 45_000);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.ok) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(server.exitCode).toBeNull();
      expect(await fetch(`http://127.0.0.1:${port}/`).then((response) => response.status)).toBe(200);
    } finally {
      if (server.pid !== undefined) {
        try { process.kill(server.pid, "SIGTERM"); } catch {}
        await waitForExit(server, 8_000).catch(() => undefined);
        activeChildren.delete(server.pid);
      }
    }
  }, 120_000);
  it("runs normal server shutdown when its launcher is SIGKILLed", async () => {
    const dir = scratchDir();
    const port = await freePort();
    const pidFile = join(dir, "server.pid");
    const marker = join(dir, "shutdown.log");
    const launcherReady = join(dir, "launcher.pid");
    const launcher = spawnFixture(launcherEntry, {
      BB_HOLDER_ENTRY: detachedHolderEntry,
      BB_HOLDER_PID_FILE: join(dir, "holder.pid"),
      BB_HOLDER_READY: join(dir, "holder.ready"),
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
      const holderPid = Number(await waitForFile(join(dir, "holder.pid")));
      activeChildren.add(holderPid);
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
      expect(isProcessRunning(holderPid)).toBe(true);
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

  it("reports a managed child that survives SIGKILL", async () => {
    const dir = scratchDir();
    const launcher = spawnFixture(reportLauncherEntry, {
      BB_SHUTDOWN_CHILD_ENTRY: slowChildEntry,
      BB_SHUTDOWN_LOG_DIR: join(dir, "logs"),
      BB_SHUTDOWN_MARKER: join(dir, "child.log"),
      BB_REPORT_PID_FILE: join(dir, "server.pid"),
    });
    let serverPid: number | null = null;
    try {
      serverPid = Number(await waitForFile(join(dir, "server.pid"), 10_000));
      activeChildren.add(serverPid);
      await waitForExit(launcher, 8_000);
      expect(childErrors.get(launcher)?.stderr).toContain(
        "server did not stop after SIGKILL within",
      );
      expect(isProcessRunning(serverPid)).toBe(true);
    } finally {
      if (serverPid !== null) {
        try { process.kill(serverPid, "SIGKILL"); } catch {}
        activeChildren.delete(serverPid);
      }
    }
  });

  it("finishes the launcher SIGTERM shutdown with its server child inside desktop grace", async () => {
    const dir = scratchDir();
    const marker = join(dir, "shutdown.log");
    const launcher = spawnFixture(shutdownLauncherEntry, {
      BB_HOLDER_ENTRY: detachedHolderEntry,
      BB_HOLDER_PID_FILE: join(dir, "holder.pid"),
      BB_HOLDER_READY: join(dir, "holder.ready"),
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
      const holderPid = Number(readFileSync(join(dir, "holder.pid"), "utf8"));
      activeChildren.add(holderPid);
      const startedAt = Date.now();
      process.kill(launcher.pid!, "SIGTERM");
      await waitForExit(launcher, DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS);
      const shutdown = readFileSync(marker, "utf8");
      expect(shutdown).toContain("server:stopped");
      expect(shutdown).toContain("daemon:stopped");
      expect(shutdown).toContain("launcher:stopped");
      expect(isProcessRunning(holderPid)).toBe(true);
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
