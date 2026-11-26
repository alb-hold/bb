import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import {
  holdNativeHarness,
  registerNativeCommands,
  spawnNativeHolder,
  startNativeHolderFallback,
} from "../commands/thread/native.js";
import {
  NativeHolderFrame,
  claimNativeHolderLaunch,
  encodeNativeHolderFrame,
  nativeHolderPidMarkerPath,
  nativeHolderProcessIsAlive,
  openNativeHolderConnection,
  runNativeHolder,
  writeNativeHolderPidMarker,
} from "../native-holder.js";
import {
  loadNativeHolderEnvironment,
  startNativeHolderAsApp,
  type NativeHolderAppDeps,
} from "../native-holder-app.js";

const spawned = vi.hoisted(() => [] as { command: string; args: string[] }[]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawned.push({ command, args });
      return { unref: () => {} };
    },
  };
});

const directories: string[] = [];

afterEach(() => {
  spawned.length = 0;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function socketIn(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bb-nh-app-"));
  directories.push(directory);
  return path.join(directory, "thr_abc-c417c3fe.sock");
}

function recordingDeps(platform: NodeJS.Platform): {
  deps: NativeHolderAppDeps;
  ran: { command: string; args: string[] }[];
} {
  const ran: { command: string; args: string[] }[] = [];
  return {
    ran,
    deps: {
      platform,
      run: (command, args) => {
        ran.push({ command, args });
      },
    },
  };
}

describe("native holder app launch", () => {
  it("starts the holder as its own LaunchServices app on darwin", () => {
    const socket = socketIn();
    const { deps, ran } = recordingDeps("darwin");
    spawnNativeHolder("thr_abc", socket, deps, 1, "0123456789abcdef");
    const open = ran.find((call) => call.command === "/usr/bin/open");
    expect(open?.args.slice(0, 3)).toEqual(["-n", "-g", "-j"]);
    const bundle = open?.args[3] ?? "";
    expect(bundle).toBe(path.join(path.dirname(socket), "bb-native-hold.app"));
    const argsAt = open?.args.indexOf("--args") ?? -1;
    expect(open?.args.slice(argsAt + 1)).toEqual(
      expect.arrayContaining([
        "native-hold",
        "thr_abc",
        "--socket",
        socket,
        "--marker-generation",
        "1",
        "--marker-token",
        "0123456789abcdef",
      ]),
    );
    expect(open?.args).toContain(`--env`);
    expect(open?.args.some((a) => a.startsWith("BB_APP_LAUNCH_CWD="))).toBe(
      true,
    );
    expect(
      ran.some(
        (call) =>
          call.command === "/usr/bin/codesign" && call.args.includes(bundle),
      ),
    ).toBe(true);
    const run = path.join(bundle, "Contents", "MacOS", "run");
    expect(readFileSync(run, "utf8")).toContain('exec "$@"');
    expect(statSync(run).mode & 0o111).not.toBe(0);
  });

  it("keeps every environment value out of open's argv and hands the holder a private file", () => {
    const secret = "sk-sentinel-secret-value";
    const socket = socketIn();
    let mode = 0;
    let filePath = "";
    let argvSeen: string[] = [];
    const deps: NativeHolderAppDeps = {
      platform: "darwin",
      run: (command, args) => {
        if (command !== "/usr/bin/open") return;
        argvSeen = args;
        const entry = args.find((a) =>
          a.startsWith("BB_NATIVE_HOLD_ENV_FILE="),
        );
        filePath = entry?.slice("BB_NATIVE_HOLD_ENV_FILE=".length) ?? "";
        mode = statSync(filePath).mode & 0o777;
      },
    };
    expect(
      startNativeHolderAsApp(
        {
          argv: ["node", "x"],
          cwd: "/work",
          environment: { CLAUDE_CODE_OAUTH_TOKEN: secret, PLAIN: "v" },
          socketPath: socket,
        },
        deps,
      ),
    ).toEqual({ ok: true, environmentFile: filePath });
    expect(argvSeen.some((a) => a.includes(secret))).toBe(false);
    expect(argvSeen.some((a) => a.includes("CLAUDE_CODE_OAUTH_TOKEN"))).toBe(
      false,
    );
    expect(mode).toBe(0o600);
    expect(path.dirname(filePath)).toBe(path.dirname(socket));
    const target: NodeJS.ProcessEnv = {
      BB_NATIVE_HOLD_ENV_FILE: filePath,
    };
    loadNativeHolderEnvironment(target);
    expect(target).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: secret,
      PLAIN: "v",
    });
    expect(existsSync(filePath)).toBe(false);
  });

  it("removes the environment file when open refuses", () => {
    const socket = socketIn();
    const deps: NativeHolderAppDeps = {
      platform: "darwin",
      run: (command) => {
        if (command === "/usr/bin/open") throw new Error("refused");
      },
    };
    startNativeHolderAsApp(
      { argv: ["node"], cwd: "/", environment: { A: "1" }, socketPath: socket },
      deps,
    );
    expect(
      readdirSync(path.dirname(socket)).filter((n) => n.endsWith(".env")),
    ).toEqual([]);
  });

  it("fails closed and deletes the file when it is group-readable, missing, or malformed", () => {
    const dir = path.dirname(socketIn());
    const open = path.join(dir, "open.env");
    writeFileSync(open, JSON.stringify({ A: "1" }), { mode: 0o644 });
    const target: NodeJS.ProcessEnv = { BB_NATIVE_HOLD_ENV_FILE: open };
    expect(() => loadNativeHolderEnvironment(target)).toThrow();
    expect(existsSync(open)).toBe(false);
    expect(target.A).toBeUndefined();

    const missing: NodeJS.ProcessEnv = {
      BB_NATIVE_HOLD_ENV_FILE: path.join(dir, "gone.env"),
    };
    expect(() => loadNativeHolderEnvironment(missing)).toThrow();

    const bad = path.join(dir, "bad.env");
    writeFileSync(bad, JSON.stringify({ A: 1 }), { mode: 0o600 });
    const partial: NodeJS.ProcessEnv = { BB_NATIVE_HOLD_ENV_FILE: bad };
    expect(() => loadNativeHolderEnvironment(partial)).toThrow();
    expect(partial.A).toBeUndefined();
    expect(existsSync(bad)).toBe(false);
  });

  it("does nothing when the holder was not started through the app", () => {
    const target: NodeJS.ProcessEnv = { A: "1" };
    loadNativeHolderEnvironment(target);
    expect(target).toEqual({ A: "1" });
  });

  it("uses no launchctl at all", () => {
    const { deps, ran } = recordingDeps("darwin");
    startNativeHolderAsApp(
      { argv: ["node"], cwd: "/", environment: {}, socketPath: socketIn() },
      deps,
    );
    expect(ran.some((call) => call.command.includes("launchctl"))).toBe(false);
  });

  it("does not use an app off darwin", () => {
    const { deps, ran } = recordingDeps("linux");
    expect(
      startNativeHolderAsApp(
        { argv: ["node"], cwd: "/", environment: {}, socketPath: socketIn() },
        deps,
      ),
    ).toEqual({ ok: false, reason: "not-darwin", errorName: null });
    expect(ran).toEqual([]);
  });

  it("reports open-failed when open refuses", () => {
    const { deps } = recordingDeps("darwin");
    deps.run = (command) => {
      if (command === "/usr/bin/open") throw new Error("open failed");
    };
    expect(
      startNativeHolderAsApp(
        { argv: ["node"], cwd: "/", environment: {}, socketPath: socketIn() },
        deps,
      ),
    ).toEqual({ ok: false, reason: "open-failed", errorName: "Error" });
  });

  it("reports bundle-failed when codesign fails", () => {
    const { deps } = recordingDeps("darwin");
    deps.run = (command) => {
      if (command === "/usr/bin/codesign") throw new Error("codesign failed");
    };
    expect(
      startNativeHolderAsApp(
        { argv: ["node"], cwd: "/", environment: {}, socketPath: socketIn() },
        deps,
      ),
    ).toEqual({ ok: false, reason: "bundle-failed", errorName: "Error" });
  });

  it("deletes environment files older than 60 s before writing a new one", () => {
    const socket = socketIn();
    const dir = path.dirname(socket);
    const stale = path.join(dir, "old.env");
    const fresh = path.join(dir, "fresh.env");
    writeFileSync(stale, "{}", { mode: 0o600 });
    writeFileSync(fresh, "{}", { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old);
    const { deps } = recordingDeps("darwin");
    startNativeHolderAsApp(
      { argv: ["node"], cwd: "/", environment: {}, socketPath: socket },
      deps,
    );
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("native holder app fallback", () => {
  function spawnWith(
    platform: NodeJS.Platform,
    run: NativeHolderAppDeps["run"],
  ): { socket: string; stderr: string[]; log: string } {
    const socket = socketIn();
    const stderr: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
    try {
      spawnNativeHolder("thr_abc", socket, { platform, run }, 1, "0123456789abcdef");
    } finally {
      write.mockRestore();
    }
    const logPath = socket.replace(/\.sock$/u, ".log");
    return {
      socket,
      stderr,
      log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
    };
  }

  it("logs holder-app-fallback with open-failed, warns, and leaves no env file", () => {
    const result = spawnWith("darwin", (command) => {
      if (command === "/usr/bin/open") throw new Error("open failed");
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toContain("native-hold");
    expect(result.log).toContain("holder-app-fallback");
    expect(result.log).toContain("open-failed");
    expect(result.stderr.join("")).toContain(
      "native holder started without swap protection (open-failed); a bb restart will end this session",
    );
    expect(
      readdirSync(path.dirname(result.socket)).filter((n) =>
        n.endsWith(".env"),
      ),
    ).toEqual([]);
  });

  it("logs bundle-failed when codesign fails", () => {
    const result = spawnWith("darwin", (command) => {
      if (command === "/usr/bin/codesign") throw new Error("codesign failed");
    });
    expect(result.log).toContain("holder-app-fallback");
    expect(result.log).toContain("bundle-failed");
  });

  it("logs nothing and stays quiet off darwin", () => {
    const result = spawnWith("linux", () => {});
    expect(spawned).toHaveLength(1);
    expect(result.log).toBe("");
    expect(result.stderr).toEqual([]);
  });

  it("removes the app's environment file and starts one detached holder when the app never came up", () => {
    const socket = socketIn();
    const { deps } = recordingDeps("darwin");
    const environmentFile = spawnNativeHolder(
      "thr_abc",
      socket,
      deps,
      1,
      "0123456789abcdef",
    );
    expect(environmentFile).not.toBeNull();
    expect(existsSync(environmentFile ?? "")).toBe(true);
    expect(spawned).toHaveLength(0);
    const stderr: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
    try {
      startNativeHolderFallback(
        "thr_abc",
        socket,
        environmentFile ?? "",
        2,
        "fedcba9876543210",
      );
    } finally {
      write.mockRestore();
    }
    expect(existsSync(environmentFile ?? "")).toBe(false);
    expect(
      readdirSync(path.dirname(socket)).filter((n) => n.endsWith(".env")),
    ).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toContain("native-hold");
    const log = readFileSync(socket.replace(/\.sock$/u, ".log"), "utf8");
    expect(log).toContain("holder-app-fallback");
    expect(log).toContain("app-not-ready");
    expect(stderr.join("")).toContain(
      "native holder started without swap protection (app-not-ready)",
    );
  });

  it("starts no second holder while a live holder is delayed before it reads its environment file", async () => {
    const socket = socketIn();
    const { deps } = recordingDeps("darwin");
    let environmentFile: string | null = null;
    let listener: net.Server | null = null;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const connection = await openNativeHolderConnection({
        socketPath: socket,
        reattachOnly: false,
        startHolder: (markerGeneration, markerToken) => {
          environmentFile = spawnNativeHolder(
            "thr_abc",
            socket,
            deps,
            markerGeneration,
            markerToken,
          );
          setTimeout(
            () =>
              writeNativeHolderPidMarker(
                socket,
                process.pid,
                markerGeneration,
                markerToken,
              ),
            100,
          );
          setTimeout(() => {
            listener = net.createServer().listen(socket);
          }, 900);
        },
        startFallbackHolder: (markerGeneration, markerToken) => {
          startNativeHolderFallback(
            "thr_abc",
            socket,
            environmentFile ?? "",
            markerGeneration,
            markerToken,
          );
        },
        holderHasStarted: () => nativeHolderProcessIsAlive(socket),
        fallbackWindowMs: 300,
        startTimeoutMs: 6_000,
      });
      if (connection.kind !== "attached") throw new Error(connection.kind);
      connection.socket.destroy();
      expect(existsSync(environmentFile ?? "")).toBe(true);
      expect(spawned).toHaveLength(0);
    } finally {
      stderr.mockRestore();
      (listener as net.Server | null)?.close();
    }
  });

  it("starts the fallback when no holder process ever came up", async () => {
    const socket = socketIn();
    const { deps } = recordingDeps("darwin");
    let environmentFile: string | null = null;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const connection = await openNativeHolderConnection({
        socketPath: socket,
        reattachOnly: false,
        startHolder: (markerGeneration, markerToken) => {
          environmentFile = spawnNativeHolder(
            "thr_abc",
            socket,
            deps,
            markerGeneration,
            markerToken,
          );
        },
        startFallbackHolder: (markerGeneration, markerToken) => {
          startNativeHolderFallback(
            "thr_abc",
            socket,
            environmentFile ?? "",
            markerGeneration,
            markerToken,
          );
        },
        holderHasStarted: () => nativeHolderProcessIsAlive(socket),
        fallbackWindowMs: 200,
        startTimeoutMs: 500,
      });
      expect(connection.kind).toBe("did-not-start");
      expect(spawned).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  function startOwnedHolder(
    socket: string,
    counters: { socketOwners: number; ptyStarts: number },
    markerGeneration: number,
    markerToken: string,
  ): { exited: Promise<number>; stop: () => void } {
    let finishPty:
      | ((event: { exitCode: number; signal?: number }) => void)
      | null = null;
    const exited = runNativeHolder({
      socketPath: socket,
      holderMarkerGeneration: markerGeneration,
      holderMarkerToken: markerToken,
      cwd: os.tmpdir(),
      env: {},
      firstClientTimeoutMs: 5_000,
      onSocketReady: () => {
        counters.socketOwners += 1;
      },
      prepare: async () => ({ command: "fake", args: [] }),
      spawnPty: () => {
        counters.ptyStarts += 1;
        return {
          pid: 4242,
          onData: () => undefined,
          onExit: (listener) => {
            finishPty = listener;
          },
          write: () => undefined,
          resize: () => undefined,
          kill: () => {
            finishPty?.({ exitCode: 0 });
          },
        };
      },
    });
    return {
      exited,
      stop: () => {
        finishPty?.({ exitCode: 0 });
      },
    };
  }

  it("launches one holder and connects both callers when two launchers start together", async () => {
    const socket = socketIn();
    let appLaunches = 0;
    const counters = { socketOwners: 0, ptyStarts: 0 };
    let holder: { exited: Promise<number>; stop: () => void } | null = null;
    const deps: NativeHolderAppDeps = {
      platform: "darwin",
      run: (command, args) => {
        if (command !== "/usr/bin/open") return;
        appLaunches += 1;
        const genIndex = args.indexOf("--marker-generation");
        const gen = Number.parseInt(args[genIndex + 1] ?? "0", 10);
        const tokenIndex = args.indexOf("--marker-token");
        const token = args[tokenIndex + 1] ?? "";
        setTimeout(
          () => writeNativeHolderPidMarker(socket, process.pid, gen, token),
          40,
        );
        setTimeout(() => {
          holder = startOwnedHolder(socket, counters, gen, token);
        }, 350);
      },
    };
    const launch = () => {
      let environmentFile: string | null = null;
      return openNativeHolderConnection({
        socketPath: socket,
        reattachOnly: false,
        startHolder: (markerGeneration, markerToken) => {
          environmentFile = spawnNativeHolder(
            "thr_abc",
            socket,
            deps,
            markerGeneration,
            markerToken,
          );
        },
        startFallbackHolder: (markerGeneration, markerToken) => {
          if (environmentFile === null) return;
          startNativeHolderFallback(
            "thr_abc",
            socket,
            environmentFile,
            markerGeneration,
            markerToken,
          );
        },
        holderHasStarted: () => nativeHolderProcessIsAlive(socket),
        fallbackWindowMs: 200,
        startTimeoutMs: 6_000,
      });
    };
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const [first, second] = await Promise.all([launch(), launch()]);
      if (first.kind !== "attached") throw new Error(first.kind);
      if (second.kind !== "attached") throw new Error(second.kind);
      expect(appLaunches).toBe(1);
      expect(spawned).toHaveLength(0);
      expect(counters.socketOwners).toBe(1);
      const resize = encodeNativeHolderFrame(
        NativeHolderFrame.resize,
        Buffer.from(JSON.stringify({ cols: 80, rows: 24 })),
      );
      first.socket.on("error", () => undefined);
      second.socket.on("error", () => undefined);
      if (!first.socket.destroyed) first.socket.write(resize);
      if (!second.socket.destroyed) second.socket.write(resize);
      await expect.poll(() => counters.ptyStarts).toBe(1);
      first.socket.destroy();
      second.socket.destroy();
      const activeHolder = holder as {
        exited: Promise<number>;
        stop: () => void;
      } | null;
      activeHolder?.stop();
      await expect(activeHolder?.exited).resolves.toBe(0);
    } finally {
      stderr.mockRestore();
    }
  });

  it("keeps a live pid marker and launches no second holder when a second launcher starts mid-boot", async () => {
    const socket = socketIn();
    let appLaunches = 0;
    const environmentFiles: string[] = [];
    const counters = { socketOwners: 0, ptyStarts: 0 };
    let holder: { exited: Promise<number>; stop: () => void } | null = null;
    let launchedGen = 0;
    let launchedToken = "";
    const deps: NativeHolderAppDeps = {
      platform: "darwin",
      run: (command, args) => {
        if (command !== "/usr/bin/open") return;
        appLaunches += 1;
        const genIndex = args.indexOf("--marker-generation");
        launchedGen = Number.parseInt(args[genIndex + 1] ?? "0", 10);
        const tokenIndex = args.indexOf("--marker-token");
        launchedToken = args[tokenIndex + 1] ?? "";
        setTimeout(
          () =>
            writeNativeHolderPidMarker(
              socket,
              process.pid,
              launchedGen,
              launchedToken,
            ),
          30,
        );
      },
    };
    const launch = () => {
      let environmentFile: string | null = null;
      return openNativeHolderConnection({
        socketPath: socket,
        reattachOnly: false,
        startHolder: (markerGeneration, markerToken) => {
          environmentFile = spawnNativeHolder(
            "thr_abc",
            socket,
            deps,
            markerGeneration,
            markerToken,
          );
          if (environmentFile !== null) environmentFiles.push(environmentFile);
        },
        startFallbackHolder: (markerGeneration, markerToken) => {
          if (environmentFile === null) return;
          startNativeHolderFallback(
            "thr_abc",
            socket,
            environmentFile,
            markerGeneration,
            markerToken,
          );
        },
        holderHasStarted: () => nativeHolderProcessIsAlive(socket),
        fallbackWindowMs: 200,
        startTimeoutMs: 6_000,
      });
    };
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const firstPromise = launch();
      await expect.poll(() => nativeHolderProcessIsAlive(socket)).toBe(true);
      const secondPromise = launch();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(nativeHolderPidMarkerPath(socket))).toBe(true);
      expect(nativeHolderProcessIsAlive(socket)).toBe(true);
      expect(appLaunches).toBe(1);
      expect(spawned).toHaveLength(0);
      expect(existsSync(environmentFiles[0] ?? "")).toBe(true);
      holder = startOwnedHolder(socket, counters, launchedGen, launchedToken);
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      if (first.kind !== "attached") throw new Error(first.kind);
      if (second.kind !== "attached") throw new Error(second.kind);
      expect(appLaunches).toBe(1);
      expect(spawned).toHaveLength(0);
      expect(counters.socketOwners).toBe(1);
      const resize = encodeNativeHolderFrame(
        NativeHolderFrame.resize,
        Buffer.from(JSON.stringify({ cols: 80, rows: 24 })),
      );
      first.socket.on("error", () => undefined);
      second.socket.on("error", () => undefined);
      if (!first.socket.destroyed) first.socket.write(resize);
      if (!second.socket.destroyed) second.socket.write(resize);
      await expect.poll(() => counters.ptyStarts).toBe(1);
      first.socket.destroy();
      second.socket.destroy();
      holder.stop();
      await expect(holder.exited).resolves.toBe(0);
    } finally {
      stderr.mockRestore();
      holder?.stop();
    }
  });

  it("preserves a live marker with identical content on spawn, waits on a pending marker, and advances past a dead pid", async () => {
    const socket = socketIn();
    const { deps, ran } = recordingDeps("darwin");
    const liveClaim = claimNativeHolderLaunch(socket);
    expect(liveClaim.claimed).toBe(true);
    expect(
      writeNativeHolderPidMarker(
        socket,
        process.pid,
        liveClaim.generation ?? 1,
        liveClaim.token ?? "",
      ),
    ).toBe(1);
    const liveMarkerPath = nativeHolderPidMarkerPath(socket);
    const liveMarkerContent = readFileSync(liveMarkerPath, "utf8");
    expect(liveMarkerContent.trim()).toBe(String(process.pid));
    expect(nativeHolderProcessIsAlive(socket)).toBe(true);
    spawnNativeHolder("thr_abc", socket, deps, 1, "0123456789abcdef");
    liveClaim.release();
    expect(existsSync(liveMarkerPath)).toBe(true);
    expect(readFileSync(liveMarkerPath, "utf8")).toBe(liveMarkerContent);
    expect(nativeHolderProcessIsAlive(socket)).toBe(true);
    const openCall = ran.find((call) => call.command === "/usr/bin/open");
    expect(openCall?.args).toEqual(
      expect.arrayContaining([
        "--marker-generation",
        "1",
        "--marker-token",
        "0123456789abcdef",
      ]),
    );

    const pendingSocket = socketIn();
    writeFileSync(`${pendingSocket.replace(/\.sock$/u, ".pid")}.1`, "", {
      mode: 0o600,
    });
    let pendingLaunches = 0;
    let pendingServer: net.Server | null = null;
    setTimeout(() => {
      pendingServer = net.createServer().listen(pendingSocket);
    }, 120);
    try {
      const pendingConn = await openNativeHolderConnection({
        socketPath: pendingSocket,
        reattachOnly: false,
        startHolder: () => {
          pendingLaunches += 1;
        },
        startTimeoutMs: 3_000,
      });
      if (pendingConn.kind !== "attached") throw new Error(pendingConn.kind);
      pendingConn.socket.destroy();
      expect(pendingLaunches).toBe(0);
    } finally {
      (pendingServer as net.Server | null)?.close();
    }

    const staleSocket = socketIn();
    const staleGen1 = `${staleSocket.replace(/\.sock$/u, ".pid")}.1`;
    writeFileSync(staleGen1, "2147483646\n", { mode: 0o600 });
    expect(nativeHolderProcessIsAlive(staleSocket)).toBe(false);
    let launches = 0;
    const counters = { socketOwners: 0, ptyStarts: 0 };
    let holder: { exited: Promise<number>; stop: () => void } | null = null;
    const staleDeps: NativeHolderAppDeps = {
      platform: "darwin",
      run: (command, args) => {
        if (command !== "/usr/bin/open") return;
        launches += 1;
        const genIndex = args.indexOf("--marker-generation");
        const gen = Number.parseInt(args[genIndex + 1] ?? "0", 10);
        const tokenIndex = args.indexOf("--marker-token");
        const token = args[tokenIndex + 1] ?? "";
        writeNativeHolderPidMarker(staleSocket, process.pid, gen, token);
        holder = startOwnedHolder(staleSocket, counters, gen, token);
      },
    };
    const connection = await openNativeHolderConnection({
      socketPath: staleSocket,
      reattachOnly: false,
      startHolder: (markerGeneration, markerToken) => {
        spawnNativeHolder(
          "thr_abc",
          staleSocket,
          staleDeps,
          markerGeneration,
          markerToken,
        );
      },
      holderHasStarted: () => nativeHolderProcessIsAlive(staleSocket),
      startTimeoutMs: 6_000,
    });
    if (connection.kind !== "attached") throw new Error(connection.kind);
    expect(launches).toBe(1);
    expect(counters.socketOwners).toBe(1);
    expect(existsSync(staleGen1)).toBe(false);
    expect(
      existsSync(`${staleSocket.replace(/\.sock$/u, ".pid")}.2`),
    ).toBe(true);
    const resize = encodeNativeHolderFrame(
      NativeHolderFrame.resize,
      Buffer.from(JSON.stringify({ cols: 80, rows: 24 })),
    );
    connection.socket.on("error", () => undefined);
    connection.socket.write(resize);
    await expect.poll(() => counters.ptyStarts).toBe(1);
    connection.socket.destroy();
    const activeHolder = holder as {
      exited: Promise<number>;
      stop: () => void;
    } | null;
    activeHolder?.stop();
    await expect(activeHolder?.exited).resolves.toBe(0);
    expect(nativeHolderProcessIsAlive(staleSocket)).toBe(false);
  });

  it("exits 1 on generationless, invalid-generation, empty-token, or bad-token launches without creating or modifying marker, socket, or log files", async () => {
    const snapshotDir = (
      dir: string,
    ): { entries: string[]; contents: Record<string, string> } => {
      const entries = readdirSync(dir).sort();
      const contents: Record<string, string> = {};
      for (const entry of entries) {
        const full = path.join(dir, entry);
        const stat = lstatSync(full);
        contents[entry] = stat.isSocket()
          ? "<socket>"
          : stat.isDirectory()
            ? "<dir>"
            : readFileSync(full, "utf8");
      }
      return { entries, contents };
    };

    const invokeNativeHoldCli = async (argv: string[]): Promise<number> => {
      const root = new Command();
      root.exitOverride();
      root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      const thread = root.command("thread");
      thread.exitOverride();
      thread.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      registerNativeCommands(thread, () => "http://127.0.0.1:1");
      for (const sub of thread.commands) {
        sub.exitOverride();
        sub.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      }
      const prevExitCode = process.exitCode;
      process.exitCode = 0;
      try {
        await root.parseAsync(["node", "bb", "thread", "native-hold", ...argv]);
        return typeof process.exitCode === "number" ? process.exitCode : 0;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "exitCode" in error &&
          typeof (error as { exitCode: unknown }).exitCode === "number"
        ) {
          return (error as { exitCode: number }).exitCode;
        }
        throw error;
      } finally {
        process.exitCode = prevExitCode;
      }
    };

    const callUntypedHold = holdNativeHarness as unknown as (
      ...args: unknown[]
    ) => Promise<number>;
    const callUntypedWriteMarker = writeNativeHolderPidMarker as unknown as (
      ...args: unknown[]
    ) => number | null;
    const cliRoot = path.resolve(import.meta.dirname, "../..");
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "bb-native-hold-cli-"));
    directories.push(dataDir);
    const spawnRealNativeHoldCli = (argv: string[]): Promise<number> => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        BB_CLI_REEXEC: "1",
        BB_DATA_DIR: dataDir,
        BB_SERVER_URL: "http://127.0.0.1:1",
      };
      delete env.BB_CLI;
      delete env.BB_ENVIRONMENT_ID;
      delete env.BB_NATIVE_HOLD_ENV_FILE;
      return new Promise((resolve) => {
        execFile(
          process.execPath,
          [
            "--conditions=source",
            "--import",
            "tsx",
            "src/index.ts",
            "thread",
            "native-hold",
            ...argv,
          ],
          { cwd: cliRoot, env },
          (error) => {
            const exitCode =
              error === null
                ? 0
                : typeof error.code === "number"
                  ? error.code
                  : 1;
            resolve(exitCode);
          },
        );
      });
    };

    const emptySocket = socketIn();
    const emptyDir = path.dirname(emptySocket);
    const beforeEmpty = snapshotDir(emptyDir);
    expect(beforeEmpty).toEqual({ entries: [], contents: {} });

    for (const cliArgs of [
      ["thr_abc", "--socket", emptySocket],
      ["thr_abc", "--socket", emptySocket, "--marker-generation", "1"],
      ["thr_abc", "--socket", emptySocket, "--marker-token", "0123456789abcdef"],
      [
        "thr_abc",
        "--socket",
        emptySocket,
        "--marker-generation",
        "0",
        "--marker-token",
        "0123456789abcdef",
      ],
      [
        "thr_abc",
        "--socket",
        emptySocket,
        "--marker-generation",
        "-1",
        "--marker-token",
        "0123456789abcdef",
      ],
      [
        "thr_abc",
        "--socket",
        emptySocket,
        "--marker-generation",
        "9007199254740992",
        "--marker-token",
        "0123456789abcdef",
      ],
      [
        "thr_abc",
        "--socket",
        emptySocket,
        "--marker-generation",
        "abc",
        "--marker-token",
        "0123456789abcdef",
      ],
      [
        "thr_abc",
        "--socket",
        emptySocket,
        "--marker-generation",
        "1",
        "--marker-token",
        "",
      ],
      [
        "thr_abc",
        "--socket",
        emptySocket,
        "--marker-generation",
        "1",
        "--marker-token",
        "deadbeefdeadbeef",
      ],
    ]) {
      await expect(invokeNativeHoldCli(cliArgs)).resolves.toBe(1);
      expect(snapshotDir(emptyDir)).toEqual(beforeEmpty);
    }

    for (const rawOpts of [
      undefined,
      {},
      { markerGeneration: 1 },
      { markerToken: "0123456789abcdef" },
      { markerGeneration: 0, markerToken: "0123456789abcdef" },
      { markerGeneration: -3, markerToken: "0123456789abcdef" },
      {
        markerGeneration: Number.MAX_SAFE_INTEGER + 1,
        markerToken: "0123456789abcdef",
      },
      { markerGeneration: 1, markerToken: "" },
      { markerGeneration: 1, markerToken: "deadbeefdeadbeef" },
    ]) {
      await expect(
        callUntypedHold("http://127.0.0.1:1", "thr_abc", emptySocket, rawOpts),
      ).resolves.toBe(1);
      expect(snapshotDir(emptyDir)).toEqual(beforeEmpty);
      expect(nativeHolderProcessIsAlive(emptySocket)).toBe(false);
    }
    expect(callUntypedWriteMarker(emptySocket, process.pid)).toBeNull();
    expect(callUntypedWriteMarker(emptySocket)).toBeNull();
    expect(snapshotDir(emptyDir)).toEqual(beforeEmpty);


    const seededSocket = socketIn();
    const seededDir = path.dirname(seededSocket);
    const seededClaim = claimNativeHolderLaunch(seededSocket);
    expect(seededClaim.claimed).toBe(true);
    const seededGen = seededClaim.generation ?? 1;
    writeFileSync(seededSocket.replace(/\.sock$/u, ".log"), "", {
      mode: 0o600,
    });
    const seededServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
      seededServer.once("error", reject);
      seededServer.listen(seededSocket, () => resolve());
    });
    try {
      const beforeSeeded = snapshotDir(seededDir);
      expect(beforeSeeded.entries.length).toBeGreaterThanOrEqual(3);

      for (const cliArgs of [
        ["thr_abc", "--socket", seededSocket],
        [
          "thr_abc",
          "--socket",
          seededSocket,
          "--marker-generation",
          String(seededGen),
        ],
        [
          "thr_abc",
          "--socket",
          seededSocket,
          "--marker-token",
          seededClaim.token ?? "",
        ],
        [
          "thr_abc",
          "--socket",
          seededSocket,
          "--marker-generation",
          "0",
          "--marker-token",
          seededClaim.token ?? "",
        ],
        [
          "thr_abc",
          "--socket",
          seededSocket,
          "--marker-generation",
          "9007199254740992",
          "--marker-token",
          seededClaim.token ?? "",
        ],
        [
          "thr_abc",
          "--socket",
          seededSocket,
          "--marker-generation",
          String(seededGen),
          "--marker-token",
          "",
        ],
        [
          "thr_abc",
          "--socket",
          seededSocket,
          "--marker-generation",
          String(seededGen),
          "--marker-token",
          "deadbeefdeadbeef",
        ],
      ]) {
        await expect(invokeNativeHoldCli(cliArgs)).resolves.toBe(1);
        expect(snapshotDir(seededDir)).toEqual(beforeSeeded);
      }

      for (const rawOpts of [
        undefined,
        {},
        { markerGeneration: seededGen },
        { markerToken: seededClaim.token ?? "" },
        { markerGeneration: 0, markerToken: seededClaim.token ?? "" },
        { markerGeneration: seededGen, markerToken: "" },
        { markerGeneration: seededGen, markerToken: "deadbeefdeadbeef" },
      ]) {
        await expect(
          callUntypedHold(
            "http://127.0.0.1:1",
            "thr_abc",
            seededSocket,
            rawOpts,
          ),
        ).resolves.toBe(1);
        expect(snapshotDir(seededDir)).toEqual(beforeSeeded);
      }
      expect(callUntypedWriteMarker(seededSocket, process.pid)).toBeNull();
      expect(snapshotDir(seededDir)).toEqual(beforeSeeded);
      for (const realArgs of [
        ["thr_abc", "--socket", seededSocket],
        [
          "thr_abc",
          "--socket",
          seededSocket,
          "--marker-generation",
          String(seededGen),
          "--marker-token",
          "deadbeefdeadbeef",
        ],
      ]) {
        await expect(spawnRealNativeHoldCli(realArgs)).resolves.toBe(1);
        expect(snapshotDir(seededDir)).toEqual(beforeSeeded);
      }
    } finally {
      seededClaim.release();
      await new Promise<void>((resolve) => seededServer.close(() => resolve()));
    }
  }, 45_000);

  it("claims the pre-launched generation marker before reading the environment file and aborts before touching files when the claim is already owned", async () => {
    const validSocket = socketIn();
    const validClaim = claimNativeHolderLaunch(validSocket);
    expect(validClaim.claimed).toBe(true);
    const previousEnv = process.env.BB_NATIVE_HOLD_ENV_FILE;
    process.env.BB_NATIVE_HOLD_ENV_FILE = path.join(
      path.dirname(validSocket),
      "missing.env",
    );
    try {
      await expect(
        holdNativeHarness("http://127.0.0.1:1", "thr_abc", validSocket, {
          markerGeneration: validClaim.generation ?? 1,
          markerToken: validClaim.token ?? "",
        }),
      ).resolves.toBe(1);
      expect(nativeHolderProcessIsAlive(validSocket)).toBe(true);
    } finally {
      validClaim.release();
      if (previousEnv === undefined) delete process.env.BB_NATIVE_HOLD_ENV_FILE;
      else process.env.BB_NATIVE_HOLD_ENV_FILE = previousEnv;
    }

    const fallbackSocket = socketIn();
    const fallbackEnv = path.join(path.dirname(fallbackSocket), "app.env");
    writeFileSync(fallbackEnv, "{}", { mode: 0o600 });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      startNativeHolderFallback(
        "thr_abc",
        fallbackSocket,
        fallbackEnv,
        2,
        "fedcba9876543210",
      );
    } finally {
      stderr.mockRestore();
    }
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining([
        "--marker-generation",
        "2",
        "--marker-token",
        "fedcba9876543210",
      ]),
    );

    const socket = socketIn();
    const claim = claimNativeHolderLaunch(socket);
    expect(claim.claimed).toBe(true);
    const generation = claim.generation ?? 1;
    const token = claim.token ?? "";
    const envFile = path.join(path.dirname(socket), "protected.env");
    writeFileSync(envFile, JSON.stringify({ PLAIN: "1" }), { mode: 0o600 });
    const previous = process.env.BB_NATIVE_HOLD_ENV_FILE;
    process.env.BB_NATIVE_HOLD_ENV_FILE = envFile;
    try {
      expect(
        writeNativeHolderPidMarker(socket, process.ppid, generation, token),
      ).toBe(generation);
      await expect(
        holdNativeHarness("http://127.0.0.1:1", "thr_abc", socket, {
          markerGeneration: generation,
          markerToken: token,
        }),
      ).resolves.toBe(1);
      expect(existsSync(envFile)).toBe(true);
      expect(existsSync(socket)).toBe(false);
      expect(readFileSync(nativeHolderPidMarkerPath(socket), "utf8").trim()).toBe(
        String(process.ppid),
      );
    } finally {
      claim.release();
      if (previous === undefined) delete process.env.BB_NATIVE_HOLD_ENV_FILE;
      else process.env.BB_NATIVE_HOLD_ENV_FILE = previous;
    }
  });
});
