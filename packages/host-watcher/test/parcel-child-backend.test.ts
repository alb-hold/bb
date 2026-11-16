import {
  execFile,
  fork,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { withPlatformParcelBackend } from "../src/parcel-backend-choice.js";
import type { ChildToParentMessage } from "../src/parcel-subprocess/messages.js";

const childEntry = new URL(
  "../src/parcel-subprocess/parcel-child-entry.ts",
  import.meta.url,
);
const inProcessFixture = new URL(
  "./fixtures/in-process-watch-children.ts",
  import.meta.url,
);
const execFileAsync = promisify(execFile);
const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const watchmanInstalled =
  spawnSync("sh", ["-c", "command -v watchman"]).status === 0;

function nextMessage(
  child: ChildProcess,
  wanted: (message: ChildToParentMessage) => boolean,
): Promise<ChildToParentMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      const typed = message as ChildToParentMessage;
      if (!wanted(typed)) return;
      child.off("message", onMessage);
      resolve(typed);
    };
    child.on("message", onMessage);
    child.once("exit", (code) =>
      reject(new Error(`watcher child exited (${code})`)),
    );
  });
}

async function childProcessesOf(pid: number): Promise<string[]> {
  const listed: string[] = [];
  for (const task of await readdir(`/proc/${pid}/task`)) {
    const text = await readFile(`/proc/${pid}/task/${task}/children`, "utf8");
    listed.push(...text.split(/\s+/u).filter((entry) => entry !== ""));
  }
  return listed;
}

async function pathWith(watchman: "executable" | "plain" | "directory") {
  const root = await mkdtemp(join(tmpdir(), "bb-parcel-path-"));
  roots.push(root);
  const empty = join(root, "empty");
  const bin = join(root, "bin");
  await mkdir(empty);
  await mkdir(bin);
  const target = join(bin, "watchman");
  if (watchman === "directory") await mkdir(target);
  else {
    await writeFile(target, "#!/bin/sh\nexit 0\n");
    await chmod(target, watchman === "executable" ? 0o755 : 0o644);
  }
  return { PATH: [join(root, "missing"), empty, bin].join(":") };
}

describe("the platform watcher backend", () => {
  it.each([
    ["linux", "inotify"],
    ["darwin", "fs-events"],
  ] as const)(
    "picks %s's native backend when no watchman is on PATH",
    async (platform, backend) => {
      const env = { PATH: await mkdtemp(join(tmpdir(), "bb-parcel-path-")) };
      roots.push(env.PATH);
      expect(withPlatformParcelBackend({}, platform, env)).toEqual({ backend });
      expect(withPlatformParcelBackend(undefined, platform, env)).toEqual({
        backend,
      });
      expect(
        withPlatformParcelBackend({ ignore: ["logs"] }, platform, env),
      ).toEqual({ ignore: ["logs"], backend });
    },
  );

  it.each(["linux", "darwin"] as const)(
    "leaves %s on parcel's default when an executable watchman is on PATH after a missing directory",
    async (platform) => {
      const env = await pathWith("executable");
      expect(withPlatformParcelBackend({}, platform, env)).toEqual({});
      expect(
        withPlatformParcelBackend(undefined, platform, env),
      ).toBeUndefined();
      expect(
        withPlatformParcelBackend({ ignore: ["logs"] }, platform, env),
      ).toEqual({ ignore: ["logs"] });
    },
  );

  it.each(["plain", "directory"] as const)(
    "treats a watchman that is a %s, not an executable file, as absent",
    async (watchman) => {
      const env = await pathWith(watchman);
      expect(withPlatformParcelBackend({}, "linux", env)).toEqual({
        backend: "inotify",
      });
    },
  );

  it.each([
    ["an empty", { PATH: "" }],
    ["a missing", {}],
  ] as const)("picks the native backend with %s PATH", (_label, env) => {
    expect(withPlatformParcelBackend({}, "linux", env)).toEqual({
      backend: "inotify",
    });
    expect(withPlatformParcelBackend({}, "darwin", env)).toEqual({
      backend: "fs-events",
    });
  });

  it("keeps an explicit backend and leaves other platforms on the default", () => {
    expect(
      withPlatformParcelBackend({ backend: "brute-force" }, "linux"),
    ).toEqual({ backend: "brute-force" });
    expect(withPlatformParcelBackend({ ignore: ["x"] }, "win32")).toEqual({
      ignore: ["x"],
    });
    expect(withPlatformParcelBackend(undefined, "freebsd")).toBeUndefined();
  });
});

describe.skipIf(process.platform !== "linux" || watchmanInstalled)(
  "the watcher child on Linux without watchman",
  () => {
    it("starts no child process during a subscribe", async () => {
      const root = await mkdtemp(join(tmpdir(), "bb-parcel-child-"));
      roots.push(root);
      const child = fork(childEntry, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      children.push(child);
      await nextMessage(child, (message) => message.kind === "ready");
      const before = new Set(await childProcessesOf(child.pid ?? 0));
      const subscribed = nextMessage(
        child,
        (message) =>
          (message.kind === "subscribed" ||
            message.kind === "subscribe-failed") &&
          message.id === "row",
      );
      child.send({ kind: "subscribe", id: "row", dir: root, opts: {} });
      expect(await subscribed).toEqual({ kind: "subscribed", id: "row" });
      const started = (await childProcessesOf(child.pid ?? 0)).filter(
        (pid) => !before.has(pid),
      );
      expect(started).toEqual([]);
    });

    it("starts no child process during an in-process subscribe", async () => {
      const root = await mkdtemp(join(tmpdir(), "bb-parcel-in-process-"));
      roots.push(root);
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", fileURLToPath(inProcessFixture), root],
        { timeout: 30_000 },
      );
      expect(JSON.parse(stdout)).toEqual([]);
    });
  },
);
