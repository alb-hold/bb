import {
  execFile,
  fork,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

describe("the platform watcher backend", () => {
  it.each([
    ["linux", "inotify"],
    ["darwin", "fs-events"],
  ] as const)("picks %s's native backend", (platform, backend) => {
    expect(withPlatformParcelBackend({}, platform)).toEqual({ backend });
    expect(withPlatformParcelBackend(undefined, platform)).toEqual({ backend });
    expect(withPlatformParcelBackend({ ignore: ["logs"] }, platform)).toEqual({
      ignore: ["logs"],
      backend,
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
