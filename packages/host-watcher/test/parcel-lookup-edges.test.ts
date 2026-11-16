import { fork, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withPlatformParcelBackend } from "../src/parcel-backend-choice.js";
import type { ChildToParentMessage } from "../src/parcel-subprocess/messages.js";

const MARKER = "bb-watchman-ran";
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0).reverse()) {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-parcel-edges-"));
  roots.push(root);
  await mkdir(join(root, "work"));
  await mkdir(join(root, "home"));
  return root;
}

async function fakeWatchman(target: string, mode = 0o755): Promise<void> {
  await writeFile(target, `#!/bin/sh\necho ${MARKER}\n`);
  await chmod(target, mode);
}

function lookupFinds(env: NodeJS.ProcessEnv, cwd: string): boolean {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  return (
    withPlatformParcelBackend({}, platform, env, cwd)?.backend === undefined
  );
}

function shellRuns(env: NodeJS.ProcessEnv, cwd: string): boolean {
  const done = spawnSync("/bin/sh", ["-c", "watchman"], {
    env,
    cwd,
    encoding: "utf8",
  });
  return done.stdout.includes(MARKER);
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "the watchman lookup against /bin/sh -c watchman",
  () => {
    const cases: Array<[string, (root: string) => Promise<NodeJS.ProcessEnv>]> =
      [
        [
          "a literal ~ in a PATH entry, with watchman under HOME",
          async (root) => {
            await mkdir(join(root, "home", "bin"));
            await fakeWatchman(join(root, "home", "bin", "watchman"));
            return { PATH: "~/bin", HOME: join(root, "home") };
          },
        ],
        [
          "a literal ~ in a PATH entry, with a directory named ~ in the working directory",
          async (root) => {
            await mkdir(join(root, "work", "~", "bin"), { recursive: true });
            await fakeWatchman(join(root, "work", "~", "bin", "watchman"));
            return { PATH: "~/bin", HOME: join(root, "home") };
          },
        ],
        [
          "a literal $HOME in a PATH entry, with watchman under HOME",
          async (root) => {
            await mkdir(join(root, "home", "bin"));
            await fakeWatchman(join(root, "home", "bin", "watchman"));
            return { PATH: "$HOME/bin", HOME: join(root, "home") };
          },
        ],
        [
          "an executable named Watchman, in another case",
          async (root) => {
            await mkdir(join(root, "bin"));
            await fakeWatchman(join(root, "bin", "Watchman"));
            return { PATH: join(root, "bin"), HOME: join(root, "home") };
          },
        ],
        [
          "a watchman symlink to a missing target",
          async (root) => {
            await mkdir(join(root, "bin"));
            await symlink(join(root, "gone"), join(root, "bin", "watchman"));
            return { PATH: join(root, "bin"), HOME: join(root, "home") };
          },
        ],
        [
          "a watchman symlink to a directory",
          async (root) => {
            await mkdir(join(root, "bin"));
            await mkdir(join(root, "dir"));
            await symlink(join(root, "dir"), join(root, "bin", "watchman"));
            return { PATH: join(root, "bin"), HOME: join(root, "home") };
          },
        ],
        [
          "a watchman symlink to an executable file",
          async (root) => {
            await mkdir(join(root, "bin"));
            await fakeWatchman(join(root, "real-watchman"));
            await symlink(
              join(root, "real-watchman"),
              join(root, "bin", "watchman"),
            );
            return { PATH: join(root, "bin"), HOME: join(root, "home") };
          },
        ],
        [
          "a watchman symlink to a missing target ahead of an executable watchman",
          async (root) => {
            await mkdir(join(root, "bin"));
            await mkdir(join(root, "later"));
            await symlink(join(root, "gone"), join(root, "bin", "watchman"));
            await fakeWatchman(join(root, "later", "watchman"));
            return {
              PATH: [join(root, "bin"), join(root, "later")].join(":"),
              HOME: join(root, "home"),
            };
          },
        ],
        [
          "a PATH entry inside a directory that cannot be searched",
          async (root) => {
            await mkdir(join(root, "locked", "bin"), { recursive: true });
            await fakeWatchman(join(root, "locked", "bin", "watchman"));
            await chmod(join(root, "locked"), 0o000);
            roots.push(join(root, "locked"));
            return {
              PATH: join(root, "locked", "bin"),
              HOME: join(root, "home"),
            };
          },
        ],
      ];

    it("never finds watchman through a ~user entry that the shell might expand, and on Linux agrees with the shell", async () => {
      const root = await scratch();
      await mkdir(join(root, "work", "~bb-no-such-user", "bin"), {
        recursive: true,
      });
      await fakeWatchman(
        join(root, "work", "~bb-no-such-user", "bin", "watchman"),
      );
      const env = { PATH: "~bb-no-such-user/bin", HOME: join(root, "home") };
      const cwd = join(root, "work");
      if (process.platform === "darwin")
        expect(lookupFinds(env, cwd)).toBe(false);
      else expect(lookupFinds(env, cwd)).toBe(shellRuns(env, cwd));
    });

    it.each(cases)("agrees with the shell on %s", async (_label, arrange) => {
      const root = await scratch();
      const env = await arrange(root);
      const cwd = join(root, "work");
      expect(lookupFinds(env, cwd)).toBe(shellRuns(env, cwd));
    });
  },
);

const childEntry = new URL(
  "../src/parcel-subprocess/parcel-child-entry.ts",
  import.meta.url,
);

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

describe.skipIf(process.platform !== "linux")(
  "the watcher child with a watchman that answers nothing",
  () => {
    it("leaves no child process behind after a subscribe", async () => {
      const root = await scratch();
      await mkdir(join(root, "bin"));
      await writeFile(join(root, "bin", "watchman"), "#!/bin/sh\nexit 0\n");
      await chmod(join(root, "bin", "watchman"), 0o755);
      const child = fork(childEntry, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: {
          ...process.env,
          PATH: [join(root, "bin"), process.env.PATH ?? ""].join(":"),
        },
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
      const described = await Promise.all(
        started.map(async (pid) => {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(
            () => "",
          );
          const close = stat.lastIndexOf(")");
          return `${stat.slice(stat.indexOf("(") + 1, close)} ${stat.slice(close + 2, close + 3)}`;
        }),
      );
      expect(described).toEqual([]);
    }, 60_000);
  },
);
