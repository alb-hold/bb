import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnLoggedProcess } from "../src/logged-process.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-logged-process-"));
  scratchDirs.push(dir);
  return dir;
}

function familyFiles(logDir: string, logName: string): string[] {
  return readdirSync(logDir)
    .filter(
      (name) =>
        name === `${logName}-stdio.log` ||
        name.startsWith(`${logName}-stdio.log.active-`) ||
        name.startsWith(`${logName}-stdio.log.backup-`),
    )
    .map((name) => join(logDir, name));
}

function uniqueFamilyFiles(logDir: string, logName: string): string[] {
  const seen = new Set<string>();
  return familyFiles(logDir, logName).filter((path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return false;
    }
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Child stalled while writing logs"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("spawnLoggedProcess", () => {
  it.each(["server", "host-daemon"] as const)(
    "captures %s stdout and stderr bursts while draining child pipes",
    async (logName) => {
      const logDir = join(scratchDir(), "logs");
      const child = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `
            process.stdout.write("A".repeat(2 * 1024 * 1024) + "\\n");
            process.stderr.write("B".repeat(2 * 1024 * 1024) + "\\n");
            setImmediate(() => process.stdout.write("done\\n"));
          `,
        ],
        env: process.env,
        logDir,
        logName,
      });

      expect(await waitForExit(child)).toBe(0);
      const logPath = join(logDir, `${logName}-stdio.log`);
      const output = readFileSync(logPath, "utf8");
      expect(output.split("A").length - 1).toBe(2 * 1024 * 1024);
      expect(output.split("B").length - 1).toBe(2 * 1024 * 1024);
      expect(output).toContain("done\n");
      if (process.platform !== "win32")
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
    },
  );

  it("preserves output across child restarts, including early failures", async () => {
    const logDir = scratchDir();
    for (const message of ["first startup", "second startup"]) {
      const child = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `console.error(${JSON.stringify(message)}); process.exit(1);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
      });
      expect(await waitForExit(child)).toBe(1);
    }
    await expect
      .poll(
        () =>
          (() => {
            try {
              const output = uniqueFamilyFiles(logDir, "server")
                .map((path) => readFileSync(path, "utf8"))
                .join("");
              return (
                output.includes("first startup\n") &&
                output.includes("second startup\n")
              );
            } catch {
              return false;
            }
          })(),
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  it("keeps a paused writer within its own segment while another writer rotates", async () => {
    const logDir = scratchDir();
    const enteredPath = join(logDir, "first-writer-before-write");
    const releasePath = join(logDir, "release-first-writer");
    const firstBytes = 9 * 1024 * 1024 + 64 * 1024;
    const secondBytes = 11 * 1024 * 1024;
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.alloc(${firstBytes}, 65));`],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        enteredPath,
        releasePath,
        pauseAtBytes: 9 * 1024 * 1024,
      },
    });
    let second: ChildProcess | undefined;
    try {
      await expect
        .poll(() => existsSync(enteredPath), { timeout: 5_000, interval: 10 })
        .toBe(true);
      second = spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", `process.stdout.write(Buffer.alloc(${secondBytes}, 66));`],
        env: process.env,
        logDir,
        logName: "server",
      });
      expect(await waitForExit(second)).toBe(0);
      writeFileSync(releasePath, "release");
      expect(await waitForExit(first)).toBe(0);
      await expect
        .poll(
          () => {
            try {
              return Buffer.concat(
                uniqueFamilyFiles(logDir, "server").map((path) =>
                  readFileSync(path),
                ),
              ).length;
            } catch {
              return 0;
            }
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(firstBytes + secondBytes);
      const files = uniqueFamilyFiles(logDir, "server");
      const backups = familyFiles(logDir, "server").filter((path) =>
        path.includes(".backup-"),
      );
      expect(backups.length).toBeLessThanOrEqual(5);
      expect(
        familyFiles(logDir, "server").every(
          (path) => statSync(path).size <= 10 * 1024 * 1024,
        ),
      ).toBe(true);
      expect(
        files.every((path) => statSync(path).size <= 10 * 1024 * 1024),
      ).toBe(true);
      const output = Buffer.concat(files.map((path) => readFileSync(path)));
      expect(
        output.length,
        JSON.stringify(
          files.map((path) => [
            path,
            statSync(path).size,
            readFileSync(path).filter((byte) => byte === 65).length,
            readFileSync(path).filter((byte) => byte === 66).length,
          ]),
        ),
      ).toBe(firstBytes + secondBytes);
      expect(output.filter((byte) => byte === 65).length).toBe(firstBytes);
      expect(output.filter((byte) => byte === 66).length).toBe(secondBytes);
      expect(
        statSync(join(logDir, "server-stdio.log")).size,
      ).toBeLessThanOrEqual(10 * 1024 * 1024);
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release");
      if (first.exitCode === null) first.kill("SIGKILL");
      if (second?.exitCode === null) second.kill("SIGKILL");
    }
  });

  it("keeps the child alive and logging after its parent exits", async () => {
    const logDir = scratchDir();
    const markerPath = join(logDir, "child-alive");
    const launcher = spawn(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import { spawnLoggedProcess } from "./src/logged-process.ts";
          spawnLoggedProcess({
            command: process.execPath,
            args: ["-e", ${JSON.stringify(
              `setTimeout(() => { process.stdout.write("after parent close\\n"); require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "alive"); }, 250); setTimeout(() => process.exit(0), 350);`,
            )}],
            env: process.env,
            logDir: ${JSON.stringify(logDir)},
            logName: "server",
          });
          process.exit(0);
        `,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "ignore" },
    );

    expect(await waitForExit(launcher)).toBe(0);
    await expect
      .poll(() => existsSync(markerPath), { timeout: 5_000 })
      .toBe(true);
    const logPath = join(logDir, "server-stdio.log");
    await expect
      .poll(
        () =>
          existsSync(logPath) &&
          readFileSync(logPath, "utf8").includes("after parent close\n"),
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  it("keeps the child alive and resumes logging after a write error", async () => {
    const logDir = scratchDir();
    const attemptedPath = join(logDir, "first-write-attempted");
    const laterPath = join(logDir, "later-write-completed");
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `
          const fs = require("node:fs");
          process.stdout.write("x".repeat(4 * 1024 * 1024), () => {
            fs.writeFileSync(${JSON.stringify(attemptedPath)}, "attempted");
            setTimeout(() => {
              process.stdout.write("later output recovered\\n");
              fs.writeFileSync(${JSON.stringify(laterPath)}, "alive");
            }, 150);
            setTimeout(() => process.exit(0), 250);
          });
        `,
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: { failFirstWrite: true },
    });

    await expect
      .poll(() => existsSync(attemptedPath), { timeout: 5_000 })
      .toBe(true);
    expect(await waitForExit(child)).toBe(0);
    expect(existsSync(laterPath)).toBe(true);
    await expect
      .poll(
        () =>
          uniqueFamilyFiles(logDir, "server")
            .map((path) => readFileSync(path, "utf8"))
            .join("")
            .includes("later output recovered\n"),
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  it("rotates an oversized active log without discarding its contents", async () => {
    const logDir = scratchDir();
    const logPath = join(logDir, "server-stdio.log");
    writeFileSync(logPath, `previous-active:${"x".repeat(11 * 1024 * 1024)}`);
    for (let index = 1; index <= 5; index += 1) {
      writeFileSync(`${logPath}.${index}`, `previous-${index}`);
    }
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write("new active output\\n");`],
      env: process.env,
      logDir,
      logName: "server",
    });

    expect(await waitForExit(child)).toBe(0);
    await expect
      .poll(
        () =>
          existsSync(logPath) &&
          readFileSync(logPath, "utf8").includes("new active output\n"),
        { timeout: 5_000 },
      )
      .toBe(true);
    const backups = familyFiles(logDir, "server").filter((path) =>
      path.includes(".backup-"),
    );
    expect(backups.length).toBeLessThanOrEqual(5);
    expect(
      backups.some((path) =>
        readFileSync(path, "utf8").includes("previous-active:"),
      ),
    ).toBe(true);
    expect(
      backups.every((path) => statSync(path).size <= 10 * 1024 * 1024),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "passes the parent environment to the detached log writer",
    async () => {
      const logDir = scratchDir();
      const fakeElectronPath = join(logDir, "electron");
      const writerStartedPath = join(logDir, "writer-started");
      writeFileSync(
        fakeElectronPath,
        `#!/usr/bin/env node\nif (process.env.ELECTRON_RUN_AS_NODE !== "1") process.exit(88);\nrequire("node:fs").writeFileSync(${JSON.stringify(writerStartedPath)}, "started");\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: "inherit", env: process.env });\nprocess.exit(result.status ?? 1);\n`,
      );
      chmodSync(fakeElectronPath, 0o700);
      const outputPath = join(logDir, "server-stdio.log");
      const previousExecPath = process.execPath;
      const previousElectronMode = process.env.ELECTRON_RUN_AS_NODE;
      process.env.ELECTRON_RUN_AS_NODE = "1";
      Object.defineProperty(process, "execPath", { value: fakeElectronPath });
      let child!: ChildProcess;
      try {
        child = spawnLoggedProcess({
          command: previousExecPath,
          args: ["-e", `process.stdout.write("writer environment\\n");`],
          env: process.env,
          logDir,
          logName: "server",
        });
      } finally {
        Object.defineProperty(process, "execPath", { value: previousExecPath });
        if (previousElectronMode === undefined)
          delete process.env.ELECTRON_RUN_AS_NODE;
        else process.env.ELECTRON_RUN_AS_NODE = previousElectronMode;
      }

      expect(await waitForExit(child)).toBe(0);
      await expect
        .poll(() => existsSync(writerStartedPath), { timeout: 5_000 })
        .toBe(true);
      await expect
        .poll(
          () =>
            existsSync(outputPath) &&
            readFileSync(outputPath, "utf8").includes("writer environment\n"),
          { timeout: 5_000 },
        )
        .toBe(true);
    },
  );

  it("rotates stdio output at the log size limit", async () => {
    const logDir = scratchDir();
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(61 * 1024 * 1024));`],
      env: process.env,
      logDir,
      logName: "server",
    });

    expect(await waitForExit(child)).toBe(0);
    const currentPath = join(logDir, "server-stdio.log");
    const backups = () =>
      familyFiles(logDir, "server").filter((path) => path.includes(".backup-"));
    await expect
      .poll(
        () =>
          existsSync(currentPath) &&
          statSync(currentPath).size === 1024 * 1024 &&
          backups().length === 5,
        { timeout: 5_000, interval: 10 },
      )
      .toBe(true);
    expect(backups()).toHaveLength(5);
    expect(statSync(currentPath).size).toBe(1024 * 1024);
    expect(readFileSync(currentPath, "utf8")).toBe("x".repeat(1024 * 1024));
    expect(
      familyFiles(logDir, "server").every(
        (path) => statSync(path).size <= 10 * 1024 * 1024,
      ),
    ).toBe(true);
  });

  it("fails instead of falling back to terminal output when logs cannot be opened", () => {
    const logDir = scratchDir();
    const blockedPath = join(logDir, "not-a-directory");
    writeFileSync(blockedPath, "occupied");
    expect(() =>
      spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: process.env,
        logDir: blockedPath,
        logName: "server",
      }),
    ).toThrow();
  });

  it("reports executable spawn failures", async () => {
    const logDir = scratchDir();
    const child = spawnLoggedProcess({
      command: join(logDir, "missing-executable"),
      args: [],
      env: process.env,
      logDir,
      logName: "server",
    });
    await expect(waitForExit(child)).rejects.toThrow("ENOENT");
  });
});
