import {
  ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as helper from "./test-processes.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile), execFileSync: vi.fn() };
});

const originalPlatform = process.platform;
const pid = 12345;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFile).mockClear();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function leader(): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: pid });
  return child;
}

function exited(child: ChildProcess): void {
  Object.defineProperty(child, "exitCode", { value: 0 });
  child.emit("exit", 0, null);
}

describe("test process group teardown", () => {
  it("signals a live leader's whole group and awaits the surviving grandchild's termination", async () => {
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      exited(child);
      return true;
    });
    vi.mocked(execFileSync)
      .mockReturnValueOnce(`${pid} S\n`)
      .mockReturnValueOnce(`${pid} S\n`)
      .mockReturnValue(`${pid} Z\n`);
    let completed = false;
    const pending = cleanup().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
    expect(completed).toBe(false);
    await pending;
    expect(completed).toBe(true);
  });

  it("never signals an already exited leader's group while waiting for remaining members", async () => {
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    exited(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(execFileSync)
      .mockReturnValueOnce(`${pid} S\n`)
      .mockReturnValue(`${pid} Z\n`);
    await cleanup();
    expect(kill).not.toHaveBeenCalled();
  });

  it("fails visibly without signalling when an already exited leader's group still has writers", async () => {
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    exited(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue(`${pid} S\n`);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(5_000);
    await expect(cleanup()).rejects.toThrow(
      `Test process group ${pid} still has live writers`,
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("routes an explicit kill through the live-leader check and does not signal it again during cleanup", async () => {
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      exited(child);
      return true;
    });
    vi.mocked(execFileSync).mockReturnValue(`${pid} Z\n`);
    expect(helper.killTestProcessGroup(child, "SIGKILL")).toBe(true);
    expect(helper.killTestProcessGroup(child, "SIGKILL")).toBe(false);
    await cleanup();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-pid, "SIGKILL");
  });

  it("bounds waiting for a leader that never reports exit", async () => {
    vi.useFakeTimers();
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const result = expect(cleanup()).rejects.toThrow(
      `Test process group ${pid} still has live writers`,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(kill).toHaveBeenCalledExactlyOnceWith(-pid, "SIGKILL");
  });
});

describe.runIf(originalPlatform === "win32")(
  "Windows descendant teardown",
  () => {
    it("drains a recorded descendant after its leader exits", async () => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
      vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true, stdio: "ignore"
        });
        child.unref();
        console.log(child.pid);
        process.stdin.once("data", () => process.exit(0));`,
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      let descendant: number | undefined;
      try {
        const [data] = await once(child.stdout!, "data");
        descendant = Number(String(data).trim());
        expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
        const cleanup = helper.trackTestProcess(child);
        const snapshot = vi.mocked(execFile).mock.results.at(-1);
        if (snapshot?.type === "return") await once(snapshot.value, "close");
        const exit = once(child, "exit");
        child.stdin!.end("exit");
        await exit;
        expect(process.kill(descendant, 0)).toBe(true);
        const started = Date.now();
        await cleanup();
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(() => process.kill(descendant!, 0)).toThrow();
      } finally {
        for (const owned of [descendant, child.pid]) {
          if (owned === undefined) continue;
          try {
            actual.execFileSync("taskkill", ["/PID", String(owned), "/F"], {
              stdio: "pipe",
              timeout: 5_000,
            });
          } catch {}
        }
      }
    }, 20_000);
  },
);

describe.runIf(originalPlatform === "win32")(
  "Windows tracking responsiveness",
  () => {
    it("keeps 10 ms ticks responsive while tracking for three seconds", async () => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
      vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
      const child = spawn(
        process.execPath,
        ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let cleanup: (() => Promise<void>) | undefined;
      let ticks = 0;
      let maxTickGapMs = 0;
      let previous = performance.now();
      let ticker: ReturnType<typeof setInterval> | undefined;
      try {
        await once(child.stdout!, "data");
        previous = performance.now();
        ticker = setInterval(() => {
          const now = performance.now();
          maxTickGapMs = Math.max(maxTickGapMs, now - previous);
          previous = now;
          ticks++;
        }, 10);
        cleanup = helper.trackTestProcess(child);
        await delay(3_000);
        clearInterval(ticker);
        console.log(
          `WIN32_TICK_MEASUREMENT ${JSON.stringify({ ticks, maxTickGapMs })}`,
        );
        expect(ticks).toBeGreaterThan(150);
        expect(maxTickGapMs).toBeLessThan(200);
      } finally {
        clearInterval(ticker);
        try {
          await cleanup?.();
        } finally {
          if (child.pid !== undefined && child.exitCode === null) {
            actual.execFileSync("taskkill", ["/PID", String(child.pid), "/F"], {
              stdio: "pipe",
              timeout: 5_000,
            });
          }
        }
      }
    }, 20_000);

    it("kills a live leader's child spawned after the final snapshot", async () => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
      vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
      const directory = mkdtempSync(join(tmpdir(), "bb-win-late-child-"));
      const marker = join(directory, "spawn");
      const pidFile = join(directory, "pid");
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(marker)})) return;
        clearInterval(timer);
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        descendant.unref();
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
        setInterval(() => {}, 1000);
      }, 10);
      console.log("ready");
    `,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let descendant: number | undefined;
      try {
        await once(child.stdout!, "data");
        const cleanup = helper.trackTestProcess(child);
        vi.mocked(execFileSync).mockImplementation((file, args, options) => {
          const output = actual.execFileSync(file, args, options);
          if (
            file === "powershell.exe" &&
            args?.at(-1)?.startsWith("Get-CimInstance Win32_Process |")
          ) {
            writeFileSync(marker, "spawn");
            actual.execFileSync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `while (!(Test-Path -LiteralPath '${pidFile.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 10 }`,
              ],
              { timeout: 2_000 },
            );
            descendant = Number(readFileSync(pidFile, "utf8"));
          }
          return output;
        });
        await cleanup();
        expect(descendant).toBeGreaterThan(0);
        expect(() => process.kill(descendant!, 0)).toThrow();
      } finally {
        for (const owned of [descendant, child.pid]) {
          if (owned === undefined) continue;
          try {
            actual.execFileSync("taskkill", ["/PID", String(owned), "/F"], {
              stdio: "pipe",
              timeout: 5_000,
            });
          } catch {}
        }
        rmSync(directory, { recursive: true, force: true });
      }
    }, 20_000);
  },
);
