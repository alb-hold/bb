import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeHolderScan,
  linuxVisibilityProblem,
  scanLinux,
  scanWorktreeHolders,
  type ProcReader,
} from "./holders.js";

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];
const platform = process.platform;

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-holders-"));
  roots.push(root);
  return realpath(root);
}

function hold(script: string, cwd: string, args: string[] = []) {
  const child = spawn(process.execPath, ["-e", script, ...args], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  children.push(child);
  return child;
}

describe("scanWorktreeHolders", () => {
  it("never reports an unused folder as held, and is clear only when every process could be inspected", async () => {
    const directory = await makeDirectory();
    const scan = await scanWorktreeHolders(directory);
    expect(["clear", "unknown"]).toContain(scan.status);
    if (process.platform !== "linux") expect(scan.status).toBe("unknown");
  });

  it("reports a program whose working folder is inside, without signalling it", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no holder scan on Windows");
    const directory = await makeDirectory();
    const child = hold("setTimeout(() => {}, 300_000)", directory);

    await expect
      .poll(async () => (await scanWorktreeHolders(directory)).status, {
        timeout: 10_000,
      })
      .toBe("held");
    const scan = await scanWorktreeHolders(directory);

    expect(scan).toMatchObject({
      status: "held",
      holders: [{ pid: child.pid, through: "working folder" }],
    });
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
  });

  it("reports a program that holds a file open inside the folder", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no holder scan on Windows");
    const directory = await makeDirectory();
    const elsewhere = await makeDirectory();
    const file = join(directory, "open.txt");
    await writeFile(file, "x");
    const child = hold(
      'require("node:fs").openSync(process.argv[1], "r+"); setTimeout(() => {}, 300_000)',
      elsewhere,
      [file],
    );

    await expect
      .poll(async () => (await scanWorktreeHolders(directory)).status, {
        timeout: 10_000,
      })
      .toBe("held");
    expect(await scanWorktreeHolders(directory)).toMatchObject({
      status: "held",
      holders: [{ pid: child.pid, through: "open file" }],
    });
  });

  it("is inconclusive, not clear, where the platform cannot be inspected", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const scan = await scanWorktreeHolders(await makeDirectory());
    expect(scan.status).toBe("unknown");
    expect(describeHolderScan(scan)).toContain("could not check");
  });

  it("words a held result with the program and how it holds the folder", () => {
    expect(
      describeHolderScan({
        status: "held",
        holders: [{ pid: 42, command: "node", through: "open file" }],
      }),
    ).toContain("node (pid 42, open file)");
    expect(describeHolderScan({ status: "clear" })).toBeNull();
  });
});

interface FakeProcess {
  uid?: number;
  state?: string;
  comm?: string;
  mount?: string;
  root?: string;
  cwd?: string;
  denied?: boolean;
}

function fakeProc(options: {
  self?: { uid?: number; groups?: number[]; nspid?: string };
  mountinfo?: string;
  ownMount?: string;
  denyInit?: boolean;
  processes?: Record<number, FakeProcess>;
}): ProcReader {
  const self = options.self ?? {};
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  const denied = new Set<string>();
  const dirs = new Map<string, string[]>();
  files.set(
    "/proc/self/status",
    `Name:\tnode\nState:\tR (running)\nNSpid:\t${self.nspid ?? "4242"}\nUid:\t${self.uid ?? 1000}\t${self.uid ?? 1000}\t${self.uid ?? 1000}\t${self.uid ?? 1000}\nGid:\t1000\t1000\t1000\t1000\nGroups:\t${(self.groups ?? [1000]).join(" ")}\n`,
  );
  links.set("/proc/self/ns/mnt", options.ownMount ?? "mnt:[1]");
  links.set("/proc/self/root", "/");
  files.set(
    "/proc/self/mountinfo",
    options.mountinfo ??
      "26 20 0:5 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n",
  );
  denied.add("/proc/1/ns/pid");
  denied.add("/proc/1/ns/mnt");
  const processes = options.processes ?? {};
  dirs.set("/proc", ["self", "1", ...Object.keys(processes), "cpuinfo"]);
  for (const [key, process] of Object.entries(processes)) {
    const base = `/proc/${key}`;
    files.set(
      `${base}/status`,
      `Name:\tx\nState:\t${process.state ?? "S (sleeping)"}\nUid:\t${process.uid ?? 1000}\t${process.uid ?? 1000}\t${process.uid ?? 1000}\t${process.uid ?? 1000}\n`,
    );
    files.set(`${base}/comm`, `${process.comm ?? "node"}\n`);
    if (process.denied === true) {
      for (const leaf of ["ns/mnt", "root", "task", "fd", "maps"])
        denied.add(`${base}/${leaf}`);
      continue;
    }
    links.set(`${base}/ns/mnt`, process.mount ?? options.ownMount ?? "mnt:[1]");
    links.set(`${base}/root`, process.root ?? "/");
    dirs.set(`${base}/task`, [key]);
    links.set(
      `${base}/task/${key}/ns/mnt`,
      process.mount ?? options.ownMount ?? "mnt:[1]",
    );
    links.set(`${base}/task/${key}/cwd`, process.cwd ?? "/home/other");
    links.set(`${base}/exe`, "/usr/bin/node");
    dirs.set(`${base}/fd`, []);
    files.set(`${base}/maps`, "");
  }
  const fail = (path: string): never => {
    throw Object.assign(new Error(path), {
      code: denied.has(path) ? "EACCES" : "ENOENT",
    });
  };
  return {
    readlink: async (path) => links.get(path) ?? fail(path),
    readFile: async (path) => files.get(path) ?? fail(path),
    readdir: async (path) => dirs.get(path) ?? fail(path),
  };
}

describe("the Linux process-list visibility rule", () => {
  it("accepts a process whose /proc/1 it may not read when it sits alone in its process namespace", async () => {
    const proc = fakeProc({});
    expect((await linuxVisibilityProblem(proc)).problem).toBeNull();
    expect(await scanLinux("/work/tree", proc, 4242)).toEqual({
      status: "clear",
    });
  });

  it("keeps the worktree when the process runs in a nested process namespace", async () => {
    const proc = fakeProc({ self: { nspid: "4242\t17" } });
    expect((await linuxVisibilityProblem(proc)).problem).toContain(
      "nested process namespace",
    );
    expect((await scanLinux("/work/tree", proc, 4242)).status).toBe("unknown");
  });

  it("keeps the worktree when /proc hides other users' processes, unless the user is in the exempt group", async () => {
    const hidden = fakeProc({
      mountinfo:
        "26 20 0:5 / /proc rw,nosuid,relatime - proc proc rw,hidepid=2,gid=999\n",
    });
    expect((await linuxVisibilityProblem(hidden)).problem).toContain("hidden");
    for (const value of ["1", "invisible", "4"]) {
      const other = fakeProc({
        mountinfo: `26 20 0:5 / /proc rw - proc proc rw,hidepid=${value}\n`,
      });
      expect((await linuxVisibilityProblem(other)).problem).toContain("hidden");
    }
    const exempt = fakeProc({
      self: { groups: [1000, 999] },
      mountinfo:
        "26 20 0:5 / /proc rw,nosuid,relatime - proc proc rw,hidepid=2,gid=999\n",
    });
    expect((await linuxVisibilityProblem(exempt)).problem).toBeNull();
    const visible = fakeProc({
      mountinfo: "26 20 0:5 / /proc rw - proc proc rw,hidepid=0\n",
    });
    expect((await linuxVisibilityProblem(visible)).problem).toBeNull();
  });

  it("keeps the worktree when it cannot tell which namespaces it is in", async () => {
    const proc = fakeProc({});
    const broken: ProcReader = {
      ...proc,
      readlink: async (path) => {
        if (path === "/proc/self/ns/mnt")
          throw Object.assign(new Error(path), { code: "EACCES" });
        return proc.readlink(path);
      },
    };
    expect((await linuxVisibilityProblem(broken)).problem).toContain(
      "mount namespace",
    );
  });

  it("reports a same-user process working inside the folder, even when other users' processes are unreadable", async () => {
    const proc = fakeProc({
      processes: {
        100: { uid: 0, denied: true, comm: "systemd" },
        200: { uid: 1000, cwd: "/work/tree/sub", comm: "node" },
      },
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
      status: "held",
      holders: [{ pid: 200, through: "working folder" }],
    });
  });

  it("is clear when only other users' processes are unreadable, and for a zombie", async () => {
    const proc = fakeProc({
      processes: {
        100: { uid: 0, denied: true, comm: "systemd" },
        101: { uid: 1001, denied: true },
        102: { uid: 1000, state: "Z (zombie)", denied: true },
      },
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toEqual({
      status: "clear",
    });
  });

  it("is clear when the only unreadable same-user process is a known session helper, and unknown for any other", async () => {
    const helper = fakeProc({
      processes: { 300: { uid: 1000, denied: true, comm: "sshd-session" } },
    });
    expect(await scanLinux("/work/tree", helper, 4242)).toEqual({
      status: "clear",
    });
    const stranger = fakeProc({
      processes: { 300: { uid: 1000, denied: true, comm: "node" } },
    });
    expect(await scanLinux("/work/tree", stranger, 4242)).toMatchObject({
      status: "unknown",
    });
  });

  it("is unknown when a same-user process runs in another mount namespace", async () => {
    const proc = fakeProc({
      processes: { 300: { uid: 1000, mount: "mnt:[2]" } },
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("different mount namespace"),
    });
  });

  it("inspects every user's processes when it runs as root", async () => {
    const proc = fakeProc({
      self: { uid: 0 },
      processes: { 100: { uid: 1001, denied: true, comm: "node" } },
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
      status: "unknown",
    });
  });

  it("looks again at a same-user process that is unreadable for a moment, such as one in the middle of exec", async () => {
    const proc = fakeProc({
      processes: { 300: { uid: 1000, cwd: "/elsewhere" } },
    });
    let denied = 2;
    const flaky: ProcReader = {
      ...proc,
      readdir: async (path) => {
        if (path === "/proc/300/fd" && denied > 0) {
          denied -= 1;
          throw Object.assign(new Error(path), { code: "EACCES" });
        }
        return proc.readdir(path);
      },
    };
    expect(await scanLinux("/work/tree", flaky, 4242)).toEqual({
      status: "clear",
    });
    expect(denied).toBe(0);
  });
});
