import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostCwdScanIo,
  parseEffectiveUid,
  parseEffectiveGid,
  parseFilesystemGid,
  parseFilesystemUid,
  parseRealGid,
  parseRealUid,
  PS_ARGS,
  scanProcessesWithCwdUnder,
  type CwdScanIo,
} from "../src/cwd-scan.js";
import { linuxPathHasExtendedAcl } from "../src/linux-path-access.js";

const cleanups: (() => Promise<void>)[] = [];
const hasSetfacl =
  spawnSync("setfacl", ["--version"], { encoding: "utf8" }).error === undefined;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeLinux(
  cwds: Record<number, string | NodeJS.ErrnoException>,
  owners: Record<number, number> = {},
  comms: Record<number, string> = {},
): CwdScanIo & {
  effectiveCapabilities(pid: number): Promise<bigint>;
  statAccess(path: string): Promise<{ uid: number; gid: number; mode: number }>;
} {
  const io: CwdScanIo = {
    platform: "linux",
    uid: 1000,
    selfPid: 1,
    listProcessIds: async () => Object.keys(cwds),
    readCwd: async (pid) => {
      const value = cwds[pid];
      if (value === undefined)
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (typeof value !== "string") throw value;
      return value;
    },
    realUid: async (pid) => owners[pid] ?? 1000,
    effectiveUid: async (pid) => owners[pid] ?? 1000,
    realGid: async () => 1000,
    effectiveGid: async () => 1000,
    filesystemUid: async (pid) => owners[pid] ?? 1000,
    filesystemGid: async () => 1000,
    supplementaryGroups: async () => [],
    hasExtendedAcl: async () => false,
    readComm: async (pid) => comms[pid] ?? "node",
    runLsof: async () => {
      throw new Error("unused");
    },
  };
  return Object.assign(io, {
    effectiveCapabilities: async () => 0n,
    statAccess: async () => ({ uid: 0, gid: 0, mode: 0o711 }),
  }) as CwdScanIo & {
    effectiveCapabilities(pid: number): Promise<bigint>;
    statAccess(
      path: string,
    ): Promise<{ uid: number; gid: number; mode: number }>;
  };
}

const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });
const dir = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "bb-cwd-scan-")));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return base;
};

describe("scanProcessesWithCwdUnder", () => {
  it("reports a same-user process working inside the directory as held", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux({ 10: `${base}/sub`, 11: "/elsewhere" }),
    );
    expect(scan).toEqual({
      status: "held",
      holders: [{ pid: 10, cwd: `${base}/sub` }],
      excludedOtherUsers: 0,
      unvouchedHelpers: [],
    });
  });

  it.each([
    "systemd",
    "(sd-pam)",
    "ssh-agent",
    "sshd",
    "sshd-session",
    "gpg-agent",
    "dbus-daemon",
    "dbus-broker",
    "gnome-keyring-d",
    "keepassxc-proxy",
    "pipewire",
    "wireplumber",
  ])(
    "does not block on an unreadable unrelated same-user process named %s",
    async (comm) => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeLinux({ 10: denied() }, {}, { 10: comm }),
      );
      expect(scan.status).toBe("clear");
    },
  );

  it.each(["node", "bash", "ssh-agent-fake", "sshd-sessionx", "SSHD"])(
    "returns unknown for an unreadable same-user process named %s",
    async (comm) => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeLinux({ 10: denied() }, {}, { 10: comm }),
      );
      expect(scan).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining(comm),
      });
    },
  );

  it("returns unknown when an unreadable same-user process command cannot be read", async () => {
    const base = await dir();
    const io = fakeLinux({ 10: denied() });
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      {
        ...io,
        readComm: async () => {
          throw denied();
        },
      },
    );
    expect(scan).toMatchObject({ status: "unknown" });
  });

  it.each([
    ["other execute", 0o711, 0],
    ["DAC override capability", 0o700, 2],
    ["DAC read-search capability", 0o700, 4],
  ])(
    "returns unknown for a foreign process with %s and unreadable cwd",
    async (_name, mode, capability) => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        {
          ...fakeLinux({ 10: denied() }, { 10: 1001 }),
          effectiveCapabilities: async () => BigInt(capability),
          statAccess: async () => ({ uid: 1000, gid: 2000, mode }),
        },
      );
      expect(scan).toMatchObject({ status: "unknown" });
    },
  );

  it.each([
    ["filesystem GID", 2000, []],
    ["supplementary group", 1000, [2000]],
  ])(
    "returns unknown when a foreign UID belongs to a group-executable directory through its %s",
    async (_name, filesystemGid, groups) => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        {
          ...fakeLinux({ 10: denied() }, { 10: 1001 }),
          filesystemGid: async () => filesystemGid,
          supplementaryGroups: async () => groups,
          statAccess: async () => ({ uid: 1000, gid: 2000, mode: 0o710 }),
        },
      );
      expect(scan).toMatchObject({ status: "unknown" });
    },
  );

  it("clears a foreign UID outside the directory group when only group execute is set", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      {
        ...fakeLinux({ 10: denied() }, { 10: 1001 }),
        filesystemGid: async () => 1001,
        supplementaryGroups: async () => [],
        statAccess: async () => ({ uid: 1000, gid: 2000, mode: 0o710 }),
      },
    );
    expect(scan).toMatchObject({ status: "clear", excludedOtherUsers: 1 });
  });

  it.each([true, null])(
    "returns unknown when ACL inspection is %s",
    async (extendedAcl) => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        {
          ...fakeLinux({ 10: denied() }, { 10: 1001 }),
          filesystemGid: async () => 1001,
          supplementaryGroups: async () => [],
          statAccess: async () => ({ uid: 1000, gid: 2000, mode: 0o710 }),
          hasExtendedAcl: async () => extendedAcl,
        },
      );
      expect(scan).toMatchObject({ status: "unknown" });
    },
  );

  it("returns unknown when ACL inspection fails on a restrictive mode", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      {
        ...fakeLinux({ 10: denied() }, { 10: 1001 }),
        filesystemGid: async () => 1001,
        supplementaryGroups: async () => [],
        statAccess: async () => ({ uid: 1000, gid: 2000, mode: 0o700 }),
        hasExtendedAcl: async () => null,
      },
    );
    expect(scan).toMatchObject({ status: "unknown" });
  });

  it("does not inspect ACLs when mode bits already allow search", async () => {
    const base = await dir();
    let allowedModeCalls = 0;
    const allowedMode = await scanProcessesWithCwdUnder(
      { directories: [base] },
      {
        ...fakeLinux({ 10: denied() }, { 10: 1001 }),
        statAccess: async () => ({ uid: 1000, gid: 2000, mode: 0o711 }),
        hasExtendedAcl: async () => {
          allowedModeCalls += 1;
          return false;
        },
      },
    );
    expect(allowedMode).toMatchObject({ status: "unknown" });
    expect(allowedModeCalls).toBe(0);
  });

  it("memoizes ACL inspection for a shared path within one scan", async () => {
    const base = await dir();
    let sharedPathCalls = 0;
    const sharedPath = await scanProcessesWithCwdUnder(
      { directories: [base] },
      {
        ...fakeLinux({ 10: denied(), 11: denied() }, { 10: 1001, 11: 1002 }),
        statAccess: async (target) => ({
          uid: 1000,
          gid: 2000,
          mode: target === base ? 0o700 : 0o711,
        }),
        hasExtendedAcl: async () => {
          sharedPathCalls += 1;
          return false;
        },
      },
    );
    expect(sharedPath).toMatchObject({ status: "clear" });
    expect(sharedPathCalls).toBe(1);
  });

  it("clears a foreign process whose cwd is unreadable and no path component grants traversal", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      {
        ...fakeLinux({ 10: denied() }, { 10: 1001 }),
        effectiveCapabilities: async () => 0n,
        statAccess: async (target) => ({
          uid: target === base ? 1000 : 0,
          gid: 0,
          mode: target === base ? 0o700 : 0o711,
        }),
      },
    );
    expect(scan).toMatchObject({ status: "clear", excludedOtherUsers: 1 });
  });

  it("does not block on another user's unreadable process and says it was excluded", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux({ 10: denied(), 11: "/elsewhere" }, { 10: 0 }),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 1,
      unvouchedHelpers: [],
      skippedOtherUsers: [{ pid: 10, uid: 0, errno: "EACCES" }],
    });
  });

  it("records skipped system-user processes with their pid, uid and errno", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux(
        {
          10: denied(),
          11: Object.assign(new Error("perm"), { code: "EPERM" }),
          12: Object.assign(new Error("io"), { code: "EIO" }),
          13: "/elsewhere",
        },
        { 10: 0, 11: 33, 12: 999 },
      ),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 3,
      unvouchedHelpers: [],
      skippedOtherUsers: [
        { pid: 10, uid: 0, errno: "EACCES" },
        { pid: 11, uid: 33, errno: "EPERM" },
        { pid: 12, uid: 999, errno: "EIO" },
      ],
    });
  });

  it("does not clear an unreadable foreign regular-user cwd even when the error is not EACCES", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux(
        { 10: Object.assign(new Error("io"), { code: "EIO" }) },
        { 10: 1234 },
      ),
    );
    expect(scan).toMatchObject({ status: "unknown" });
  });

  it("is unknown for a same-user process whose working directory fails to read for any other reason", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux({ 12: Object.assign(new Error("io"), { code: "EIO" }) }),
    );
    expect(scan).toEqual({
      status: "unknown",
      reason: expect.stringContaining("process 12"),
    });
  });

  it("keeps an unreadable same-user process unknown even when an unreadable other-user process is also present", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux(
        { 10: denied(), 11: denied() },
        { 10: 0 },
        { 11: "renamed-helper" },
      ),
    );
    expect(scan.status).toBe("unknown");
    expect(scan.status === "unknown" ? scan.reason : "").toContain(
      "process 11",
    );
  });

  it("is unknown when the process list cannot be read, on Windows, and for a symlinked target", async () => {
    const base = await dir();
    const unreadable: CwdScanIo = {
      ...fakeLinux({}),
      listProcessIds: async () => {
        throw denied();
      },
    };
    expect(
      (await scanProcessesWithCwdUnder({ directories: [base] }, unreadable))
        .status,
    ).toBe("unknown");
    expect(
      (
        await scanProcessesWithCwdUnder(
          { directories: [base] },
          { ...fakeLinux({}), platform: "win32" },
        )
      ).status,
    ).toBe("unknown");
    await mkdir(join(base, "real"));
    await symlink(join(base, "real"), join(base, "link"));
    expect(
      (
        await scanProcessesWithCwdUnder(
          { directories: [join(base, "link")] },
          fakeLinux({}),
        )
      ).status,
    ).toBe("unknown");
  });

  it.each([
    [
      "a spawn error",
      async () => {
        throw new Error("spawn lsof ENOENT");
      },
    ],
    [
      "a timeout",
      async () => {
        throw new Error("lsof timed out");
      },
    ],
    ["an exit code above 1", async () => ({ code: 2, stdout: "", stderr: "" })],
    [
      "exit 0 together with a warning on stderr",
      async () => ({
        code: 0,
        stdout: "",
        stderr: "lsof: WARNING: can't stat() nfs file system /mnt/x",
      }),
    ],
    [
      "exit 1 together with a warning on stderr",
      async () => ({
        code: 1,
        stdout: "",
        stderr: "lsof: WARNING: can't stat() fuse file system /Volumes/x",
      }),
    ],
  ])("is unknown on macOS when lsof has %s", async (_label, runLsof) => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      { ...fakeLinux({}), platform: "darwin", runLsof },
    );
    expect(scan.status).toBe("unknown");
  });

  it("is clear on macOS when lsof finds nothing under the directory (exit 1) and held when it does", async () => {
    const base = await dir();
    const darwin = (stdout: string, code: number) => ({
      ...fakeLinux({}),
      platform: "darwin" as const,
      runLsof: async () => ({ code, stdout, stderr: "" }),
    });
    expect(
      await scanProcessesWithCwdUnder({ directories: [base] }, darwin("", 1)),
    ).toEqual({
      status: "clear",
      excludedOtherUsers: null,
      unvouchedHelpers: null,
    });
    expect(
      await scanProcessesWithCwdUnder(
        { directories: [base] },
        darwin(`p77\nn${base}/x\n`, 0),
      ),
    ).toMatchObject({ status: "held", holders: [{ pid: 77 }] });
  });

  it.skipIf(process.platform === "win32")(
    "finds a real process and leaves it running",
    async () => {
      const base = await dir();
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd: base,
          stdio: "ignore",
        },
      );
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      cleanups.push(async () => {
        child.kill("SIGKILL");
        await exited;
      });
      const io: CwdScanIo = {
        ...hostCwdScanIo,
        listProcessIds: async () => [String(child.pid)],
      };
      await expect
        .poll(
          async () =>
            (await scanProcessesWithCwdUnder({ directories: [base] }, io))
              .status,
        )
        .toBe("held");
      expect(child.exitCode).toBeNull();
    },
  );

  describe("filesystem uid", () => {
    it("reads the fourth value of the Uid: line of /proc/<pid>/status", () => {
      expect(
        parseFilesystemUid(
          "Name:\tlogin\nUid:\t501\t0\t0\t0\nGid:\t20\t20\t20\t20\n",
        ),
      ).toBe(0);
      expect(parseFilesystemUid("Uid:\t1000\t1001\t1002\t1003\n")).toBe(1003);
      expect(parseFilesystemUid("Uid:\t0\t1000\t1001\t1002\n")).toBe(1002);
      expect(parseFilesystemGid("Gid:\t1000\t1001\t1002\t1003\n")).toBe(1003);
      expect(parseEffectiveGid("Gid:\t1000\t1001\t1002\t1003\n")).toBe(1001);
      expect(parseRealGid("Gid:\t1000\t1001\t1002\t1003\n")).toBe(1000);
      expect(parseEffectiveUid("Uid:\t1000\t1001\t1002\t1003\n")).toBe(1001);
      expect(parseRealUid("Uid:\t1000\t1001\t1002\t1003\n")).toBe(1000);
      expect(parseFilesystemGid("Gid:\t0\t1000\t1001\t1002\n")).toBe(1002);
      expect(() => parseFilesystemUid("Name:\tx\n")).toThrow();
    });

    it.skipIf(process.platform !== "linux")(
      "the host io reads the effective uid of a real process through that line",
      async () => {
        expect(await hostCwdScanIo.filesystemUid(process.pid)).toBe(
          process.geteuid?.(),
        );
        expect(hostCwdScanIo.uid).toBe(process.geteuid?.() ?? null);
      },
    );

    it("does not clear an unreadable process whose real and effective UIDs differ from its filesystem UID", async () => {
      const base = await dir();
      const io = fakeLinux({ 10: denied() });
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        {
          ...io,
          filesystemUid: async () => 1000,
          realUid: async (pid) => (pid === 10 ? 1002 : 1000),
          effectiveUid: async (pid) => (pid === 10 ? 1001 : 1000),
          statAccess: async () => ({ uid: 1000, gid: 1000, mode: 0o700 }),
        },
      );
      expect(scan).toMatchObject({ status: "unknown" });
    });

    it("does not clear an unreadable process whose real and effective GIDs differ from its filesystem GID", async () => {
      const base = await dir();
      const io = fakeLinux({ 10: denied() });
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        {
          ...io,
          filesystemGid: async () => 1000,
          realGid: async (pid) => (pid === 10 ? 1002 : 1000),
          effectiveGid: async (pid) => (pid === 10 ? 1001 : 1000),
        },
      );
      expect(scan).toMatchObject({ status: "unknown" });
    });

    it("uses the filesystem uid when an unreadable process has differing real and effective UIDs", async () => {
      const base = await dir();
      const io = fakeLinux({ 10: denied() }, { 10: 1001 }, { 10: "login" });
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        {
          ...io,
          filesystemUid: async (pid) => (pid === 10 ? 1000 : 1000),
          realUid: async (pid) => (pid === 10 ? 1001 : 1000),
          effectiveUid: async (pid) => (pid === 10 ? 1001 : 1000),
          statAccess: async () => ({ uid: 1000, gid: 1000, mode: 0o700 }),
        },
      );
      expect(scan.status).toBe("unknown");
    });
  });

  describe("on macOS, through ps and lsof", () => {
    const psLine = (pid: number, uid: number, comm: string) =>
      `${String(pid).padStart(6)} ${String(uid).padStart(5)} ${comm}\n`;
    function fakeMac(options: {
      ps: string[];
      lsof: Record<number, string>;
      uid?: number;
    }): CwdScanIo & { delays: number[]; psCalls: number } {
      const state = { delays: [] as number[], psCalls: 0 };
      return {
        ...fakeLinux({}),
        platform: "darwin",
        uid: options.uid ?? 501,
        selfPid: 1,
        runPs: async () => {
          const text =
            options.ps[Math.min(state.psCalls, options.ps.length - 1)] ?? "";
          state.psCalls += 1;
          return { code: 0, stdout: text, stderr: "" };
        },
        runLsof: async () => ({
          code: 0,
          stdout: Object.entries(options.lsof)
            .map(([pid, cwd]) => `p${pid}\nn${cwd}\n`)
            .join(""),
          stderr: "",
        }),
        delay: async (ms) => {
          state.delays.push(ms);
        },
        get delays() {
          return state.delays;
        },
        get psCalls() {
          return state.psCalls;
        },
      };
    }

    it("asks ps for the effective uid, not the real uid", () => {
      expect(PS_ARGS).toEqual(["-A", "-o", "pid=,uid=,comm="]);
    });

    it("keeps when a same-euid process is missing from lsof, is not a known helper and is still alive on the second look, naming its pid and command", async () => {
      const base = await dir();
      const table =
        psLine(
          20,
          501,
          "/Applications/Hardened.app/Contents/MacOS/hardened-helper",
        ) + psLine(21, 501, "/bin/zsh");
      const io = fakeMac({ ps: [table, table], lsof: { 21: "/Users/me" } });
      const scan = await scanProcessesWithCwdUnder({ directories: [base] }, io);
      expect(scan.status).toBe("unknown");
      const reason = scan.status === "unknown" ? scan.reason : "";
      expect(reason).toContain("process 20 (hardened-helper)");
      expect(reason).not.toContain("/Applications");
      expect(io.delays).toEqual([200]);
      expect(io.psCalls).toBe(2);
    });

    it("skips and records a root-effective process with the same real uid, never holds on it", async () => {
      const base = await dir();
      const table = psLine(30, 0, "login") + psLine(31, 501, "node");
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeMac({ ps: [table], lsof: { 31: "/Users/me" } }),
      );
      expect(scan).toEqual({
        status: "clear",
        excludedOtherUsers: 1,
        unvouchedHelpers: [],
        skippedOtherUsers: [{ pid: 30, uid: 0, errno: "other-euid" }],
      });
    });

    it("does not skip an unreadable foreign process when the daemon runs as root", async () => {
      const base = await dir();
      const table = psLine(30, 1001, "worker") + psLine(31, 0, "node");
      const io = fakeMac({
        ps: [table, table],
        lsof: { 31: "/Users/me" },
        uid: 0,
      });
      const scan = await scanProcessesWithCwdUnder({ directories: [base] }, io);
      expect(scan).toMatchObject({ status: "unknown" });
      expect(io.delays).toEqual([200]);
    });

    it("ignores a process that has exited by the second look", async () => {
      const base = await dir();
      const first = psLine(40, 501, "short-lived") + psLine(41, 501, "node");
      const second = psLine(41, 501, "node");
      const io = fakeMac({ ps: [first, second], lsof: { 41: "/Users/me" } });
      const scan = await scanProcessesWithCwdUnder({ directories: [base] }, io);
      expect(scan).toMatchObject({ status: "clear" });
      expect(io.delays).toEqual([200]);
    });

    it("does not treat a reused pid with another command as the same process", async () => {
      const base = await dir();
      const first = psLine(40, 501, "short-lived");
      const second = psLine(40, 501, "something-else");
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeMac({ ps: [first, second], lsof: {} }),
      );
      expect(scan).toMatchObject({ status: "clear" });
    });

    it("looks again and stays unknown when an unreadable process uses a session-helper name", async () => {
      const base = await dir();
      const io = fakeMac({
        ps: [psLine(50, 501, "/usr/bin/ssh-agent")],
        lsof: {},
      });
      const scan = await scanProcessesWithCwdUnder({ directories: [base] }, io);
      expect(scan.status).toBe("unknown");
      expect(io.delays).toEqual([200]);
    });

    it("clears an allowlisted helper absent from lsof when both ps snapshots show it alive", async () => {
      const base = await dir();
      const table = psLine(51, 501, "/usr/bin/ssh-agent");
      const io = fakeMac({ ps: [table, table], lsof: {} });
      const scan = await scanProcessesWithCwdUnder({ directories: [base] }, io);
      expect(scan).toMatchObject({ status: "clear" });
      expect(io.psCalls).toBe(2);
    });

    it("still reports a holder lsof lists, and keeps the existing unknown results for lsof and ps failures", async () => {
      const base = await dir();
      const held = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeMac({
          ps: [psLine(60, 501, "node")],
          lsof: { 60: `${base}/work` },
        }),
      );
      expect(held).toMatchObject({ status: "held", holders: [{ pid: 60 }] });
      const io = fakeMac({ ps: [psLine(60, 501, "node")], lsof: {} });
      expect(
        (
          await scanProcessesWithCwdUnder(
            { directories: [base] },
            {
              ...io,
              runLsof: async () => ({
                code: 0,
                stdout: "",
                stderr: "lsof: WARNING: x",
              }),
            },
          )
        ).status,
      ).toBe("unknown");
      expect(
        (
          await scanProcessesWithCwdUnder(
            { directories: [base] },
            { ...io, runPs: async () => ({ code: 1, stdout: "", stderr: "" }) },
          )
        ).status,
      ).toBe("unknown");
    });
  });
});

describe("real Linux POSIX ACL access checks", () => {
  it.skipIf(process.platform !== "linux")(
    "detects and respects a named-user ACL from a real filesystem xattr",
    async () => {
      const base = await realpath(await mkdtemp(join("/tmp", "bb-cwd-acl-")));
      cleanups.push(() => rm(base, { recursive: true, force: true }));
      const aclDirectory = join(base, "acl");
      await mkdir(aclDirectory, { mode: 0o710 });
      await chmod(base, 0o711);
      const uid = 65534;
      const setAcl = spawnSync(
        "python3",
        [
          "-c",
          "import os,struct,sys\np=sys.argv[1]\nu=int(sys.argv[2])\ne=[(1,7,0xffffffff),(2,1,u),(4,1,0xffffffff),(16,1,0xffffffff),(32,0,0xffffffff)]\nos.setxattr(p,'system.posix_acl_access',struct.pack('<I',2)+b''.join(struct.pack('<HHI',*v) for v in e))",
          aclDirectory,
          String(uid),
        ],
        { encoding: "utf8" },
      );
      expect(setAcl.error).toBeUndefined();
      expect(setAcl.status, setAcl.stderr).toBe(0);
      await expect(linuxPathHasExtendedAcl(aclDirectory)).resolves.toBe(true);
      await expect(linuxPathHasExtendedAcl(base)).resolves.toBe(false);
      let statCalls = 0;
      let aclCalls = 0;
      const io = {
        ...fakeLinux({ 10: denied() }, { 10: uid }),
        filesystemGid: async () => uid,
        supplementaryGroups: async () => [],
        statAccess: async (target: string) => {
          statCalls += 1;
          const info = await stat(target);
          return { uid: info.uid, gid: info.gid, mode: info.mode };
        },
        hasExtendedAcl: async (target: string) => {
          aclCalls += 1;
          return linuxPathHasExtendedAcl(target);
        },
      };
      const scan = await scanProcessesWithCwdUnder(
        { directories: [aclDirectory] },
        io,
      );
      expect(
        scan,
        `stat calls ${statCalls}, ACL calls ${aclCalls}`,
      ).toMatchObject({
        status: "unknown",
      });
    },
  );

  const itWithSetfacl = hasSetfacl ? it : it.skip;
  itWithSetfacl(
    hasSetfacl
      ? "detects and respects a named-user ACL created by setfacl"
      : "detects and respects a named-user ACL created by setfacl (skipped: setfacl is not installed on this host)",
    async () => {
      const base = await realpath(
        await mkdtemp(join("/tmp", "bb-cwd-setfacl-")),
      );
      cleanups.push(() => rm(base, { recursive: true, force: true }));
      const aclDirectory = join(base, "setfacl-acl");
      await mkdir(aclDirectory, { mode: 0o710 });
      await chmod(base, 0o711);
      const changed = spawnSync(
        "setfacl",
        ["-m", "u:65534:--x", aclDirectory],
        { encoding: "utf8" },
      );
      expect(changed.error).toBeUndefined();
      expect(changed.status, changed.stderr).toBe(0);
      await expect(linuxPathHasExtendedAcl(aclDirectory)).resolves.toBe(true);
    },
  );
});
