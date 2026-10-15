import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

const launcherFixture = resolve(
  process.cwd(),
  "../../packages/bb-app/test/fixtures/p7-real-launcher-shutdown.mjs",
);
const liveProcesses = new Set<number>();
const scratchDirs: string[] = [];
const markerFiles: string[] = [];

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
              typeof event.event === "string" && event.event.endsWith(":exit"),
          )
          .map((event) => event.pid)
          .filter((pid): pid is number => typeof pid === "number"),
      );
      for (const event of events) {
        if (typeof event.pid !== "number" || exitedPids.has(event.pid)) continue;
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
});

async function stopRuntimeThroughDesktop(runtimeKind: "direct" | "appimage") {
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
    ...(runtimeKind === "appimage" ? { APPDIR: dirname(launcherFixture) } : {}),
    BB_DATA_DIR: join(dir, "data"),
    BB_HOST_ENROLL_KEY: "p7-test-enroll-key",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=source --import=tsx`.trim(),
    P7_DAEMON_DETACH_MS: "5500",
    P7_DETACHED_CHILDREN: "true",
    P7_SERVER_PHASES_MS: JSON.stringify(serverPhases),
    P7_SHUTDOWN_MARKER: marker,
  };
  const bbProcess = startBbAppProcess({
    bridgePath: launcherFixture,
    cwd: process.cwd(),
    env,
    logLineLimit: 100,
    runtime:
      runtimeKind === "appimage"
        ? {
            appDirPath: dirname(launcherFixture),
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
    daemonExit: event("daemon:exit"),
    elapsedMs,
    events,
    exit,
    serverExit: event("server:exit"),
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
      expect(result.elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect(result.daemonExit?.code).toBe(0);
      expect(result.daemonExit?.signal).toBeNull();
      expect(result.serverSignal?.at).toBeGreaterThanOrEqual(
        result.daemonExit?.at as number,
      );
      expect(
        (result.serverSignal?.at as number) - result.shutdownStartedAt,
      ).toBeLessThanOrEqual(DAEMON_DETACH_HEAD_START_MS);
      expect(result.serverExit?.code).toBe(0);
      expect(result.serverExit?.signal).toBeNull();
      expect(result.events.some((item) => item.signal === "SIGKILL")).toBe(
        false,
      );
    },
    20_000,
  );
});
