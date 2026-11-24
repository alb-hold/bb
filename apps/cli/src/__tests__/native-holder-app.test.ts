import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnNativeHolder } from "../commands/thread/native.js";
import {
  startNativeHolderAsApp,
  type NativeHolderAppDeps,
} from "../native-holder-app.js";

const directories: string[] = [];

afterEach(() => {
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
    ).toBe(false);
    expect(ran).toEqual([]);
  });

  it("falls back to a direct spawn when open refuses", () => {
    const { deps } = recordingDeps("darwin");
    deps.run = (command) => {
      if (command === "/usr/bin/open") throw new Error("open failed");
    };
    expect(
      startNativeHolderAsApp(
        { argv: ["node"], cwd: "/", environment: {}, socketPath: socketIn() },
        deps,
      ),
    ).toBe(false);
  });
});
