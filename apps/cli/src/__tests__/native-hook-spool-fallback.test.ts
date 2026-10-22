import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hookSpoolCandidates,
  hookSpoolSupportsLinks,
  openHookSpool,
} from "../native-hook-spool.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function root(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bb-spool-fallback-"));
  roots.push(directory);
  return directory;
}

function groupAndOtherBits(directory: string): number {
  return process.platform === "win32" ? 0 : statSync(directory).mode & 0o077;
}

function refuseLinksUnder(
  refused: string,
): (directory: string) => boolean {
  return (directory) =>
    path.dirname(directory) === refused ? false : hookSpoolSupportsLinks(directory);
}

describe("choosing where the hook spool lives", () => {
  it("lists the system temp directory first, then a valid XDG_RUNTIME_DIR, then a directory under the bb home", () => {
    const base = root();
    const runtime = path.join(base, "run");
    mkdirSync(runtime);
    expect(
      hookSpoolCandidates({
        env: { XDG_RUNTIME_DIR: runtime },
        home: "/home/someone",
        tmpDir: "/tmp",
      }),
    ).toEqual([
      "/tmp",
      runtime,
      path.join("/home/someone", ".bb", "native-terminals", "hooks"),
    ]);
  });

  it("leaves XDG_RUNTIME_DIR out when it is unset, relative, missing or not a directory", () => {
    const base = root();
    const file = path.join(base, "file");
    writeFileSync(file, "");
    const home = path.join(base, "home");
    const expected = [
      "/tmp",
      path.join(home, ".bb", "native-terminals", "hooks"),
    ];
    for (const env of [
      {},
      { XDG_RUNTIME_DIR: "relative/run" },
      { XDG_RUNTIME_DIR: path.join(base, "missing") },
      { XDG_RUNTIME_DIR: file },
    ]) {
      expect(hookSpoolCandidates({ env, home, tmpDir: "/tmp" })).toEqual(
        expected,
      );
    }
  });

  it("uses the first candidate when it supports links, and does not report anything", () => {
    const [first, second] = [root(), root()];
    let unsupported = 0;
    const spool = openHookSpool([first, second], "thread", () => {
      unsupported += 1;
    });
    expect(spool).not.toBeNull();
    expect(path.dirname(spool ?? "")).toBe(first);
    expect(readdirSync(second)).toEqual([]);
    expect(unsupported).toBe(0);
    expect(groupAndOtherBits(spool ?? "")).toBe(0);
  });

  it("falls back to the next candidate when the first refuses links, removing what it created there", () => {
    const [refusing, working] = [root(), root()];
    let unsupported = 0;
    const spool = openHookSpool(
      [refusing, working],
      "thread",
      () => {
        unsupported += 1;
      },
      refuseLinksUnder(refusing),
    );
    expect(path.dirname(spool ?? "")).toBe(working);
    expect(readdirSync(refusing)).toEqual([]);
    expect(unsupported).toBe(0);
  });

  it("falls back past a candidate that cannot be created at all, and creates a missing private parent", () => {
    const base = root();
    const blocker = path.join(base, "blocker");
    writeFileSync(blocker, "");
    const created = path.join(base, ".bb", "native-terminals", "hooks");
    let unsupported = 0;
    const spool = openHookSpool(
      [path.join(blocker, "child"), created],
      "thread",
      () => {
        unsupported += 1;
      },
    );
    expect(path.dirname(spool ?? "")).toBe(created);
    expect(groupAndOtherBits(created)).toBe(0);
    expect(unsupported).toBe(0);
  });

  it("reports unsupported once, and only when every candidate fails, leaving nothing behind", () => {
    const [first, second] = [root(), root()];
    const blocker = path.join(first, "blocker");
    writeFileSync(blocker, "");
    let unsupported = 0;
    const spool = openHookSpool(
      [path.join(blocker, "child"), second],
      "thread",
      () => {
        unsupported += 1;
      },
      refuseLinksUnder(second),
    );
    expect(spool).toBeNull();
    expect(unsupported).toBe(1);
    expect(readdirSync(second)).toEqual([]);
    expect(existsSync(path.join(blocker, "child"))).toBe(false);
  });

  it("probes a directory that does not exist as unsupported", () => {
    expect(hookSpoolSupportsLinks(path.join(root(), "missing"))).toBe(false);
  });
});
