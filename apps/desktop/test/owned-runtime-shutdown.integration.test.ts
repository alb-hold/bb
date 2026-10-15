import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DAEMON_DETACH_HEAD_START_MS,
  DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS,
  SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
  SERVER_HTTP_DRAIN_TIMEOUT_MS,
  SERVER_PLUGIN_SHUTDOWN_TIMEOUT_MS,
  SERVER_WEBSOCKET_SHUTDOWN_WAIT_TIMEOUT_MS,
} from "@bb/config/full-stack-shutdown";
import { startBbAppProcess } from "../src/bb-process.js";
import { stopOwnedRuntimeProcess } from "../src/owned-runtime-shutdown.js";
const liveProcesses = new Set<number>();
const scratchDirs: string[] = [];
const markerFiles: string[] = [];
const installedRuntimes: Array<{ cleanup(): void }> = [];

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback server did not expose a port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (address.port === 38886 || address.port === 38887) {
    return allocateLoopbackPort();
  }
  return address.port;
}

afterEach(() => {
  for (const pid of liveProcesses) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  liveProcesses.clear();
  for (const marker of markerFiles.splice(0)) {
    try {
      const events = readFileSync(marker, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const exitedPids = new Set(
        events
          .filter(
            (event) =>
              typeof event.event === "string" &&
              event.event.endsWith(":process-exit"),
          )
          .map((event) => event.pid)
          .filter((pid): pid is number => typeof pid === "number"),
      );
      for (const event of events) {
        if (typeof event.pid !== "number" || exitedPids.has(event.pid))
          continue;
        try {
          process.kill(event.pid, 0);
          process.kill(event.pid, "SIGKILL");
        } catch {}
      }
    } catch {}
  }
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  while (installedRuntimes.length > 0) {
    installedRuntimes.pop()?.cleanup();
  }
});

async function stopRuntimeThroughDesktop(runtimeKind: "direct" | "appimage") {
  const fixtureModule = (await import(
    pathToFileURL(
      resolve(
        process.cwd(),
        "../../packages/bb-app/test/fixtures/p7-installed-runtime.mjs",
      ),
    ).href
  )) as {
    createP7InstalledRuntime(): {
      binPath: string;
      cleanup(): void;
      packageRoot: string;
    };
  };
  const { createP7InstalledRuntime } = fixtureModule;
  const installed = createP7InstalledRuntime();
  installedRuntimes.push(installed);
  const serverPort = await allocateLoopbackPort();
  const daemonPort = await allocateLoopbackPort();
  const dir = mkdtempSync(join(tmpdir(), "bb-desktop-shutdown-p7-"));
  scratchDirs.push(dir);
  const marker = join(dir, "shutdown-events.jsonl");
  markerFiles.push(marker);
  const serverPhases = [
    SERVER_HTTP_DRAIN_TIMEOUT_MS,
    SERVER_WEBSOCKET_SHUTDOWN_WAIT_TIMEOUT_MS,
    SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
    SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
    SERVER_PLUGIN_SHUTDOWN_TIMEOUT_MS,
  ];
  const env = {
    ...process.env,
    ...(runtimeKind === "appimage" ? { APPDIR: installed.packageRoot } : {}),
    BB_DATA_DIR: join(dir, "data"),
    BB_HOST_ENROLL_KEY: "p7-test-enroll-key",
    BB_HOST_ID: "p7-test-host",
    BB_SERVER_PORT: String(serverPort),
    BB_HOST_DAEMON_PORT: String(daemonPort),
    P7_DAEMON_DETACH_MS: "5500",
    P7_SERVER_PHASES_MS: JSON.stringify(serverPhases),
    P7_SHUTDOWN_MARKER: marker,
  };
  const bbProcess = startBbAppProcess({
    bridgePath: installed.binPath,
    cwd: process.cwd(),
    env,
    logLineLimit: 100,
    runtime:
      runtimeKind === "appimage"
        ? {
            appDirPath: installed.packageRoot,
            executablePath: process.execPath,
            kind: "appimage",
            mode: "electron-node",
          }
        : {
            executablePath: process.execPath,
            kind: "direct",
            mode: "node",
          },
  });
  liveProcesses.add(bbProcess.pid);
  let output = "";
  bbProcess.childProcess.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  bbProcess.childProcess.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const readyAt = Date.now();
  while (!output.includes("bb is ready") && Date.now() - readyAt < 15_000) {
    if (
      bbProcess.childProcess.exitCode !== null ||
      bbProcess.childProcess.signalCode !== null
    ) {
      throw new Error(`Launcher exited before ready: ${output}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  expect(output).toContain("bb is ready");

  const shutdownStartedAt = Date.now();
  await stopOwnedRuntimeProcess({
    bbProcess,
    ownership: "spawned",
    userDataPath: null,
  });
  const elapsedMs = Date.now() - shutdownStartedAt;
  const exit = await bbProcess.exit;
  liveProcesses.delete(bbProcess.pid);
  const events = readFileSync(marker, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const event = (name: string) => events.find((item) => item.event === name);

  return {
    daemonExit: event("daemon:process-exit"),
    elapsedMs,
    events,
    exit,
    serverExit: event("server:process-exit"),
    serverSignal: event("server:received-sigterm"),
    shutdownStartedAt,
  };
}

describe.sequential("owned runtime shutdown signal path", () => {
  const runtimeKinds =
    process.platform === "linux"
      ? (["direct", "appimage"] as const)
      : (["direct"] as const);

  it.each(runtimeKinds)(
    "stops a %s launcher through the production Desktop shutdown function",
    async (runtimeKind) => {
      const result = await stopRuntimeThroughDesktop(runtimeKind);

      expect(result.exit.code).toBe(0);
      expect(result.exit.signal).toBeNull();
      expect(result.elapsedMs).toBeLessThan(
        DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS,
      );
      expect(result.elapsedMs, JSON.stringify(result)).toBeGreaterThanOrEqual(
        5_000,
      );
      expect(result.daemonExit?.code).toBe(0);
      expect(result.daemonExit?.signal).toBeNull();
      expect(
        result.events.find((item) => item.event === "daemon:ready"),
      ).toBeDefined();
      expect(
        result.events.find((item) => item.event === "server:ready"),
      ).toBeDefined();
      expect(
        result.events.find((item) => item.event === "daemon:received-sigterm"),
      ).toBeDefined();
      expect(
        result.events.find((item) => item.event === "server:received-sigterm"),
      ).toBeDefined();
      expect(result.serverSignal?.at).toBeGreaterThanOrEqual(
        result.daemonExit?.at as number,
      );
      expect(
        (result.serverSignal?.at as number) - result.shutdownStartedAt,
      ).toBeLessThanOrEqual(DAEMON_DETACH_HEAD_START_MS);
      expect(result.serverExit?.code).toBe(0);
      expect(result.serverExit?.signal).toBeNull();
      expect(
        result.events.find((item) => item.event === "daemon:shutdown-complete"),
      ).toBeDefined();
      expect(
        result.events.find((item) => item.event === "server:shutdown-complete"),
      ).toBeDefined();
      expect(
        result.events.find((item) => item.event === "server:process-exit")
          ?.code,
      ).toBe(0);
      expect(
        result.events.find((item) => item.event === "daemon:process-exit")
          ?.code,
      ).toBe(0);
      for (const item of result.events.filter((item) =>
        ["daemon:ready", "server:ready"].includes(String(item.event)),
      )) {
        expect(typeof item.pid === "number" && isRunning(item.pid)).toBe(false);
      }
    },
    20_000,
  );
});
