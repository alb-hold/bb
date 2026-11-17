import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { trackTestProcess } from "./test-processes.js";

describe.runIf(process.platform !== "win32")(
  "inherited stdout teardown",
  () => {
    it("reports a real writer pid and command before the bounded deadline", async () => {
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
      const cleanup = trackTestProcess(child, 500);
      const started = Date.now();
      const setupDeadline = Date.now() + 2_000;
      while (!existsSync(marker)) {
        if (Date.now() >= setupDeadline) throw new Error("writer did not start");
        await delay(10);
      }
      const writerPid = readFileSync(marker, "utf8").trim();
      if (child.exitCode === null && child.signalCode === null)
        await leaderExited;
      await expect(cleanup()).rejects.toThrow(
        new RegExp(`pid ${writerPid} \\(sh -c echo .*while :; do sleep 1; done\\)`),
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    }, 3_000);

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
        const cleanup = trackTestProcess(child, 5_000);
        onTestFinished(async () => {
          if (existsSync(directory)) writeFileSync(stop, "stop");
          await cleanup();
          rmSync(directory, { recursive: true, force: true });
        });
        await exit;
        const setupDeadline = Date.now() + 2_000;
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
        expect(Date.now() - started).toBeLessThan(6_000);
      },
      8_000,
    );
  },
);
