import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostCwdScanIo,
  parseEffectiveUid,
  PS_ARGS,
  scanProcessesWithCwdUnder,
  type CwdScanIo,
} from "../src/cwd-scan.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeLinux(
  cwds: Record<number, string | NodeJS.ErrnoException>,
  owners: Record<number, number> = {},
  comms: Record<number, string> = {},
): CwdScanIo {
  return {
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
    effectiveUid: async (pid) => owners[pid] ?? 1000,
    readComm: async (pid) => comms[pid] ?? "node",
    runLsof: async () => {
      throw new Error("unused");
    },
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
  ])(
    "is clear, and reports it by name and pid, when the unreadable same-user process is the allow-listed helper %s",
    async (comm) => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeLinux({ 10: denied() }, {}, { 10: comm }),
      );
      expect(scan).toEqual({
        status: "clear",
        excludedOtherUsers: 0,
        unvouchedHelpers: [{ pid: 10, comm }],
      });
    },
  );

  it.each(["node", "bash", "ssh-agent-fake", "sshd-sessionx", "SSHD"])(
    "is unknown when the unreadable same-user process is %s, which is not an allow-listed helper",
    async (comm) => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeLinux({ 10: denied() }, {}, { 10: comm }),
      );
      expect(scan.status).toBe("unknown");
      expect(scan.status === "unknown" ? scan.reason : "").toContain("10");
    },
  );

  it("is unknown when the name of an unreadable same-user process cannot be read", async () => {
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
    expect(scan.status).toBe("unknown");
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

  it("records every skipped other-user process with its pid, uid and errno, whatever the read error", async () => {
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
        { 10: 0, 11: 33, 12: 1234 },
      ),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 3,
      unvouchedHelpers: [],
      skippedOtherUsers: [
        { pid: 10, uid: 0, errno: "EACCES" },
        { pid: 11, uid: 33, errno: "EPERM" },
        { pid: 12, uid: 1234, errno: "EIO" },
      ],
    });
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
      await expect
        .poll(
          async () =>
            (await scanProcessesWithCwdUnder({ directories: [base] })).status,
        )
        .toBe("held");
      expect(child.exitCode).toBeNull();
    },
  );

  describe("effective uid", () => {
    it("reads the second value of the Uid: line of /proc/<pid>/status, not the real uid", () => {
      expect(
        parseEffectiveUid(
          "Name:\tlogin\nUid:\t501\t0\t0\t0\nGid:\t20\t20\t20\t20\n",
        ),
      ).toBe(0);
      expect(parseEffectiveUid("Uid:\t0\t1000\t1000\t1000\n")).toBe(1000);
      expect(() => parseEffectiveUid("Name:\tx\n")).toThrow();
    });

    it.skipIf(process.platform !== "linux")(
      "the host io reads the effective uid of a real process through that line",
      async () => {
        expect(await hostCwdScanIo.effectiveUid(process.pid)).toBe(
          process.geteuid?.(),
        );
        expect(hostCwdScanIo.uid).toBe(process.geteuid?.() ?? null);
      },
    );

    it("skips and records an unreadable process whose effective uid differs, even when its real uid is ours", async () => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeLinux({ 10: denied() }, { 10: 0 }, { 10: "login" }),
      );
      expect(scan).toEqual({
        status: "clear",
        excludedOtherUsers: 1,
        unvouchedHelpers: [],
        skippedOtherUsers: [{ pid: 10, uid: 0, errno: "EACCES" }],
      });
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

    it("does not look again, and reports the helper, when the only missing process is a known session helper", async () => {
      const base = await dir();
      const io = fakeMac({
        ps: [psLine(50, 501, "/usr/bin/ssh-agent")],
        lsof: {},
      });
      const scan = await scanProcessesWithCwdUnder({ directories: [base] }, io);
      expect(scan).toMatchObject({
        status: "clear",
        unvouchedHelpers: [{ pid: 50, comm: "ssh-agent" }],
      });
      expect(io.delays).toEqual([]);
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
