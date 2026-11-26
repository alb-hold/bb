import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppLaunchDeps } from "@bb/process-utils";
import { afterEach, describe, expect, it } from "vitest";
import { startBridgeWorkerAsApp } from "./bridge-worker-app.js";
import { SocketBridgeWorker } from "./bridge-worker-socket.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workerDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-bw-app-"));
  directories.push(directory);
  return directory;
}

function recordingDeps(platform: NodeJS.Platform): {
  deps: AppLaunchDeps;
  ran: { command: string; args: string[] }[];
} {
  const ran: { command: string; args: string[] }[] = [];
  return {
    ran,
    deps: { platform, run: (command, args) => void ran.push({ command, args }) },
  };
}

const SECRET = "sk-sentinel-bridge-secret";

function request(dir: string) {
  return {
    workerDir: dir,
    id: "abc123",
    logPath: join(dir, "abc123.log"),
    command: "/Applications/bb.app/Contents/MacOS/bb",
    args: ["worker.mjs", "--flag"],
    cwd: "/work",
    env: { ELECTRON_RUN_AS_NODE: "1", PROVIDER_TOKEN: SECRET, WEIRD: "it's" },
  };
}

describe("bridge worker app launch", () => {
  it("launches the worker as its own LaunchServices app on darwin, keeping secrets out of argv", () => {
    const dir = workerDir();
    const { deps, ran } = recordingDeps("darwin");
    const result = startBridgeWorkerAsApp(request(dir), deps);
    expect(result.ok).toBe(true);
    const open = ran.find((call) => call.command === "/usr/bin/open");
    expect(open?.args.slice(0, 3)).toEqual(["-n", "-g", "-j"]);
    expect(open?.args[3]).toBe(join(dir, "bb-bridge-worker.app"));
    const argsAt = open?.args.indexOf("--args") ?? -1;
    expect(open?.args.slice(argsAt + 1)).toEqual([
      "/Applications/bb.app/Contents/MacOS/bb",
      "worker.mjs",
      "--flag",
    ]);
    expect(open?.args.join("\n")).not.toContain(SECRET);
    expect(open?.args.join("\n")).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(open?.args.some((a) => a === `BB_APP_LAUNCH_PID_FILE=${join(dir, "abc123.pid")}`)).toBe(true);
    const envFile = readdirSync(dir).find((name) => name.endsWith(".env"));
    expect(envFile).toBeDefined();
    const envPath = join(dir, envFile ?? "");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("export ELECTRON_RUN_AS_NODE='1'");
    expect(content).toContain(`export PROVIDER_TOKEN='${SECRET}'`);
    expect(content).toContain("export WEIRD='it'\\''s'");
    expect(statSync(request(dir).logPath).mode & 0o777).toBe(0o600);
  });

  it("does not use an app off darwin", () => {
    const dir = workerDir();
    const { deps, ran } = recordingDeps("linux");
    expect(startBridgeWorkerAsApp(request(dir), deps)).toEqual({
      ok: false,
      reason: "not-darwin",
      errorName: null,
    });
    expect(ran).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reports open failure and removes the environment file", () => {
    const dir = workerDir();
    const deps: AppLaunchDeps = {
      platform: "darwin",
      run: (command) => {
        if (command === "/usr/bin/open") throw new Error("refused");
      },
    };
    const result = startBridgeWorkerAsApp(request(dir), deps);
    expect(result).toMatchObject({ ok: false, reason: "open-failed" });
    expect(readdirSync(dir).filter((name) => name.endsWith(".env"))).toEqual([]);
  });

  it("falls back to a direct spawn when the app launch is refused", async () => {
    const dir = workerDir();
    const marker = join(dir, "ran");
    const worker = new SocketBridgeWorker({
      kind: "spawn",
      command: "/bin/sh",
      args: ["-c", `echo up > ${marker}; sleep 30`],
      cwd: dir,
      env: {},
      workerDir: join(dir, "w"),
      connectTimeoutMs: 100,
      appLaunch: {
        platform: "darwin",
        run: (command) => {
          if (command === "/usr/bin/open") throw new Error("refused");
        },
      },
      registration: {
        environmentId: "env-1",
        pluginId: "p",
        processKey: "k",
        providerId: "f",
      },
      workspace: {
        workspacePath: dir,
        workspaceProvisionType: "unmanaged",
        personalWorkspaceRoot: null,
      },
    });
    worker.on("error", () => undefined);
    for (let i = 0; i < 100 && !existsSync(marker); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(existsSync(marker)).toBe(true);
    expect(worker.pid).toBeGreaterThan(0);
    await worker.stop({ gracePeriodMs: 0 });
  });
});

const COALITION_PROBE = [
  "import ctypes, ctypes.util, sys",
  "lib = ctypes.CDLL(ctypes.util.find_library('proc'))",
  "class Info(ctypes.Structure):",
  "    _fields_ = [('ids', ctypes.c_uint64 * 2), ('reserved', ctypes.c_uint64 * 8)]",
  "info = Info()",
  "ret = lib.proc_pidinfo(int(sys.argv[1]), 20, 0, ctypes.byref(info), ctypes.sizeof(info))",
  "print('%d:%d:%d' % (ret, info.ids[0], info.ids[1]))",
].join("\n");

function coalitionOf(pid: number): string {
  return execFileSync("python3", ["-I", "-c", COALITION_PROBE, String(pid)], {
    encoding: "utf8",
  }).trim();
}

describe.skipIf(process.platform !== "darwin")(
  "bridge worker coalition on macOS",
  () => {
    it("runs the worker in its own coalition so a bb quit cannot sweep it", async () => {
      const dir = workerDir();
      const worker = new SocketBridgeWorker({
        kind: "spawn",
        command: "/bin/sleep",
        args: ["300"],
        cwd: dir,
        env: {},
        workerDir: dir,
        connectTimeoutMs: 100,
        registration: {
          environmentId: "env-1",
          pluginId: "p",
          processKey: "k",
          providerId: "f",
        },
        workspace: {
          workspacePath: dir,
          workspaceProvisionType: "unmanaged",
          personalWorkspaceRoot: null,
        },
      });
      worker.on("error", () => undefined);
      for (let i = 0; i < 300 && worker.pid === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const pid = worker.pid;
      expect(pid).toBeGreaterThan(0);
      try {
        expect(coalitionOf(pid ?? 0)).not.toBe(coalitionOf(process.pid));
      } finally {
        await worker.stop({ gracePeriodMs: 0 });
      }
    });
  },
);
