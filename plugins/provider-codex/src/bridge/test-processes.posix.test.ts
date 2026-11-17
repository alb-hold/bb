import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  drainTestProcessCleanups,
  killSurvivingTestProcessGroupMembers,
  killTestProcessGroup,
  trackTestProcess,
} from "./test-processes.js";

const START_WAIT_MS = 10_000;
const LEAK_DEADLINE_MS = 4_000;
const BOUNDED_DEADLINE_MS = 5_000;
const ZOMBIE_DEADLINE_MS = 15_000;
const LEADER_EXIT_WAIT_MS = 5_000;
const ZOMBIE_SETTLE_MS = 800;
const MARGIN_MS = 6_000;

async function leaderExitWithin(
  exits: Promise<unknown>[],
  what: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${what} did not exit within ${LEADER_EXIT_WAIT_MS} ms`),
        ),
      LEADER_EXIT_WAIT_MS,
    );
  });
  try {
    await Promise.race([Promise.all(exits), expired]);
  } finally {
    clearTimeout(timer);
  }
}

describe.runIf(process.platform !== "win32")(
  "inherited stdout teardown",
  () => {
    it("fails naming pid and command when a background grandchild outlives its exited leader, as codex's plugin fetch did", async () => {
      const directory = mkdtempSync(join(tmpdir(), "bb-test-live-writer-"));
      const marker = join(directory, "pid");
      const child = spawn(process.execPath, ["-e", `
        const { spawn } = require("node:child_process");
        const descendant = spawn("sh", ["-c", ${JSON.stringify(`echo $$ > ${marker}; while :; do sleep 1; done`)}], { stdio: ["ignore", 1, "ignore"] });
        descendant.unref();
      `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const leaderExited = once(child, "exit");
      onTestFinished(async () => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        if (existsSync(marker)) {
          const writerPid = Number(readFileSync(marker, "utf8").trim());
          const cleanupDeadline = Date.now() + 1_000;
          while (Date.now() < cleanupDeadline) {
            try {
              process.kill(writerPid, 0);
              await delay(10);
            } catch {
              break;
            }
          }
          expect(() => process.kill(writerPid, 0)).toThrow();
        }
        rmSync(directory, { recursive: true, force: true });
      });
      const cleanup = trackTestProcess(child, LEAK_DEADLINE_MS);
      const setupDeadline = Date.now() + START_WAIT_MS;
      while (!existsSync(marker)) {
        if (Date.now() >= setupDeadline) throw new Error("writer did not start");
        await delay(10);
      }
      const writerPid = readFileSync(marker, "utf8").trim();
      if (child.exitCode === null && child.signalCode === null)
        await leaderExitWithin([leaderExited], "leader");
      const started = Date.now();
      await expect(cleanup()).rejects.toThrow(
        new RegExp(`pid ${writerPid} \\(sh -c echo .*while :; do sleep 1; done\\)`),
      );
      expect(Date.now() - started).toBeLessThan(LEAK_DEADLINE_MS + MARGIN_MS);
    }, START_WAIT_MS + LEADER_EXIT_WAIT_MS + LEAK_DEADLINE_MS + MARGIN_MS);

    it("reaps a background grandchild that outlives its exited leader so cleanup then succeeds", async () => {
      const directory = mkdtempSync(join(tmpdir(), "bb-test-reap-writer-"));
      const marker = join(directory, "pid");
      const child = spawn(process.execPath, ["-e", `
        const { spawn } = require("node:child_process");
        const descendant = spawn("sh", ["-c", ${JSON.stringify(`echo $$ > ${marker}; while :; do sleep 1; done`)}], { stdio: "ignore" });
        descendant.unref();
      `], { detached: true, stdio: "ignore" });
      const leaderExited = once(child, "exit");
      onTestFinished(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        rmSync(directory, { recursive: true, force: true });
      });
      const cleanup = trackTestProcess(child, LEAK_DEADLINE_MS);
      const setupDeadline = Date.now() + START_WAIT_MS;
      while (!existsSync(marker)) {
        if (Date.now() >= setupDeadline) throw new Error("writer did not start");
        await delay(10);
      }
      await leaderExitWithin([leaderExited], "leader");
      expect(killSurvivingTestProcessGroupMembers(child)).toBe(true);
      await cleanup();
      expect(killSurvivingTestProcessGroupMembers(child)).toBe(false);
    }, START_WAIT_MS + LEADER_EXIT_WAIT_MS + LEAK_DEADLINE_MS + MARGIN_MS);

    it("bounds the total time of several leaking cleanups to one deadline and names every writer", async () => {
      const directory = mkdtempSync(join(tmpdir(), "bb-test-two-writers-"));
      const markers = [join(directory, "a"), join(directory, "b")];
      const leaders = markers.map((marker) =>
        spawn(process.execPath, ["-e", `
          const { spawn } = require("node:child_process");
          const descendant = spawn("sh", ["-c", ${JSON.stringify(`echo $$ > ${marker}; while :; do sleep 1; done`)}], { stdio: "ignore" });
          descendant.unref();
        `], { detached: true, stdio: "ignore" }),
      );
      const exits = leaders.map((leader) => once(leader, "exit"));
      onTestFinished(async () => {
        for (const leader of leaders)
          try {
            process.kill(-leader.pid!, "SIGKILL");
          } catch {}
        rmSync(directory, { recursive: true, force: true });
      });
      const cleanups = leaders.map((leader) => trackTestProcess(leader, 60_000));
      const setupDeadline = Date.now() + START_WAIT_MS;
      while (!markers.every((marker) => existsSync(marker))) {
        if (Date.now() >= setupDeadline) throw new Error("writers did not start");
        await delay(10);
      }
      await leaderExitWithin(exits, "leaders");
      const writerPids = markers.map((marker) =>
        readFileSync(marker, "utf8").trim(),
      );
      const started = Date.now();
      const failure = await drainTestProcessCleanups(cleanups, LEAK_DEADLINE_MS).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(LEAK_DEADLINE_MS + MARGIN_MS);
      expect(cleanups).toHaveLength(0);
      expect(failure).toBeInstanceOf(AggregateError);
      const message = (failure as AggregateError).message;
      const namesEveryWriter = writerPids.every((writerPid) =>
        new RegExp(
          `pid ${writerPid} \\(sh -c echo .*while :; do sleep 1; done\\)`,
        ).test(message),
      );
      const expiredBeforeDiagnosis =
        message.includes("deadline expired before diagnosis") &&
        elapsed >= LEAK_DEADLINE_MS;
      expect(namesEveryWriter || expiredBeforeDiagnosis).toBe(true);
    }, START_WAIT_MS + LEADER_EXIT_WAIT_MS + LEAK_DEADLINE_MS + MARGIN_MS);

    it.runIf(process.platform === "darwin")(
      "finishes two cleanups that each hit EPERM on a zombie leader within one shared deadline",
      async () => {
        const leaders = [0, 1].map(() =>
          spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" }),
        );
        onTestFinished(() => {
          for (const leader of leaders)
            try {
              process.kill(-leader.pid!, "SIGKILL");
            } catch {}
        });
        const cleanups = leaders.map((leader) => trackTestProcess(leader, 60_000));
        const end = Date.now() + ZOMBIE_SETTLE_MS;
        while (Date.now() < end);
        for (const leader of leaders) {
          expect(leader.exitCode).toBeNull();
          expect(() => process.kill(-leader.pid!, "SIGKILL")).toThrow(/EPERM/u);
        }
        const started = Date.now();
        await drainTestProcessCleanups(cleanups, ZOMBIE_DEADLINE_MS);
        expect(Date.now() - started).toBeLessThan(ZOMBIE_DEADLINE_MS);
        expect(cleanups).toHaveLength(0);
      },
      ZOMBIE_SETTLE_MS + ZOMBIE_DEADLINE_MS + MARGIN_MS,
    );

    it.runIf(process.platform === "darwin")(
      "treats a group of only unreaped zombies as gone and still kills a group with a live member",
      async () => {
        const blockLoop = (ms: number) => {
          const end = Date.now() + ms;
          while (Date.now() < end);
        };
        const empty = spawn("sh", ["-c", "exit 0"], {
          detached: true,
          stdio: "ignore",
        });
        const live = spawn("sh", ["-c", "sleep 30 & exit 0"], {
          detached: true,
          stdio: "ignore",
        });
        onTestFinished(() => {
          for (const child of [empty, live])
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
        });
        blockLoop(ZOMBIE_SETTLE_MS);
        expect(empty.exitCode).toBeNull();
        expect(live.exitCode).toBeNull();
        expect(() => process.kill(-empty.pid!, "SIGKILL")).toThrow(/EPERM/u);
        expect(killTestProcessGroup(empty, "SIGKILL")).toBe(false);
        expect(killTestProcessGroup(live, "SIGKILL")).toBe(true);
      },
    );

    it.each([
      { name: "a descendant that keeps writing", lifetime: null },
      { name: "a descendant that exits before the deadline", lifetime: 500 },
    ])(
      "bounds cleanup with $name",
      async ({ lifetime }) => {
        const directory = mkdtempSync(join(tmpdir(), "bb-test-pipe-writer-"));
        const marker = join(directory, "writes");
        const stop = join(directory, "stop");
        const finish = join(directory, "finish");
        const descendant = `
      const fs = require("node:fs");
      let count = 0;
      let finishing = false;
      const write = () => {
        if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0);
        fs.writeFileSync(${JSON.stringify(marker)}, String(++count));
        ${
          lifetime === null
            ? ""
            : `if (!finishing && fs.existsSync(${JSON.stringify(finish)})) {
          finishing = true;
          setTimeout(() => process.exit(0), ${lifetime});
        }`
        }
      };
      write();
      setInterval(write, 10);
    `;
        const child = spawn(
          process.execPath,
          [
            "-e",
            `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        stdio: ["ignore", 1, "ignore"],
      });
      descendant.unref();
    `,
          ],
          { detached: true, stdio: ["ignore", "pipe", "ignore"] },
        );
        const exit = once(child, "exit");
        const cleanup = trackTestProcess(child, BOUNDED_DEADLINE_MS);
        onTestFinished(async () => {
          if (existsSync(directory)) writeFileSync(stop, "stop");
          await cleanup();
          rmSync(directory, { recursive: true, force: true });
        });
        await leaderExitWithin([exit], "leader");
        const setupDeadline = Date.now() + START_WAIT_MS;
        while (!existsSync(marker)) {
          if (Date.now() >= setupDeadline)
            throw new Error("descendant did not start writing");
          await delay(10);
        }
        expect(child.exitCode).toBe(0);
        expect(child.stdout?.destroyed).toBe(false);
        let removed = false;
        if (lifetime !== null) writeFileSync(finish, "finish");
        const started = Date.now();
        const result = cleanup().then(() => {
          rmSync(directory, { recursive: true, force: true });
          removed = true;
        });
        if (lifetime === null) {
          await expect(result).rejects.toThrow(
            `Test process group ${child.pid} still has live writers`,
          );
          expect(removed).toBe(false);
          expect(existsSync(marker)).toBe(true);
        } else {
          await result;
          expect(removed).toBe(true);
          expect(existsSync(directory)).toBe(false);
        }
        expect(Date.now() - started).toBeLessThan(
          BOUNDED_DEADLINE_MS + MARGIN_MS,
        );
      },
      START_WAIT_MS + LEADER_EXIT_WAIT_MS + BOUNDED_DEADLINE_MS + MARGIN_MS,
    );
  },
);
