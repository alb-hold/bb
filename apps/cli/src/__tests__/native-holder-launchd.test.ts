import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnNativeHolder } from "../commands/thread/native.js";
import {
  NATIVE_HOLDER_LAUNCHD_LABEL_ENV,
  nativeHolderLaunchdLabel,
  removeNativeHolderLaunchdJob,
  startNativeHolderInOwnCoalition,
  type NativeHolderLaunchdDeps,
} from "../native-holder-launchd.js";

const SOCKET = "/tmp/bb-nh-test/thr_abc-c417c3fe.sock";

function recordingDeps(platform: NodeJS.Platform): {
  deps: NativeHolderLaunchdDeps;
  ran: string[][];
  fired: string[][];
  plists: string[];
} {
  const ran: string[][] = [];
  const fired: string[][] = [];
  const plists: string[] = [];
  return {
    ran,
    fired,
    plists,
    deps: {
      platform,
      uid: 501,
      tmpDir: "/tmp",
      runLaunchctl: (args) => {
        ran.push(args);
        if (args[0] === "bootstrap" && args[2] !== undefined) {
          plists.push(readFileSync(args[2], "utf8"));
        }
      },
      fireLaunchctl: (args) => {
        fired.push(args);
      },
    },
  };
}

describe("native holder launchd launch", () => {
  it("starts the holder through launchd on darwin, in the user's gui domain, never respawning", () => {
    const { deps, ran, plists } = recordingDeps("darwin");
    spawnNativeHolder("thr_abc", SOCKET, deps);
    const bootstrap = ran.find((args) => args[0] === "bootstrap");
    expect(bootstrap?.[1]).toBe("gui/501");
    expect(plists).toHaveLength(1);
    const plist = plists[0] ?? "";
    const label = nativeHolderLaunchdLabel(SOCKET);
    expect(label).toBe("dev.bb.native-hold.thr_abc-c417c3fe");
    expect(plist).toContain(`<key>Label</key><string>${label}</string>`);
    expect(plist).toContain("<string>native-hold</string>");
    expect(plist).toContain("<string>thr_abc</string>");
    expect(plist).toContain(`<string>${SOCKET}</string>`);
    expect(plist).toContain("<key>KeepAlive</key><false/>");
    expect(plist).toContain(
      `<key>${NATIVE_HOLDER_LAUNCHD_LABEL_ENV}</key><string>${label}</string>`,
    );
  });

  it("does not use launchd off darwin", () => {
    const { deps, ran } = recordingDeps("linux");
    expect(
      startNativeHolderInOwnCoalition(
        { argv: ["node"], cwd: "/", environment: {}, socketPath: SOCKET },
        deps,
      ),
    ).toBe(false);
    expect(ran).toEqual([]);
  });

  it("falls back to a direct spawn when launchd refuses the job", () => {
    const { deps } = recordingDeps("darwin");
    deps.runLaunchctl = () => {
      throw new Error("bootstrap failed");
    };
    expect(
      startNativeHolderInOwnCoalition(
        { argv: ["node"], cwd: "/", environment: {}, socketPath: SOCKET },
        deps,
      ),
    ).toBe(false);
  });
});

describe("native holder launchd job removal", () => {
  it("boots the job out when the holder finishes", () => {
    const { deps, fired } = recordingDeps("darwin");
    removeNativeHolderLaunchdJob(
      { [NATIVE_HOLDER_LAUNCHD_LABEL_ENV]: "dev.bb.native-hold.x" },
      deps,
    );
    expect(fired).toEqual([["bootout", "gui/501/dev.bb.native-hold.x"]]);
  });

  it("leaves launchd alone for a holder that was not launched by it", () => {
    const { deps, fired } = recordingDeps("darwin");
    removeNativeHolderLaunchdJob({}, deps);
    expect(fired).toEqual([]);
  });
});
