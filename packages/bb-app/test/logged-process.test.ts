import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  unlinkSync,
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

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Child stalled while writing logs"));
    }, 5_000);
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
    const logPath = join(logDir, "server-stdio.log");
    await expect
      .poll(
        () =>
          existsSync(logPath) &&
          readFileSync(logPath, "utf8") === "first startup\nsecond startup\n",
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  it("drains sustained output when a live unrelated process owns the log lock", async () => {
    const logDir = scratchDir();
    const logPath = join(logDir, "server-stdio.log");
    const expectedSize = 25 * 1024 * 1024;
    const sizeLimit = 10 * 1024 * 1024;
    writeFileSync(`${logPath}.lock`, String(process.pid));
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `
          const chunk = "x".repeat(64 * 1024);
          let remaining = ${expectedSize};
          const writeNext = () => {
            const next = chunk.slice(0, Math.min(chunk.length, remaining));
            process.stdout.write(next, (error) => {
              if (error) process.exit(1);
              remaining -= next.length;
              if (remaining > 0) setImmediate(writeNext);
              else process.exit(0);
            });
          };
          writeNext();
        `,
      ],
      env: process.env,
      logDir,
      logName: "server",
    });
    const childExit = waitForExit(child);
    const logFiles = () =>
      readdirSync(logDir)
        .filter(
          (name) =>
            name === "server-stdio.log" ||
            /^server-stdio\.log\.\d+$/.test(name),
        )
        .map((name) => join(logDir, name));

    try {
      await expect
        .poll(
          () => {
            return logFiles().reduce(
              (total, filePath) => total + statSync(filePath).size,
              0,
            );
          },
          { timeout: 3_000 },
        )
        .toBe(expectedSize);
      expect(await childExit).toBe(0);
      const filePaths = logFiles();
      expect(filePaths.length).toBeLessThanOrEqual(6);
      expect(
        filePaths.every((filePath) => statSync(filePath).size <= sizeLimit),
      ).toBe(true);
      expect(
        filePaths.filter((filePath) => filePath !== logPath).length,
      ).toBeLessThanOrEqual(5);
      expect(
        filePaths.reduce(
          (total, filePath) => total + statSync(filePath).size,
          0,
        ),
      ).toBeLessThanOrEqual(6 * sizeLimit);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("expires a stale append lock held by a live unrelated process", async () => {
    const logDir = scratchDir();
    const logPath = join(logDir, "server-stdio.log");
    const expectedSize = 25 * 1024 * 1024;
    const sizeLimit = 10 * 1024 * 1024;
    const appendLockPath = `${logPath}.append.lock`;
    writeFileSync(appendLockPath, String(process.pid));
    utimesSync(appendLockPath, new Date(0), new Date(0));
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `
          const chunk = "x".repeat(64 * 1024);
          let remaining = ${expectedSize};
          const writeNext = () => {
            const next = chunk.slice(0, Math.min(chunk.length, remaining));
            process.stdout.write(next, (error) => {
              if (error) process.exit(1);
              remaining -= next.length;
              if (remaining > 0) setImmediate(writeNext);
              else process.stdout.end("LOCK_END\\n", () => process.exit(0));
            });
          };
          writeNext();
        `,
      ],
      env: process.env,
      logDir,
      logName: "server",
    });
    const childExit = waitForExit(child);
    const logFiles = () =>
      readdirSync(logDir)
        .filter(
          (name) =>
            name === "server-stdio.log" ||
            /^server-stdio\.log\.\d+$/.test(name),
        )
        .map((name) => join(logDir, name));

    try {
      await expect
        .poll(
          () =>
            logFiles().reduce(
              (total, filePath) => total + statSync(filePath).size,
              0,
            ),
          { timeout: 4_000 },
        )
        .toBe(expectedSize + 9);
      expect(await childExit).toBe(0);
      const filePaths = logFiles();
      expect(filePaths.length).toBeLessThanOrEqual(6);
      expect(
        filePaths.filter((filePath) => filePath !== logPath).length,
      ).toBeLessThanOrEqual(5);
      expect(
        filePaths.every((filePath) => statSync(filePath).size <= sizeLimit),
      ).toBe(true);
      expect(readFileSync(logPath, "utf8")).toContain("LOCK_END\n");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
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
    const logPath = join(logDir, "server-stdio.log");
    const attemptedPath = join(logDir, "first-write-attempted");
    const laterPath = join(logDir, "later-write-completed");
    symlinkSync("/dev/full", logPath);
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
    });

    await expect
      .poll(() => existsSync(attemptedPath), { timeout: 5_000 })
      .toBe(true);
    unlinkSync(logPath);
    expect(await waitForExit(child)).toBe(0);
    expect(existsSync(laterPath)).toBe(true);
    await expect
      .poll(
        () =>
          existsSync(logPath) &&
          readFileSync(logPath, "utf8").includes("later output recovered\n"),
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
    expect(readFileSync(`${logPath}.1`, "utf8")).toContain("previous-active:");
    for (let index = 1; index <= 4; index += 1) {
      expect(readFileSync(`${logPath}.${index + 1}`, "utf8")).toBe(
        `previous-${index}`,
      );
    }
    expect(existsSync(`${logPath}.6`)).toBe(false);
  });

  it("preserves the size cap when two writers share a log path", async () => {
    const logDir = scratchDir();
    const children = ["a", "b"].map((marker) =>
      spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write(${JSON.stringify(marker)}.repeat(12 * 1024 * 1024));`,
        ],
        env: process.env,
        logDir,
        logName: "server",
      }),
    );

    expect(await Promise.all(children.map(waitForExit))).toEqual([0, 0]);
    const logPath = join(logDir, "server-stdio.log");
    await expect
      .poll(
        () =>
          [
            logPath,
            ...Array.from({ length: 5 }, (_, i) => `${logPath}.${i + 1}`),
          ]
            .filter(existsSync)
            .reduce((total, filePath) => total + statSync(filePath).size, 0),
        { timeout: 5_000 },
      )
      .toBe(24 * 1024 * 1024);
    for (const filePath of [
      logPath,
      ...Array.from({ length: 5 }, (_, i) => `${logPath}.${i + 1}`),
    ]) {
      if (existsSync(filePath)) {
        expect(statSync(filePath).size).toBeLessThanOrEqual(10 * 1024 * 1024);
      }
    }
    expect(existsSync(`${logPath}.6`)).toBe(false);
  });

  it("keeps two lockless writers within the shared file-family bound", async () => {
    const logDir = scratchDir();
    const logPath = join(logDir, "server-stdio.log");
    const expectedPerWriter = 13 * 1024 * 1024;
    const expectedTotal = expectedPerWriter * 2 + 12;
    const sizeLimit = 10 * 1024 * 1024;
    writeFileSync(`${logPath}.lock`, String(process.pid));
    const children = ["a", "b"].map((marker) =>
      spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `
            const chunk = ${JSON.stringify(marker)}.repeat(64 * 1024);
            let remaining = ${expectedPerWriter};
            const writeNext = () => {
              const next = chunk.slice(0, Math.min(chunk.length, remaining));
              process.stdout.write(next, (error) => {
                if (error) process.exit(1);
                remaining -= next.length;
                if (remaining > 0) setImmediate(writeNext);
                else process.stdout.end(${JSON.stringify(`${marker.toUpperCase()}_END\n`)}, () => process.exit(0));
              });
            };
            writeNext();
          `,
        ],
        env: process.env,
        logDir,
        logName: "server",
      }),
    );

    try {
      expect(await Promise.all(children.map(waitForExit))).toEqual([0, 0]);
      const familyPaths = () =>
        readdirSync(logDir)
          .filter(
            (name) =>
              name === "server-stdio.log" ||
              /^server-stdio\.log\.\d+$/.test(name),
          )
          .map((name) => join(logDir, name));
      await expect
        .poll(
          () =>
            familyPaths().reduce(
              (total, filePath) => total + statSync(filePath).size,
              0,
            ),
          { timeout: 5_000 },
        )
        .toBe(expectedTotal);
      const filePaths = familyPaths();
      expect(filePaths.length).toBeLessThanOrEqual(6);
      expect(
        filePaths.filter((filePath) => filePath !== logPath).length,
      ).toBeLessThanOrEqual(5);
      expect(
        filePaths.every((filePath) => statSync(filePath).size <= sizeLimit),
      ).toBe(true);
      expect(
        filePaths.reduce(
          (total, filePath) => total + statSync(filePath).size,
          0,
        ),
      ).toBe(expectedTotal);
      const activeOutput = readFileSync(logPath, "utf8");
      expect(activeOutput).toMatch(/[AB]_END\n/);
      const retainedOutput = filePaths
        .map((filePath) => readFileSync(filePath, "utf8"))
        .join("");
      expect(retainedOutput.split("a").length - 1).toBe(expectedPerWriter);
      expect(retainedOutput.split("b").length - 1).toBe(expectedPerWriter);
      expect(retainedOutput).toContain("A_END\n");
      expect(retainedOutput).toContain("B_END\n");
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
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
    const rotatedPath = `${currentPath}.1`;
    expect(statSync(currentPath).size).toBe(1024 * 1024);
    expect(statSync(rotatedPath).size).toBe(10 * 1024 * 1024);
    expect(readFileSync(currentPath, "utf8")).toBe("x".repeat(1024 * 1024));
    for (let index = 2; index <= 5; index += 1) {
      expect(statSync(`${currentPath}.${index}`).size).toBe(10 * 1024 * 1024);
    }
    expect(existsSync(`${currentPath}.6`)).toBe(false);
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
