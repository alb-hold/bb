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
import {
  spawnNativeHolder,
  startNativeHolderFallback,
} from "../commands/thread/native.js";
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
    expect(open?.args.some((a) => a.startsWith("BB_NATIVE_HOLD_CWD="))).toBe(
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
});
