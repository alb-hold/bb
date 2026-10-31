import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { trackTestProcess } from "./test-processes.js";

describe.runIf(process.platform !== "win32")(
  "inherited stdout teardown",
  () => {
    it.each([
      { name: "a descendant that keeps writing", lifetime: null },
      { name: "a descendant that exits before the deadline", lifetime: 500 },
    ])(
      "bounds cleanup with $name",
      async ({ lifetime }) => {
        const directory = mkdtempSync(join(tmpdir(), "bb-test-pipe-writer-"));
        const marker = join(directory, "writes");
        const stop = join(directory, "stop");
        const descendant = `
      const fs = require("node:fs");
      let count = 0;
      const write = () => {
        if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0);
        fs.writeFileSync(${JSON.stringify(marker)}, String(++count));
      };
      write();
      setInterval(write, 10);
      ${lifetime === null ? "" : `setTimeout(() => process.exit(0), ${lifetime});`}
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
        const cleanup = trackTestProcess(child);
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
