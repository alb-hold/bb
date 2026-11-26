import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import {
  holdNativeHarness,
  spawnNativeHolder,
  startNativeHolderFallback,
} from "../commands/thread/native.js";
import {
  NativeHolderFrame,
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
    spawnNativeHolder("thr_abc", socket, deps);
    const open = ran.find((call) => call.command === "/usr/bin/open");
    expect(open?.args.slice(0, 3)).toEqual(["-n", "-g", "-j"]);
    const bundle = open?.args[3] ?? "";
    expect(bundle).toBe(path.join(path.dirname(socket), "bb-native-hold.app"));
    const argsAt = open?.args.indexOf("--args") ?? -1;
    expect(open?.args.slice(argsAt + 1)).toEqual(
      expect.arrayContaining(["native-hold", "thr_abc", "--socket", socket]),
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
      spawnNativeHolder("thr_abc", socket, { platform, run });
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
    const environmentFile = spawnNativeHolder("thr_abc", socket, deps);
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
      startNativeHolderFallback("thr_abc", socket, environmentFile ?? "");
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
        startHolder: () => {
          environmentFile = spawnNativeHolder("thr_abc", socket, deps);
          setTimeout(() => writeNativeHolderPidMarker(socket), 100);
          setTimeout(() => {
            listener = net.createServer().listen(socket);
          }, 900);
        },
        startFallbackHolder: () => {
          startNativeHolderFallback("thr_abc", socket, environmentFile ?? "");
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
        startHolder: () => {
          environmentFile = spawnNativeHolder("thr_abc", socket, deps);
        },
        startFallbackHolder: () => {
          startNativeHolderFallback("thr_abc", socket, environmentFile ?? "");
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
  ): { exited: Promise<number>; stop: () => void } {
    let finishPty:
      | ((event: { exitCode: number; signal?: number }) => void)
      | null = null;
    const exited = runNativeHolder({
      socketPath: socket,
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
      run: (command) => {
        if (command !== "/usr/bin/open") return;
        appLaunches += 1;
        setTimeout(() => writeNativeHolderPidMarker(socket), 40);
        setTimeout(() => {
          holder = startOwnedHolder(socket, counters);
        }, 350);
      },
    };
    const launch = () => {
      let environmentFile: string | null = null;
      return openNativeHolderConnection({
        socketPath: socket,
        reattachOnly: false,
        startHolder: () => {
          environmentFile = spawnNativeHolder("thr_abc", socket, deps);
        },
        startFallbackHolder: () => {
          if (environmentFile === null) return;
          startNativeHolderFallback("thr_abc", socket, environmentFile);
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
    const deps: NativeHolderAppDeps = {
      platform: "darwin",
      run: (command) => {
        if (command !== "/usr/bin/open") return;
        appLaunches += 1;
        setTimeout(() => writeNativeHolderPidMarker(socket), 30);
      },
    };
    const launch = () => {
      let environmentFile: string | null = null;
      return openNativeHolderConnection({
        socketPath: socket,
        reattachOnly: false,
        startHolder: () => {
          environmentFile = spawnNativeHolder("thr_abc", socket, deps);
          if (environmentFile !== null) environmentFiles.push(environmentFile);
        },
        startFallbackHolder: () => {
          if (environmentFile === null) return;
          startNativeHolderFallback("thr_abc", socket, environmentFile);
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
      holder = startOwnedHolder(socket, counters);
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

  it("clears a stale marker on spawn, preserves a live marker, and launches once after a dead pid", async () => {
    const socket = socketIn();
    writeFileSync(nativeHolderPidMarkerPath(socket), "2147483646");
    expect(nativeHolderProcessIsAlive(socket)).toBe(false);
    const { deps } = recordingDeps("darwin");
    spawnNativeHolder("thr_abc", socket, deps);
    expect(existsSync(nativeHolderPidMarkerPath(socket))).toBe(false);

    writeNativeHolderPidMarker(socket);
    expect(nativeHolderProcessIsAlive(socket)).toBe(true);
    spawnNativeHolder("thr_abc", socket, deps);
    expect(existsSync(nativeHolderPidMarkerPath(socket))).toBe(true);
    expect(nativeHolderProcessIsAlive(socket)).toBe(true);

    const staleSocket = socketIn();
    writeFileSync(nativeHolderPidMarkerPath(staleSocket), "2147483646");
    let launches = 0;
    const counters = { socketOwners: 0, ptyStarts: 0 };
    let holder: { exited: Promise<number>; stop: () => void } | null = null;
    const staleDeps: NativeHolderAppDeps = {
      platform: "darwin",
      run: (command) => {
        if (command !== "/usr/bin/open") return;
        launches += 1;
        writeNativeHolderPidMarker(staleSocket);
        holder = startOwnedHolder(staleSocket, counters);
      },
    };
    const connection = await openNativeHolderConnection({
      socketPath: staleSocket,
      reattachOnly: false,
      startHolder: () => {
        spawnNativeHolder("thr_abc", staleSocket, staleDeps);
      },
      holderHasStarted: () => nativeHolderProcessIsAlive(staleSocket),
      startTimeoutMs: 6_000,
    });
    if (connection.kind !== "attached") throw new Error(connection.kind);
    expect(launches).toBe(1);
    expect(counters.socketOwners).toBe(1);
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
  });

  it("writes the pid marker before it reads the environment file", async () => {
    const socket = socketIn();
    const previous = process.env.BB_NATIVE_HOLD_ENV_FILE;
    process.env.BB_NATIVE_HOLD_ENV_FILE = path.join(
      path.dirname(socket),
      "missing.env",
    );
    try {
      await expect(
        holdNativeHarness("http://127.0.0.1:1", "thr_abc", socket),
      ).resolves.toBe(1);
    } finally {
      if (previous === undefined) delete process.env.BB_NATIVE_HOLD_ENV_FILE;
      else process.env.BB_NATIVE_HOLD_ENV_FILE = previous;
    }
    expect(nativeHolderProcessIsAlive(socket)).toBe(true);
  });
});
