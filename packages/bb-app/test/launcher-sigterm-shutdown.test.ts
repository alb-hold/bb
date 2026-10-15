import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  DAEMON_DETACH_HEAD_START_MS,
  DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS,
  SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
  SERVER_HTTP_DRAIN_TIMEOUT_MS,
  SERVER_PLUGIN_SHUTDOWN_TIMEOUT_MS,
  SERVER_WEBSOCKET_SHUTDOWN_WAIT_TIMEOUT_MS,
} from "@bb/config/full-stack-shutdown";
import { expect, it } from "vitest";
import { createP7InstalledRuntime } from "./fixtures/p7-installed-runtime.mjs";

function readEvents(marker: string): Array<Record<string, unknown>> {
  return readFileSync(marker, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

it("handles SIGTERM through the real launcher and bounded server children", async () => {
  const installed = createP7InstalledRuntime();
  const serverPort = await allocateLoopbackPort();
  const daemonPort = await allocateLoopbackPort();
  const dataDir = mkdtempSync(join(tmpdir(), "bb-launcher-sigterm-"));
  const marker = join(dataDir, "shutdown-events.jsonl");
  const serverPhases = [
    SERVER_HTTP_DRAIN_TIMEOUT_MS,
    SERVER_WEBSOCKET_SHUTDOWN_WAIT_TIMEOUT_MS,
    SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
    SERVER_HTTP_CLOSE_WAIT_TIMEOUT_MS,
    SERVER_PLUGIN_SHUTDOWN_TIMEOUT_MS,
  ];
  const launcher = spawn(
    process.execPath,
    [
      installed.binPath,
      "start",
      "--data-dir",
      dataDir,
      "--server-port",
      String(serverPort),
      "--host-daemon-port",
      String(daemonPort),
      "--no-in-app-updates",
      "--bundled",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BB_DATA_DIR: dataDir,
        BB_HOST_ENROLL_KEY: "p7-test-enroll-key",
        BB_HOST_ID: "p7-test-host",
        P7_DAEMON_DETACH_MS: "5500",
        BB_SERVER_PORT: String(serverPort),
        BB_HOST_DAEMON_PORT: String(daemonPort),
        P7_SERVER_PHASES_MS: JSON.stringify(serverPhases),
        P7_SHUTDOWN_MARKER: marker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const pid = launcher.pid;
  if (pid === undefined) throw new Error("Launcher did not expose a PID");
  let output = "";
  launcher.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  launcher.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const readyAt = Date.now();
    while (!output.includes("bb is ready") && Date.now() - readyAt < 15_000) {
      if (launcher.exitCode !== null || launcher.signalCode !== null) {
        const events = readEvents(marker);
        throw new Error(
          `Launcher exited before ready: ${output}\n${JSON.stringify(events)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(output).toContain("bb is ready");

    const shutdownStartedAt = Date.now();
    process.kill(pid, "SIGTERM");
    const timedExit = new Promise<never>((_, reject) => {
      shutdownTimeout = setTimeout(
        () => reject(new Error("Launcher missed desktop shutdown grace")),
        DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS,
      );
    });
    const [code, signal] = (await Promise.race([
      once(launcher, "exit"),
      timedExit,
    ])) as [number | null, NodeJS.Signals | null];
    if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout);
    const elapsedMs = Date.now() - shutdownStartedAt;
    const events = readEvents(marker);
    const byEvent = (name: string) =>
      events.find((event) => event.event === name);
    const daemonExit = byEvent("daemon:process-exit");
    const serverSignal = byEvent("server:received-sigterm");
    const serverExit = byEvent("server:process-exit");

    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(byEvent("server:ready")).toBeDefined();
    expect(byEvent("daemon:ready")).toBeDefined();
    expect(elapsedMs).toBeLessThan(DESKTOP_OWNED_RUNTIME_SHUTDOWN_GRACE_MS);
    expect(elapsedMs, JSON.stringify(events)).toBeGreaterThanOrEqual(5_000);
    expect(byEvent("daemon:detach-acked")).toBeDefined();
    expect(daemonExit?.code).toBe(0);
    expect(serverSignal?.at).toBeGreaterThanOrEqual(daemonExit?.at as number);
    expect(
      (serverSignal?.at as number) - shutdownStartedAt,
    ).toBeLessThanOrEqual(DAEMON_DETACH_HEAD_START_MS);
    expect(serverExit?.code).toBe(0);
    expect(byEvent("server:shutdown-complete")).toBeDefined();
    expect(byEvent("daemon:shutdown-complete")).toBeDefined();
    for (const event of [byEvent("server:ready"), byEvent("daemon:ready")]) {
      expect(typeof event?.pid === "number" && isRunning(event.pid)).toBe(
        false,
      );
    }
    expect(events.some((event) => event.signal === "SIGKILL")).toBe(false);
  } finally {
    if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout);
    if (isRunning(pid)) process.kill(pid, "SIGKILL");
    if (marker.length > 0) {
      try {
        const events = readEvents(marker);
        const exitedPids = new Set(
          events
            .filter(
              (event) =>
                typeof event.event === "string" &&
                event.event.endsWith(":process-exit"),
            )
            .map((event) => event.pid)
            .filter(
              (eventPid): eventPid is number => typeof eventPid === "number",
            ),
        );
        for (const event of events) {
          if (typeof event.pid === "number" && isRunning(event.pid)) {
            if (!exitedPids.has(event.pid)) process.kill(event.pid, "SIGKILL");
          }
        }
      } catch {}
    }
    rmSync(dataDir, { recursive: true, force: true });
    installed.cleanup();
  }
}, 30_000);
