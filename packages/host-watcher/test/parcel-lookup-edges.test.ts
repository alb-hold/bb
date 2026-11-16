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
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  choosePlatformParcelBackend,
  withPlatformParcelBackend,
} from "../src/parcel-backend-choice.js";
import type { ChildToParentMessage } from "../src/parcel-subprocess/messages.js";

const MARKER = "bb-watchman-ran";
const execFileAsync = promisify(execFile);
const roots: string[] = [];
const children: ChildProcess[] = [];
const holders: number[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const pid of holders.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
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
  return (
    withPlatformParcelBackend({}, "linux", env, cwd)?.backend === undefined
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

describe.skipIf(process.platform !== "linux")(
  "the Linux watchman lookup against /bin/sh -c watchman",
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
          "a literal ~user in a PATH entry, with a directory of that name in the working directory",
          async (root) => {
            await mkdir(join(root, "work", "~bb-no-such-user", "bin"), {
              recursive: true,
            });
            await fakeWatchman(
              join(root, "work", "~bb-no-such-user", "bin", "watchman"),
            );
            return { PATH: "~bb-no-such-user/bin", HOME: join(root, "home") };
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

    it.each(cases)("agrees with the shell on %s", async (_label, arrange) => {
      const root = await scratch();
      const env = await arrange(root);
      const cwd = join(root, "work");
      expect(lookupFinds(env, cwd)).toBe(shellRuns(env, cwd));
    });
  },
);

async function watchmanAt(root: string, script: string): Promise<string> {
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "watchman"), `#!/bin/sh\n${script}\n`);
  await chmod(join(root, "bin", "watchman"), 0o755);
  return [join(root, "bin"), "/usr/bin", "/bin"].join(":");
}

async function processGroupMembers(pgid: string): Promise<string[]> {
  const members: string[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[2] === pgid) members.push(`${entry} ${fields[0]}`);
  }
  return members;
}

describe("the backend choice on darwin", () => {
  it("passes fs-events even with an executable watchman first on PATH", async () => {
    const root = await scratch();
    const PATH = await watchmanAt(root, `echo ${MARKER}`);
    expect(withPlatformParcelBackend({}, "darwin", { PATH }, root)).toEqual({
      backend: "fs-events",
    });
    expect(
      await choosePlatformParcelBackend({}, "darwin", { PATH }, root),
    ).toEqual({ backend: "fs-events" });
  });
});

describe.skipIf(process.platform !== "darwin")(
  "parcel's default backend on darwin",
  () => {
    it("never runs watchman, while the watchman backend does, so passing fs-events changes nothing", async () => {
      const root = await scratch();
      const ran = join(root, "ran");
      const PATH = await watchmanAt(root, `echo x >> '${ran}'`);
      const script = [
        'const { default: w } = await import("@parcel/watcher");',
        "const backend = process.argv[2];",
        "try {",
        "  const s = await w.subscribe(process.argv[1], () => {}, backend === 'default' ? {} : { backend });",
        "  await s.unsubscribe();",
        "} catch {}",
      ].join("\n");
      const runWith = (backend: string) =>
        execFileAsync(
          process.execPath,
          ["--input-type=module", "-e", script, join(root, "work"), backend],
          {
            env: { ...process.env, PATH },
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            timeout: 30_000,
          },
        );
      const runs = async () =>
        (await readFile(ran, "utf8").catch(() => "")).split("\n").length - 1;
      await runWith("default");
      expect(await runs()).toBe(0);
      await runWith("watchman");
      expect(await runs()).toBeGreaterThan(0);
    }, 60_000);
  },
);

describe.skipIf(process.platform !== "linux")(
  "the Linux watchman probe",
  () => {
    it("keeps parcel's default when watchman answers with a sockname", async () => {
      const root = await scratch();
      const PATH = await watchmanAt(root, `echo '{"sockname": "/run/x/sock"}'`);
      expect(
        await choosePlatformParcelBackend({}, "linux", { PATH }, root),
      ).toEqual({});
    });

    it.each([
      ["prints nothing", "exit 0"],
      [
        "exits non-zero after a sockname",
        `echo '{"sockname": "/run/x/sock"}'; exit 3`,
      ],
      ["prints JSON without a sockname", `echo '{"version": "1"}'`],
      ["prints an empty sockname", `echo '{"sockname": ""}'`],
      ["prints something that is not JSON", "echo nope"],
    ])("picks inotify when watchman %s", async (_label, script) => {
      const root = await scratch();
      const PATH = await watchmanAt(root, script);
      expect(
        await choosePlatformParcelBackend(
          { ignore: ["x"] },
          "linux",
          { PATH },
          root,
        ),
      ).toEqual({ ignore: ["x"], backend: "inotify" });
    });

    it("picks inotify when watchman hangs, and leaves no process of its group behind", async () => {
      const root = await scratch();
      const group = join(root, "group");
      const PATH = await watchmanAt(
        root,
        `cut -d' ' -f5 /proc/$$/stat > '${group}'\nsleep 60 &\nwait`,
      );
      const started = performance.now();
      const chosen = await choosePlatformParcelBackend(
        {},
        "linux",
        { PATH },
        root,
        300,
      );
      expect(chosen).toEqual({ backend: "inotify" });
      expect(performance.now() - started).toBeLessThan(5_000);
      const pgid = (await readFile(group, "utf8")).trim();
      let members = await processGroupMembers(pgid);
      for (let wait = 0; wait < 20 && members.length > 0; wait += 1) {
        await new Promise((done) => setTimeout(done, 100));
        members = await processGroupMembers(pgid);
      }
      expect(members).toEqual([]);
    }, 20_000);

    it("picks inotify when watchman exits but leaves a process in another session holding its output, and keeps no descriptor of it", async () => {
      const root = await scratch();
      const holder = join(root, "holder");
      const group = join(root, "group");
      const PATH = await watchmanAt(
        root,
        `cut -d' ' -f5 /proc/$$/stat > '${group}'\nsetsid sleep 30 &\necho $! > '${holder}'\nexit 0`,
      );
      const started = performance.now();
      expect(
        await choosePlatformParcelBackend({}, "linux", { PATH }, root, 300),
      ).toEqual({ backend: "inotify" });
      expect(performance.now() - started).toBeLessThan(5_000);
      const holderPid = (await readFile(holder, "utf8")).trim();
      holders.push(Number(holderPid));
      const pipe = await readlink(`/proc/${holderPid}/fd/1`);
      expect(pipe).toMatch(/^pipe:\[\d+\]$/u);
      const ours: string[] = [];
      for (const fd of await readdir("/proc/self/fd")) {
        const target = await readlink(`/proc/self/fd/${fd}`).catch(() => "");
        if (target === pipe) ours.push(fd);
      }
      expect(ours).toEqual([]);
      const shell = (await readFile(group, "utf8")).trim();
      expect(
        await readFile(`/proc/${shell}/stat`, "utf8").catch(() => "reaped"),
      ).toBe("reaped");
      const holderStat = await readFile(`/proc/${holderPid}/stat`, "utf8");
      expect(
        holderStat.slice(
          holderStat.lastIndexOf(")") + 2,
          holderStat.lastIndexOf(")") + 3,
        ),
      ).toBe("S");
    }, 20_000);

    it("runs no probe when WATCHMAN_SOCK is set, as parcel then connects without one", async () => {
      const root = await scratch();
      const ran = join(root, "ran");
      const PATH = await watchmanAt(root, `echo x >> '${ran}'`);
      expect(
        await choosePlatformParcelBackend(
          {},
          "linux",
          { PATH, WATCHMAN_SOCK: join(root, "sock") },
          root,
        ),
      ).toEqual({});
      expect(await readFile(ran, "utf8").catch(() => "")).toBe("");
    });

    it("probes once per PATH and working directory", async () => {
      const root = await scratch();
      const ran = join(root, "ran");
      const PATH = await watchmanAt(
        root,
        `echo x >> '${ran}'\necho '{"sockname": "/run/x/sock"}'`,
      );
      for (let attempt = 0; attempt < 3; attempt += 1)
        expect(
          await choosePlatformParcelBackend({}, "linux", { PATH }, root),
        ).toEqual({});
      expect(await readFile(ran, "utf8")).toBe("x\n");
      expect(
        await choosePlatformParcelBackend(
          {},
          "linux",
          { PATH },
          join(root, "work"),
        ),
      ).toEqual({});
      expect(await readFile(ran, "utf8")).toBe("x\nx\n");
    });
  },
);

const childEntry = new URL(
  "../src/parcel-subprocess/parcel-child-entry.ts",
  import.meta.url,
);
const inProcessFixture = new URL(
  "./fixtures/in-process-watch-children.ts",
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

async function describeProcesses(pids: string[]): Promise<string[]> {
  return Promise.all(
    pids.map(async (pid) => {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      const close = stat.lastIndexOf(")");
      return `${stat.slice(stat.indexOf("(") + 1, close)} ${stat.slice(close + 2, close + 3)}`;
    }),
  );
}

describe.skipIf(process.platform !== "linux")(
  "a subscribe with a watchman that answers nothing",
  () => {
    it("leaves no child process behind in the watcher child", async () => {
      const root = await scratch();
      const PATH = await watchmanAt(root, "exit 0");
      const child = fork(childEntry, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, PATH: `${PATH}:${process.env.PATH ?? ""}` },
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
      expect(await describeProcesses(started)).toEqual([]);
    }, 60_000);

    it("leaves no child process behind in process", async () => {
      const root = await scratch();
      const PATH = await watchmanAt(root, "exit 0");
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", fileURLToPath(inProcessFixture), root],
        {
          env: { ...process.env, PATH: `${PATH}:${process.env.PATH ?? ""}` },
          timeout: 30_000,
        },
      );
      expect(JSON.parse(stdout)).toEqual([]);
    }, 60_000);
  },
);
