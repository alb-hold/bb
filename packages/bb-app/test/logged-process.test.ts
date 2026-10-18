import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { basename, join, resolve } from "node:path";
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

function livenessDirectory(logDir: string, logName: string): string {
  const logPath = join(logDir, `${logName}-stdio.log`);
  const user = process.getuid?.() ?? process.env.USERNAME ?? "";
  const hash = createHash("sha256")
    .update(`${resolve(logPath)}-${user}`)
    .digest("hex")
    .slice(0, 12);
  const name = `.bb-stdio-${hash}`;
  return join("/tmp", name);
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

function fileIncludes(path: string, content: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(content);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
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

function currentProcessIdentity(): {
  fingerprint: string;
  pid: number;
  source: 0 | 1 | 2;
} {
  let source: 0 | 1 | 2 = 0;
  let startTime: string | undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${String(process.pid)}/stat`, "utf8");
      startTime = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u)[19];
      if (startTime !== undefined) source = 1;
    } catch {
      startTime = undefined;
    }
  } else if (process.platform === "darwin") {
    try {
      startTime = execFileSync(
        "ps",
        ["-o", "lstart=", "-p", String(process.pid)],
        {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        },
      ).trim();
      if (startTime.length > 0) source = 2;
    } catch {
      startTime = undefined;
    }
  }
  return {
    fingerprint:
      startTime === undefined
        ? "0000000000000000"
        : createHash("sha256").update(startTime).digest("hex").slice(0, 16),
    pid: process.pid,
    source,
  };
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

function socketResponds(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => resolvePromise(false));
  });
}

function socketTokenFromActivePath(activePath: string): string {
  const parts = activePath.slice(activePath.indexOf(".active-") + 8).split("-");
  const socketIdentityMarker = parts.length - 3;
  const end =
    parts[socketIdentityMarker] === "i" ? socketIdentityMarker : undefined;
  return parts.slice(4, end).join("-");
}

describe("spawnLoggedProcess", () => {
  it.skipIf(process.platform === "win32")(
    "keeps a live segment when its endpoint directory has unsafe permissions",
    async () => {
      const logDir = scratchDir();
      const firstTempDir = scratchDir();
      const socketDir = livenessDirectory(logDir, "server");
      const stopFirstPath = join(logDir, "stop-no-endpoint-first");
      const stopObserverPath = join(logDir, "stop-no-endpoint-observer");
      const diagnosticPath = join(logDir, "unsafe-directory-diagnostic");
      mkdirSync(socketDir, { mode: 0o755 });
      scratchDirs.push(socketDir);
      chmodSync(socketDir, 0o755);
      const childArgs = (label: string, stopPath: string) => [
        "-e",
        `const fs = require("node:fs"); let count = 0; const timer = setInterval(() => { process.stdout.write(${JSON.stringify(label)} + "-" + (++count) + "\\n"); if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ];
      const first = spawnLoggedProcess({
        command: process.execPath,
        args: childArgs("no-endpoint-first", stopFirstPath),
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: {
          diagnosticPath,
          writerEnv: { TMPDIR: firstTempDir },
        },
      });
      let observer: ReturnType<typeof spawnLoggedProcess> | undefined;
      try {
        await expect
          .poll(
            () =>
              familyFiles(logDir, "server").find(
                (file) =>
                  file.includes(".active-") &&
                  readFileSync(file, "utf8").includes("no-endpoint-first-"),
              ),
            { timeout: 5_000, interval: 10 },
          )
          .toBeDefined();
        const firstSegment = familyFiles(logDir, "server").find(
          (file) =>
            file.includes(".active-") &&
            readFileSync(file, "utf8").includes("no-endpoint-first-"),
        )!;
        expect(firstSegment).toContain("-n-");
        chmodSync(socketDir, 0o700);

        observer = spawnLoggedProcess({
          command: process.execPath,
          args: childArgs("no-endpoint-observer", stopObserverPath),
          env: process.env,
          logDir,
          logName: "server",
          testWriterBarrier: { recoveryIntervalMs: 25 },
        });
        await expect
          .poll(
            () =>
              familyFiles(logDir, "server").some(
                (file) =>
                  file.includes(".active-") &&
                  readFileSync(file, "utf8").includes("no-endpoint-observer-"),
              ),
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true);
        const observerSegment = familyFiles(logDir, "server").find(
          (file) =>
            file.includes(".active-") &&
            readFileSync(file, "utf8").includes("no-endpoint-observer-"),
        )!;
        expect(observerSegment).toContain("-e-");
        await expect
          .poll(
            () => {
              const segment = familyFiles(logDir, "server").find(
                (file) =>
                  file.includes(".active-") &&
                  readFileSync(file, "utf8").includes("no-endpoint-observer-"),
              );
              return segment === undefined
                ? 0
                : (readFileSync(segment, "utf8").match(
                    /no-endpoint-observer-/gu,
                  )?.length ?? 0);
            },
            { timeout: 3_000, interval: 10 },
          )
          .toBeGreaterThanOrEqual(10);
        expect(existsSync(firstSegment)).toBe(true);
        expect(
          readFileSync(firstSegment, "utf8").match(/no-endpoint-first-/gu)
            ?.length ?? 0,
        ).toBeGreaterThanOrEqual(3);
        expect(statSync(socketDir).mode & 0o777).toBe(0o700);
        expect(readFileSync(diagnosticPath, "utf8")).toContain(
          "stdio liveness directory rejected: EACCES",
        );

        writeFileSync(stopFirstPath, "stop");
        writeFileSync(stopObserverPath, "stop");
        expect(await waitForExit(first)).toBe(0);
        expect(await waitForExit(observer)).toBe(0);
        await Promise.all([first.writerExit, observer.writerExit]);
        expect(
          uniqueFamilyFiles(logDir, "server")
            .map((file) => readFileSync(file, "utf8"))
            .join(""),
        ).toContain("no-endpoint-first-");
      } finally {
        if (!existsSync(stopFirstPath)) writeFileSync(stopFirstPath, "stop");
        if (!existsSync(stopObserverPath))
          writeFileSync(stopObserverPath, "stop");
        if (first.exitCode === null) first.kill("SIGKILL");
        if (observer?.exitCode === null) observer.kill("SIGKILL");
        await Promise.all([
          first.writerExit,
          ...(observer ? [observer.writerExit] : []),
        ]);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a symlink as the liveness directory and keeps logging",
    async () => {
      const logDir = scratchDir();
      const socketDir = livenessDirectory(logDir, "server");
      const targetDir = join(scratchDir(), "socket-target");
      const diagnosticPath = join(logDir, "symlink-directory-diagnostic");
      mkdirSync(targetDir, { mode: 0o700 });
      symlinkSync(targetDir, socketDir, "dir");
      scratchDirs.push(socketDir);
      const child = spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("symlink setup output\\n");'],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: { diagnosticPath },
      });
      expect(await waitForExit(child)).toBe(0);
      await child.writerExit;
      expect(
        uniqueFamilyFiles(logDir, "server")
          .map((file) => readFileSync(file, "utf8"))
          .join(""),
      ).toContain("symlink setup output\n");
      expect(lstatSync(socketDir).isSymbolicLink()).toBe(true);
      expect(readdirSync(targetDir)).toEqual([]);
      expect(readFileSync(diagnosticPath, "utf8")).toContain(
        "stdio liveness directory rejected: EACCES",
      );
    },
  );

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

  it("reports output lost after real open and append failures, then resumes logging", async () => {
    const logDir = scratchDir();
    const attemptedPath = join(logDir, "first-write-attempted");
    const laterPath = join(logDir, "later-write-completed");
    const diagnosticPath = join(logDir, "writer-diagnostics");
    const lostOutput = "unique child payload 61d";
    writeFileSync(diagnosticPath, "");
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `
          const fs = require("node:fs");
          process.stdout.write(${JSON.stringify(lostOutput)}, () => {
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
      testWriterBarrier: {
        failActiveOpenCount: 4,
        failActiveWriteCount: 1,
        diagnosticPath,
      },
    });

    await expect
      .poll(() => existsSync(attemptedPath), { timeout: 5_000 })
      .toBe(true);
    expect(await waitForExit(child)).toBe(0);
    await child.writerExit;
    expect(existsSync(laterPath)).toBe(true);
    await expect
      .poll(
        () =>
          (() => {
            const output = uniqueFamilyFiles(logDir, "server")
              .map((path) => readFileSync(path, "utf8"))
              .join("");
            return (
              output.includes("later output recovered\n") &&
              (output.includes(lostOutput) ||
                output.includes(
                  `[bb] ${Buffer.byteLength(lostOutput)} bytes of child output lost: EIO\n`,
                ))
            );
          })(),
        { timeout: 5_000 },
      )
      .toBe(true);
    const output = uniqueFamilyFiles(logDir, "server")
      .map((path) => readFileSync(path, "utf8"))
      .join("");
    if (!output.includes(lostOutput)) {
      expect(output).toContain(
        `[bb] ${Buffer.byteLength(lostOutput)} bytes of child output lost: EIO\n`,
      );
      expect(readFileSync(diagnosticPath, "utf8")).toContain(
        `${Buffer.byteLength(lostOutput)} bytes of child output lost: EIO`,
      );
    }
    expect(readFileSync(diagnosticPath, "utf8")).toContain(
      "stdio output retry",
    );
  });

  it("recovers a dead writer segment during a survivor rotation", async () => {
    const logDir = scratchDir();
    const firstBytes = 1024 * 1024;
    const secondBytes = 11 * 1024 * 1024;
    const enteredPath = join(logDir, "survivor-before-write");
    const releasePath = join(logDir, "release-survivor");
    const completionPath = join(logDir, "survivor-writer-finished");
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(Buffer.alloc(${firstBytes}, 65)); setInterval(() => {}, 1000);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
    });
    let survivor: ChildProcess | undefined;
    let writerPid: number | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (path) =>
                path.includes(".active-") && statSync(path).size >= firstBytes,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const firstSegment = familyFiles(logDir, "server").find((path) =>
        path.includes(".active-"),
      );
      expect(firstSegment).toBeDefined();
      writerPid = Number(firstSegment!.match(/\.active-(\d+)-/)?.[1]);
      expect(Number.isInteger(writerPid)).toBe(true);
      survivor = spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", `process.stdout.write(Buffer.alloc(${secondBytes}, 66));`],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: {
          enteredPath,
          releasePath,
          pauseAtBytes: 9 * 1024 * 1024,
          completionPath,
        },
      });
      await expect
        .poll(() => existsSync(enteredPath), { timeout: 5_000, interval: 10 })
        .toBe(true);
      process.kill(writerPid!, "SIGKILL");
      await expect
        .poll(
          () => {
            try {
              process.kill(writerPid!, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      writeFileSync(releasePath, "release");
      expect(await waitForExit(survivor)).toBe(0);
      await expect
        .poll(() => existsSync(completionPath), {
          timeout: 5_000,
          interval: 10,
        })
        .toBe(true);
      await expect
        .poll(
          () =>
            !familyFiles(logDir, "server").some((path) =>
              path.includes(`.active-${writerPid}-`),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
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
      const output = Buffer.concat(files.map((path) => readFileSync(path)));
      expect(output.length).toBe(firstBytes + secondBytes);
      expect(output.filter((byte) => byte === 65).length).toBe(firstBytes);
      expect(output.filter((byte) => byte === 66).length).toBe(secondBytes);
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release");
      if (writerPid !== undefined) {
        try {
          process.kill(writerPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (first.exitCode === null) first.kill("SIGKILL");
      if (survivor?.exitCode === null) survivor.kill("SIGKILL");
    }
  });

  it("recovers a killed writer's completed output when a later writer starts", async () => {
    const logDir = scratchDir();
    const enteredPath = join(logDir, "killed-writer-finalizing");
    const releasePath = join(logDir, "release-killed-writer");
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("before writer kill\\n");'],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        finalizationEnteredPath: enteredPath,
        finalizationReleasePath: releasePath,
      },
    });
    let survivor: ReturnType<typeof spawnLoggedProcess> | undefined;
    try {
      expect(await waitForExit(first)).toBe(0);
      await expect
        .poll(() => existsSync(enteredPath), { timeout: 5_000, interval: 10 })
        .toBe(true);
      const activeSegment = familyFiles(logDir, "server").find(
        (file) =>
          file.includes(".active-") &&
          readFileSync(file, "utf8").includes("before writer kill\n"),
      );
      expect(activeSegment).toBeDefined();
      const writerPid = Number(readFileSync(enteredPath, "utf8"));
      expect(writerPid).toBe(first.writerProcess.pid);
      first.writerProcess.kill("SIGKILL");
      await first.writerExit;
      let writerIsGone = false;
      try {
        process.kill(writerPid, 0);
      } catch (error) {
        writerIsGone = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      expect(writerIsGone).toBe(true);

      survivor = spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("later writer output\\n");'],
        env: process.env,
        logDir,
        logName: "server",
      });
      expect(await waitForExit(survivor)).toBe(0);
      await survivor.writerExit;
      await expect
        .poll(() => activeSegment !== undefined && !existsSync(activeSegment), {
          timeout: 5_000,
          interval: 10,
        })
        .toBe(true);
      const output = uniqueFamilyFiles(logDir, "server")
        .map((file) => readFileSync(file, "utf8"))
        .join("");
      expect(output).toContain("before writer kill\n");
      expect(output).toContain("later writer output\n");
    } finally {
      if (
        first.writerProcess.exitCode === null &&
        first.writerProcess.signalCode === null
      ) {
        writeFileSync(releasePath, "release");
        first.writerProcess.kill("SIGKILL");
        await first.writerExit;
      }
      if (first.exitCode === null) first.kill("SIGKILL");
      if (survivor?.exitCode === null) survivor.kill("SIGKILL");
      if (survivor !== undefined) await survivor.writerExit;
    }
  });

  it("recovers a segment with no owner endpoint while its pid is live", async () => {
    const logDir = scratchDir();
    const stopPath = join(logDir, "stop-incarnation-survivor");
    const completionPath = join(logDir, "incarnation-survivor-finished");
    const source = process.platform === "linux" ? 1 : 2;
    const mismatchedSegment = join(
      logDir,
      `server-stdio.log.active-${process.pid}-${source}-0000000000000000-deadbeef-dead-beef-dead-beefdeadbeef`,
    );
    const survivor = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs"); process.stdout.write("incarnation-survivor-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        completionPath,
        recoveryIntervalMs: 25,
      },
    });
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some((path) =>
              path.includes(".active-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      writeFileSync(mismatchedSegment, "reused-pid-segment\\n");
      await expect
        .poll(() => !existsSync(mismatchedSegment), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
      const recovered = familyFiles(logDir, "server").find(
        (path) =>
          path.includes(".backup-") &&
          readFileSync(path, "utf8").includes("reused-pid-segment\\n"),
      );
      expect(recovered).toBeDefined();
      expect(survivor.exitCode).toBeNull();
      writeFileSync(stopPath, "stop");
      expect(await waitForExit(survivor)).toBe(0);
      await expect
        .poll(() => existsSync(completionPath), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
    } finally {
      if (survivor.exitCode === null) survivor.kill("SIGKILL");
    }
  });

  it("uses repeated Windows pipe ENOENT as death proof despite a matching live pid and keeps busy pipes", async () => {
    const logDir = scratchDir();
    const identity = {
      source: 2 as const,
      fingerprint: "1111111111111111",
    };
    const ownerToken = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const deadPipeToken = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const busyOwnerToken = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const busyPipeToken = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const deadSegment = join(
      logDir,
      `server-stdio.log.active-${process.pid}-${identity.source}-${identity.fingerprint}-e-${ownerToken}-p-${deadPipeToken}`,
    );
    const busySegment = join(
      logDir,
      `server-stdio.log.active-${process.pid}-${identity.source}-${identity.fingerprint}-e-${busyOwnerToken}-p-${busyPipeToken}`,
    );
    writeFileSync(deadSegment, "dead Windows writer output\\n");
    writeFileSync(busySegment, "live busy Windows writer output\\n");
    const observer = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("Windows recovery observer\\n");'],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        recoveryIntervalMs: 25,
        recoveryPlatform: "win32",
        recoveryIdentity: identity,
        pipeProbeResultsByToken: {
          [deadPipeToken]: Array.from({ length: 10 }, () => "ENOENT" as const),
          [busyPipeToken]: ["busy"],
        },
      },
    });
    expect(await waitForExit(observer)).toBe(0);
    await observer.writerExit;
    expect(existsSync(deadSegment)).toBe(false);
    expect(
      familyFiles(logDir, "server").some(
        (file) =>
          file.includes(".backup-") &&
          readFileSync(file, "utf8").includes("dead Windows writer output"),
      ),
    ).toBe(true);
    expect(existsSync(busySegment)).toBe(true);
    expect(readFileSync(busySegment, "utf8")).toContain(
      "live busy Windows writer output",
    );
  });

  it("does not reclaim a Windows pipe segment after only one ENOENT", async () => {
    const logDir = scratchDir();
    const identity = {
      source: 2 as const,
      fingerprint: "2222222222222222",
    };
    const ownerToken = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const pipeToken = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const segment = join(
      logDir,
      `server-stdio.log.active-${process.pid}-${identity.source}-${identity.fingerprint}-e-${ownerToken}-p-${pipeToken}`,
    );
    writeFileSync(segment, "single ENOENT Windows writer output\\n");
    const observer = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("single ENOENT observer\\n");'],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        recoveryIntervalMs: 25,
        recoveryPlatform: "win32",
        recoveryIdentity: identity,
        pipeProbeResultsByToken: { [pipeToken]: ["ENOENT", "busy"] },
      },
    });
    expect(await waitForExit(observer)).toBe(0);
    await observer.writerExit;
    expect(existsSync(segment)).toBe(true);
    expect(readFileSync(segment, "utf8")).toContain(
      "single ENOENT Windows writer output",
    );
  });

  it("reclaims a dead endpoint segment when its pid and fingerprint match a live replacement process", async () => {
    if (process.platform === "win32") return;
    const logDir = scratchDir();
    const identity = currentProcessIdentity();
    const liveStopPath = join(logDir, "stop-same-identity-writer");
    const dead = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("dead same-identity output\\n"); setInterval(() => {}, 1000);',
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: { ownerIdentity: identity },
    });
    let live: ReturnType<typeof spawnLoggedProcess> | undefined;
    let observer: ReturnType<typeof spawnLoggedProcess> | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (file) =>
                file.includes(".active-") &&
                readFileSync(file, "utf8").includes(
                  "dead same-identity output",
                ),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const deadSegment = familyFiles(logDir, "server").find(
        (file) =>
          file.includes(".active-") &&
          readFileSync(file, "utf8").includes("dead same-identity output"),
      )!;
      expect(deadSegment).toContain(
        `.active-${identity.pid}-${identity.source}-${identity.fingerprint}-`,
      );
      const deadToken = socketTokenFromActivePath(deadSegment);
      const deadSocket = join(
        livenessDirectory(logDir, "server"),
        `s-${deadToken}`,
      );
      const recordedSocket = lstatSync(deadSocket);
      expect(recordedSocket.isSocket()).toBe(true);
      expect(deadSegment).toContain(
        `-i-${recordedSocket.dev}-${recordedSocket.ino}`,
      );
      const deadWriterPid = dead.writerProcess.pid!;
      dead.writerProcess.kill("SIGKILL");
      await dead.writerExit;
      expect(await socketResponds(deadSocket)).toBe(false);
      expect(identity.pid).toBe(process.pid);
      expect(() => process.kill(identity.pid, 0)).not.toThrow();
      expect(currentProcessIdentity()).toEqual(identity);
      await expect
        .poll(
          () => {
            try {
              process.kill(deadWriterPid, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);

      const liveWriterStartedAt = Date.now();
      live = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("node:fs"); process.stdout.write("live same-identity output\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(liveStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: {
          ownerIdentity: identity,
          recoveryIntervalMs: 25,
        },
      });
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (file) =>
                file.includes(".active-") &&
                readFileSync(file, "utf8").includes(
                  "live same-identity output",
                ),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      expect(Date.now() - liveWriterStartedAt).toBeGreaterThanOrEqual(1_500);
      const liveSegment = familyFiles(logDir, "server").find(
        (file) =>
          file.includes(".active-") &&
          readFileSync(file, "utf8").includes("live same-identity output"),
      )!;
      observer = spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("socket observer\\n");'],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: { recoveryIntervalMs: 25 },
      });
      expect(await waitForExit(observer)).toBe(0);
      await observer.writerExit;
      expect(existsSync(deadSegment)).toBe(false);
      expect(
        familyFiles(logDir, "server").some(
          (file) =>
            file.includes(".backup-") &&
            readFileSync(file, "utf8").includes("dead same-identity output"),
        ),
      ).toBe(true);
      expect(existsSync(liveSegment)).toBe(true);
      const liveToken = socketTokenFromActivePath(liveSegment);
      const liveSocket = join(
        livenessDirectory(logDir, "server"),
        `s-${liveToken}`,
      );
      expect(lstatSync(liveSocket).isSocket()).toBe(true);
      expect(await socketResponds(liveSocket)).toBe(true);
      expect(readFileSync(liveSegment, "utf8")).toContain(
        "live same-identity output",
      );
    } finally {
      if (live !== undefined && live.exitCode === null) {
        writeFileSync(liveStopPath, "stop");
        await waitForExit(live);
        await live.writerExit;
      }
      if (observer !== undefined && observer.exitCode === null) {
        observer.kill("SIGKILL");
      }
      if (dead.exitCode === null) {
        dead.kill("SIGKILL");
        await waitForExit(dead);
      }
    }
  });

  it("keeps a live endpoint under connection load when its process fingerprint differs", async () => {
    const logDir = scratchDir();
    const identity = currentProcessIdentity();
    const differentFingerprint =
      identity.fingerprint === "0000000000000000"
        ? "ffffffffffffffff"
        : "0000000000000000";
    const ownerIdentity = { ...identity, fingerprint: differentFingerprint };
    const ownerStopPath = join(logDir, "stop-busy-endpoint-owner");
    const owner = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs"); process.stdout.write("busy endpoint owner output\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(ownerStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: { ownerIdentity, recoveryIntervalMs: 25 },
    });
    let observer: ReturnType<typeof spawnLoggedProcess> | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (file) =>
                file.includes(".active-") &&
                readFileSync(file, "utf8").includes(
                  "busy endpoint owner output",
                ),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const ownerSegment = familyFiles(logDir, "server").find(
        (file) =>
          file.includes(".active-") &&
          readFileSync(file, "utf8").includes("busy endpoint owner output"),
      )!;
      const ownerToken = socketTokenFromActivePath(ownerSegment);
      const ownerSocket = join(
        livenessDirectory(logDir, "server"),
        `s-${ownerToken}`,
      );
      observer = spawnLoggedProcess({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("busy endpoint observer\\n");'],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: { recoveryIntervalMs: 25 },
      });
      let successfulConnections = 0;
      for (let batch = 0; batch < 20; batch += 1) {
        const results = await Promise.all(
          Array.from({ length: 32 }, () => socketResponds(ownerSocket)),
        );
        successfulConnections += results.filter(Boolean).length;
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 100),
        );
      }
      expect(successfulConnections).toBeGreaterThan(0);
      expect(existsSync(ownerSegment)).toBe(true);
      expect(readFileSync(ownerSegment, "utf8")).toContain(
        "busy endpoint owner output",
      );
    } finally {
      if (observer !== undefined && observer.exitCode === null)
        observer.kill("SIGKILL");
      if (owner.exitCode === null) {
        writeFileSync(ownerStopPath, "stop");
        await waitForExit(owner);
        await owner.writerExit;
      }
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "keeps a live writer with a full listen backlog despite repeated connection refusals",
    async () => {
      const logDir = scratchDir();
      const ownerStopPath = join(logDir, "stop-full-backlog-owner");
      const owner = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("node:fs"); process.stdout.write("full backlog owner output\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(ownerStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: { recoveryIntervalMs: 25 },
      });
      let observer: ReturnType<typeof spawnLoggedProcess> | undefined;
      const heldConnections: ReturnType<typeof createConnection>[] = [];
      try {
        await expect
          .poll(
            () =>
              familyFiles(logDir, "server").some(
                (file) =>
                  file.includes(".active-") &&
                  readFileSync(file, "utf8").includes(
                    "full backlog owner output",
                  ),
              ),
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true);
        const ownerSegment = familyFiles(logDir, "server").find(
          (file) =>
            file.includes(".active-") &&
            readFileSync(file, "utf8").includes("full backlog owner output"),
        )!;
        const ownerSocket = join(
          livenessDirectory(logDir, "server"),
          `s-${socketTokenFromActivePath(ownerSegment)}`,
        );
        owner.writerProcess.kill("SIGSTOP");
        let refusedConnections = 0;
        const connectionResults = await Promise.all(
          Array.from(
            { length: 240 },
            () =>
              new Promise<boolean>((resolvePromise) => {
                const socket = createConnection(ownerSocket);
                let settled = false;
                const finish = (connected: boolean) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  if (connected) heldConnections.push(socket);
                  else socket.destroy();
                  resolvePromise(connected);
                };
                const timer = setTimeout(() => finish(false), 1_500);
                socket.once("connect", () => finish(true));
                socket.once("error", (error) => {
                  if (
                    (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
                  ) {
                    refusedConnections += 1;
                  }
                  finish(false);
                });
              }),
          ),
        );
        expect(connectionResults.some(Boolean)).toBe(true);
        expect(refusedConnections).toBeGreaterThan(0);
        observer = spawnLoggedProcess({
          command: process.execPath,
          args: ["-e", 'process.stdout.write("full backlog observer\\n");'],
          env: process.env,
          logDir,
          logName: "server",
          testWriterBarrier: { recoveryIntervalMs: 25 },
        });
        expect(await waitForExit(observer)).toBe(0);
        await observer.writerExit;
        expect(existsSync(ownerSegment)).toBe(true);
        expect(readFileSync(ownerSegment, "utf8")).toContain(
          "full backlog owner output",
        );
      } finally {
        for (const socket of heldConnections) socket.destroy();
        if (observer !== undefined && observer.exitCode === null)
          observer.kill("SIGKILL");
        if (owner.exitCode === null) {
          owner.writerProcess.kill("SIGCONT");
          writeFileSync(ownerStopPath, "stop");
          await waitForExit(owner);
          await owner.writerExit;
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reclaims an endpoint-dead segment when its recorded process identity mismatches",
    async () => {
      const logDir = scratchDir();
      const identity = currentProcessIdentity();
      const token = "deadbeef-dead-beef-dead-beefdeadbeef";
      const deadFingerprint =
        identity.fingerprint === "0000000000000000"
          ? "ffffffffffffffff"
          : "0000000000000000";
      const deadSegment = join(
        logDir,
        `server-stdio.log.active-${identity.pid}-${identity.source}-${deadFingerprint}-e-${token}`,
      );
      writeFileSync(deadSegment, "endpoint-dead-identity-mismatch\n");
      const stopPath = join(logDir, "stop-endpoint-dead-observer");
      const observer = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("node:fs"); process.stdout.write("endpoint-dead-observer-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: { recoveryIntervalMs: 25 },
      });
      try {
        await expect
          .poll(() => !existsSync(deadSegment), {
            timeout: 3_000,
            interval: 10,
          })
          .toBe(true);
        expect(
          familyFiles(logDir, "server").some(
            (file) =>
              file.includes(".backup-") &&
              readFileSync(file, "utf8").includes(
                "endpoint-dead-identity-mismatch",
              ),
          ),
        ).toBe(true);
        writeFileSync(stopPath, "stop");
        expect(await waitForExit(observer)).toBe(0);
        await observer.writerExit;
      } finally {
        if (observer.exitCode === null) observer.kill("SIGKILL");
      }
    },
  );

  it("keeps live segments when writers use different locale environments", async () => {
    const logDir = scratchDir();
    const socketDir = livenessDirectory(logDir, "server");
    mkdirSync(socketDir, { mode: 0o755 });
    scratchDirs.push(socketDir);
    chmodSync(socketDir, 0o755);
    const firstStopPath = join(logDir, "stop-locale-writer-one");
    const secondStopPath = join(logDir, "stop-locale-writer-two");
    const firstCompletionPath = join(logDir, "locale-writer-one-finished");
    const secondCompletionPath = join(logDir, "locale-writer-two-finished");
    const makeArgs = (label: string, stopPath: string) => [
      "-e",
      `const fs = require("node:fs"); process.stdout.write(${JSON.stringify(label)}); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
    ];
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: makeArgs("locale-writer-one", firstStopPath),
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      logDir,
      logName: "server",
      testWriterBarrier: {
        completionPath: firstCompletionPath,
        forcePsIdentity: true,
        recoveryIntervalMs: 60_000,
        writerEnv: { LC_ALL: "C", TZ: "UTC" },
      },
    });
    let second: ChildProcess | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (path) =>
                path.includes(".active-") &&
                readFileSync(path, "utf8").includes("locale-writer-one"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const firstActivePath = familyFiles(logDir, "server").find(
        (path) =>
          path.includes(".active-") &&
          readFileSync(path, "utf8").includes("locale-writer-one"),
      )!;
      second = spawnLoggedProcess({
        command: process.execPath,
        args: makeArgs("locale-writer-two", secondStopPath),
        env: { ...process.env, LC_ALL: "C.utf8", TZ: "Pacific/Honolulu" },
        logDir,
        logName: "server",
        testWriterBarrier: {
          completionPath: secondCompletionPath,
          forcePsIdentity: true,
          recoveryIntervalMs: 60_000,
          writerEnv: { LC_ALL: "C.utf8", TZ: "Pacific/Honolulu" },
        },
      });
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (path) =>
                path.includes(".active-") &&
                path !== firstActivePath &&
                readFileSync(path, "utf8").includes("locale-writer-two"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const secondActivePath = familyFiles(logDir, "server").find(
        (path) => path.includes(".active-") && path !== firstActivePath,
      )!;
      expect(existsSync(firstActivePath)).toBe(true);
      expect(existsSync(secondActivePath)).toBe(true);
      expect(
        readFileSync(firstActivePath, "utf8").includes("locale-writer-one"),
      ).toBe(true);
      expect(
        readFileSync(secondActivePath, "utf8").includes("locale-writer-two"),
      ).toBe(true);
      writeFileSync(firstStopPath, "stop");
      writeFileSync(secondStopPath, "stop");
      expect(await waitForExit(first)).toBe(0);
      expect(await waitForExit(second)).toBe(0);
      await expect
        .poll(
          () =>
            existsSync(firstCompletionPath) && existsSync(secondCompletionPath),
          { timeout: 3_000, interval: 10 },
        )
        .toBe(true);
      const output = uniqueFamilyFiles(logDir, "server")
        .map((path) => readFileSync(path, "utf8"))
        .join("");
      expect(output).toContain("locale-writer-one");
      expect(output).toContain("locale-writer-two");
    } finally {
      if (!existsSync(firstStopPath)) writeFileSync(firstStopPath, "stop");
      if (!existsSync(secondStopPath)) writeFileSync(secondStopPath, "stop");
      if (first.exitCode === null) first.kill("SIGKILL");
      if (second?.exitCode === null) second.kill("SIGKILL");
    }
  });

  it("probes live writer endpoints across different temporary directories", async () => {
    const logDir = scratchDir();
    const firstTempDir = mkdtempSync(join("/tmp", "bb-a-"));
    const secondTempDir = mkdtempSync(join("/tmp", "bb-b-"));
    scratchDirs.push(firstTempDir, secondTempDir);
    const firstStopPath = join(logDir, "stop-tmpdir-writer-one");
    const secondStopPath = join(logDir, "stop-tmpdir-writer-two");
    const makeArgs = (label: string, stopPath: string) => [
      "-e",
      `const fs = require("node:fs"); let count = 0; const timer = setInterval(() => { process.stdout.write(${JSON.stringify(label)} + (++count) + "\\n"); if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
    ];
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: makeArgs("tmpdir-writer-one-", firstStopPath),
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        recoveryIntervalMs: 60_000,
        writerEnv: { TMPDIR: firstTempDir },
      },
    });
    let second: ReturnType<typeof spawnLoggedProcess> | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").find(
              (file) =>
                file.includes(".active-") &&
                readFileSync(file, "utf8").includes("tmpdir-writer-one-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBeDefined();
      const firstActivePath = familyFiles(logDir, "server").find(
        (file) =>
          file.includes(".active-") &&
          readFileSync(file, "utf8").includes("tmpdir-writer-one-"),
      )!;
      expect(firstActivePath).toContain("-e-");
      const firstSocketDir = livenessDirectory(logDir, "server");
      const firstToken = socketTokenFromActivePath(firstActivePath);
      expect(readdirSync(firstSocketDir)).toContain(`s-${firstToken}`);
      second = spawnLoggedProcess({
        command: process.execPath,
        args: makeArgs("tmpdir-writer-two-", secondStopPath),
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: {
          recoveryIntervalMs: 25,
          writerEnv: { TMPDIR: secondTempDir },
        },
      });
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (file) =>
                file.includes(".active-") &&
                readFileSync(file, "utf8").includes("tmpdir-writer-two-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const secondActivePath = familyFiles(logDir, "server").find(
        (file) =>
          file.includes(".active-") &&
          readFileSync(file, "utf8").includes("tmpdir-writer-two-"),
      )!;
      const secondSocketDir = livenessDirectory(logDir, "server");
      expect(secondSocketDir).toBe(firstSocketDir);
      const secondToken = socketTokenFromActivePath(secondActivePath);
      expect(readdirSync(secondSocketDir)).toContain(`s-${secondToken}`);
      await expect
        .poll(
          () =>
            existsSync(firstActivePath) &&
            (readFileSync(firstActivePath, "utf8").match(/tmpdir-writer-one-/gu)
              ?.length ?? 0) >= 10,
          { timeout: 3_000, interval: 10 },
        )
        .toBe(true);
      expect(existsSync(firstActivePath)).toBe(true);

      first.writerProcess.kill("SIGSTOP");
      first.kill("SIGKILL");
      first.writerProcess.kill("SIGKILL");
      await first.writerExit;
      await expect
        .poll(
          () =>
            !existsSync(firstActivePath) &&
            familyFiles(logDir, "server").some(
              (file) =>
                file.includes(".backup-") &&
                readFileSync(file, "utf8").includes("tmpdir-writer-one-"),
            ),
          { timeout: 3_000, interval: 10 },
        )
        .toBe(true);
      writeFileSync(secondStopPath, "stop");
      expect(await waitForExit(second)).toBe(0);
      await second.writerExit;
      expect(
        uniqueFamilyFiles(logDir, "server")
          .map((file) => readFileSync(file, "utf8"))
          .join(""),
      ).toContain("tmpdir-writer-one-");
    } finally {
      if (first.exitCode === null) first.kill("SIGKILL");
      if (first.writerProcess.exitCode === null) {
        first.writerProcess.kill("SIGKILL");
        await first.writerExit;
      }
      if (second !== undefined && second.exitCode === null) {
        writeFileSync(secondStopPath, "stop");
        await waitForExit(second);
      }
      if (second !== undefined) await second.writerExit;
    }
  });

  it("does not reclaim a matching live owner when its endpoint probe is unknown", async () => {
    const logDir = scratchDir();
    const ownerStopPath = join(logDir, "stop-unknown-endpoint-owner");
    const observerStopPath = join(logDir, "stop-unknown-endpoint-observer");
    const ownerCompletionPath = join(logDir, "unknown-endpoint-owner-finished");
    const observerCompletionPath = join(
      logDir,
      "unknown-endpoint-observer-finished",
    );
    const owner = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs"); process.stdout.write("unknown-endpoint-owner-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(ownerStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        completionPath: ownerCompletionPath,
        recoveryIntervalMs: 10_000,
      },
    });
    let observer: ReturnType<typeof spawnLoggedProcess> | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (path) =>
                path.includes(".active-") &&
                readFileSync(path, "utf8").includes(
                  "unknown-endpoint-owner-started",
                ),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const ownerSegment = familyFiles(logDir, "server").find(
        (path) =>
          path.includes(".active-") &&
          readFileSync(path, "utf8").includes("unknown-endpoint-owner-started"),
      );
      expect(ownerSegment).toBeDefined();
      expect(ownerSegment).toContain("-e-");
      const ownerToken = socketTokenFromActivePath(ownerSegment!);
      utimesSync(ownerSegment!, new Date(0), new Date(0));
      observer = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("node:fs"); process.stdout.write("unknown-endpoint-observer-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(observerStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: {
          completionPath: observerCompletionPath,
          recoveryIntervalMs: 25,
          unreadableOwnerSocketTokens: [ownerToken],
        },
      });
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (path) =>
                path.includes(".active-") &&
                readFileSync(path, "utf8").includes(
                  "unknown-endpoint-observer-started",
                ),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 700),
      );
      expect(existsSync(ownerSegment!)).toBe(true);
      expect(readFileSync(ownerSegment!, "utf8")).toContain(
        "unknown-endpoint-owner-started",
      );
      writeFileSync(observerStopPath, "stop");
      expect(await waitForExit(observer)).toBe(0);
      await observer.writerExit;
      writeFileSync(ownerStopPath, "stop");
      expect(await waitForExit(owner)).toBe(0);
      await expect
        .poll(() => existsSync(ownerCompletionPath), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
      await expect
        .poll(() => existsSync(observerCompletionPath), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
    } finally {
      if (observer !== undefined && observer.exitCode === null)
        observer.kill("SIGKILL");
      if (owner.exitCode === null) owner.kill("SIGKILL");
    }
  });

  it.skipIf(process.platform !== "linux")(
    "keeps a live source-1 owner when a source-2 observer cannot reach its endpoint",
    async () => {
      const logDir = scratchDir();
      const identity = currentProcessIdentity();
      expect(identity.source).toBe(1);
      const ownerStopPath = join(logDir, "stop-cross-source-owner");
      const observerStopPath = join(logDir, "stop-cross-source-observer");
      const owner = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("node:fs"); process.stdout.write("cross-source-owner-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(ownerStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: {
          ownerIdentity: identity,
          recoveryIntervalMs: 10_000,
        },
      });
      let observer: ReturnType<typeof spawnLoggedProcess> | undefined;
      try {
        await expect
          .poll(
            () =>
              familyFiles(logDir, "server").some(
                (file) =>
                  file.includes(".active-") &&
                  readFileSync(file, "utf8").includes(
                    "cross-source-owner-started",
                  ),
              ),
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true);
        const ownerSegment = familyFiles(logDir, "server").find(
          (file) =>
            file.includes(".active-") &&
            readFileSync(file, "utf8").includes("cross-source-owner-started"),
        );
        expect(ownerSegment).toBeDefined();
        expect(ownerSegment).toContain(`.active-${identity.pid}-1-`);
        const ownerToken = socketTokenFromActivePath(ownerSegment!);
        observer = spawnLoggedProcess({
          command: process.execPath,
          args: [
            "-e",
            `const fs = require("node:fs"); process.stdout.write("cross-source-observer-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(observerStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
          ],
          env: process.env,
          logDir,
          logName: "server",
          testWriterBarrier: {
            forcePsIdentity: true,
            recoveryIntervalMs: 25,
            unreadableOwnerSocketTokens: [ownerToken],
          },
        });
        await expect
          .poll(
            () =>
              familyFiles(logDir, "server").some(
                (file) =>
                  file.includes(".active-") &&
                  readFileSync(file, "utf8").includes(
                    "cross-source-observer-started",
                  ),
              ),
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true);
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 700),
        );
        expect(existsSync(ownerSegment!)).toBe(true);
        expect(readFileSync(ownerSegment!, "utf8")).toContain(
          "cross-source-owner-started",
        );
        writeFileSync(observerStopPath, "stop");
        expect(await waitForExit(observer)).toBe(0);
        await observer.writerExit;
        writeFileSync(ownerStopPath, "stop");
        expect(await waitForExit(owner)).toBe(0);
        await owner.writerExit;
      } finally {
        if (observer !== undefined && observer.exitCode === null) {
          observer.kill("SIGKILL");
          await waitForExit(observer);
        }
        if (
          observer !== undefined &&
          observer.writerProcess.exitCode === null
        ) {
          observer.writerProcess.kill("SIGKILL");
          await observer.writerExit;
        }
        if (owner.exitCode === null) {
          owner.kill("SIGKILL");
          await waitForExit(owner);
        }
        if (owner.writerProcess.exitCode === null) {
          owner.writerProcess.kill("SIGKILL");
          await owner.writerExit;
        }
      }
    },
  );

  it("reclaims a dead endpoint-backed owner when its probe is unknown", async () => {
    const logDir = scratchDir();
    const stopPath = join(logDir, "stop-dead-owner-observer");
    const completionPath = join(logDir, "dead-owner-observer-finished");
    const deadPid = 2_000_000_000;
    const identity = currentProcessIdentity();
    const token = "deadcafe-dead-cafe-dead-cafedeadcafe";
    const deadSegment = join(
      logDir,
      `server-stdio.log.active-${deadPid}-${identity.source}-${identity.fingerprint}-e-${token}`,
    );
    const observer = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs"); process.stdout.write("dead-owner-observer-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        completionPath,
        recoveryIntervalMs: 25,
        unreadableOwnerSocketTokens: [token],
      },
    });
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some((path) =>
              path.includes(".active-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      writeFileSync(deadSegment, "dead-owner-unavailable-endpoint\\n");
      await expect
        .poll(() => !existsSync(deadSegment), { timeout: 2_000, interval: 10 })
        .toBe(true);
      expect(
        familyFiles(logDir, "server").some(
          (path) =>
            path.includes(".backup-") &&
            readFileSync(path, "utf8").includes(
              "dead-owner-unavailable-endpoint\\n",
            ),
        ),
      ).toBe(true);
      writeFileSync(stopPath, "stop");
      expect(await waitForExit(observer)).toBe(0);
      await expect
        .poll(() => existsSync(completionPath), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
    } finally {
      if (observer.exitCode === null) observer.kill("SIGKILL");
    }
  });

  it("keeps a stale live owner when socket and identity checks are unavailable, then reclaims it after exit", async () => {
    const logDir = scratchDir();
    const observerStopPath = join(logDir, "stop-unreadable-identity-observer");
    const observerCompletionPath = join(
      logDir,
      "unreadable-identity-observer-finished",
    );
    const owner = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("unreadable-identity-owner-output\\n"); setInterval(() => {}, 1000);',
      ],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: {
        recoveryIntervalMs: 60_000,
      },
    });
    let observer: ReturnType<typeof spawnLoggedProcess> | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (file) =>
                file.includes(".active-") &&
                readFileSync(file, "utf8").includes(
                  "unreadable-identity-owner-output",
                ),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      const ownerSegment = familyFiles(logDir, "server").find(
        (file) =>
          file.includes(".active-") &&
          readFileSync(file, "utf8").includes(
            "unreadable-identity-owner-output",
          ),
      );
      expect(ownerSegment).toBeDefined();
      expect(ownerSegment).toContain("-e-");
      const ownerToken = socketTokenFromActivePath(ownerSegment!);
      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        observer = spawnLoggedProcess({
          command: process.execPath,
          args: [
            "-e",
            `const fs = require("node:fs"); process.stdout.write("unreadable-identity-observer-output\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(observerStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
          ],
          env: process.env,
          logDir,
          logName: "server",
          testWriterBarrier: {
            completionPath: observerCompletionPath,
            forcePsIdentity: true,
            recoveryIntervalMs: 25,
            unreadableOwnerSocketTokens: [ownerToken],
          },
        });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").some(
              (file) =>
                file.includes(".active-") &&
                readFileSync(file, "utf8").includes(
                  "unreadable-identity-observer-output",
                ),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      expect(existsSync(ownerSegment!)).toBe(true);
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 500),
      );
      expect(existsSync(ownerSegment!)).toBe(true);
      const staleTime = new Date(Date.now() - 11 * 60 * 1000);
      utimesSync(ownerSegment!, staleTime, staleTime);
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 500),
      );
      expect(existsSync(ownerSegment!)).toBe(true);
      expect(
        familyFiles(logDir, "server").some(
          (file) =>
            file.includes(".backup-") &&
            readFileSync(file, "utf8").includes(
              "unreadable-identity-owner-output",
            ),
        ),
      ).toBe(false);
      owner.writerProcess.kill("SIGKILL");
      await owner.writerExit;
      owner.kill("SIGKILL");
      await waitForExit(owner);
      await expect
        .poll(() => !existsSync(ownerSegment!), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
      expect(
        familyFiles(logDir, "server").some(
          (file) =>
            file.includes(".backup-") &&
            readFileSync(file, "utf8").includes(
              "unreadable-identity-owner-output",
            ),
        ),
      ).toBe(true);
      writeFileSync(observerStopPath, "stop");
      expect(await waitForExit(observer)).toBe(0);
      await observer.writerExit;
      expect(existsSync(observerCompletionPath)).toBe(true);
    } finally {
      if (observer !== undefined && observer.exitCode === null)
        observer.kill("SIGKILL");
      if (owner.exitCode === null) owner.kill("SIGKILL");
      if (owner.writerProcess.exitCode === null) {
        owner.writerProcess.kill("SIGKILL");
        await owner.writerExit;
      }
    }
  });

  it.skipIf(process.platform === "win32")(
    "recreates a removed liveness socket without recovering the live writer segment",
    async () => {
      const logDir = scratchDir();
      const ownerStopPath = join(logDir, "stop-socket-recreate-owner");
      const observerStopPath = join(logDir, "stop-socket-recreate-observer");
      const renameFailurePath = join(logDir, "fail-active-rename-once");
      const renamePreloadPath = join(logDir, "fail-active-rename-once.cjs");
      const diagnosticPath = join(logDir, "writer-diagnostics.log");
      writeFileSync(
        renamePreloadPath,
        `const fs = require("node:fs");
const rename = fs.renameSync;
fs.renameSync = function (source, destination) {
  if (fs.existsSync(${JSON.stringify(renameFailurePath)}) && String(source).includes(".active-") && String(destination).includes("-i-")) {
    fs.unlinkSync(${JSON.stringify(renameFailurePath)});
    const error = new Error("injected active rename failure");
    error.code = "EBUSY";
    throw error;
  }
  return rename.call(this, source, destination);
};
`,
      );
      const owner = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(ownerStopPath)})) { clearInterval(timer); process.stdout.write("socket-restored-output\\n"); setTimeout(() => process.exit(0), 50); } else { process.stdout.write("socket-owner-heartbeat\\n"); } }, 20);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: {
          ownerIdentity: currentProcessIdentity(),
          recoveryIntervalMs: 25,
          writerEnv: { NODE_OPTIONS: `--require=${renamePreloadPath}` },
          diagnosticPath,
        },
      });
      let observer: ReturnType<typeof spawnLoggedProcess> | undefined;
      try {
        await expect
          .poll(
            () =>
              familyFiles(logDir, "server").some(
                (file) =>
                  file.includes(".active-") &&
                  fileIncludes(file, "socket-owner-heartbeat"),
              ),
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true);
        let ownerSegment = familyFiles(logDir, "server").find(
          (file) =>
            file.includes(".active-") &&
            readFileSync(file, "utf8").includes("socket-owner-heartbeat"),
        )!;
        const ownerToken = socketTokenFromActivePath(ownerSegment);
        const ownerSocket = join(
          livenessDirectory(logDir, "server"),
          `s-${ownerToken}`,
        );
        const initialSocketIdentity = lstatSync(ownerSocket);
        expect(initialSocketIdentity.isSocket()).toBe(true);
        expect(ownerSegment).toContain(
          `-i-${initialSocketIdentity.dev}-${initialSocketIdentity.ino}`,
        );
        observer = spawnLoggedProcess({
          command: process.execPath,
          args: [
            "-e",
            `const fs = require("node:fs"); process.stdout.write("socket-observer-started\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(observerStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
          ],
          env: process.env,
          logDir,
          logName: "server",
          testWriterBarrier: { recoveryIntervalMs: 25 },
        });
        await expect
          .poll(
            () =>
              familyFiles(logDir, "server").some(
                (file) =>
                  file.includes(".active-") &&
                  readFileSync(file, "utf8").includes(
                    "socket-observer-started",
                  ),
              ),
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true);
        owner.writerProcess.kill("SIGSTOP");
        unlinkSync(ownerSocket);
        const staleTime = new Date(0);
        utimesSync(ownerSegment, staleTime, staleTime);
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 1_800),
        );
        expect(existsSync(ownerSegment)).toBe(true);
        writeFileSync(renameFailurePath, "fail once");
        owner.writerProcess.kill("SIGCONT");
        const rebindStartedAt = Date.now();
        const initialSegment = ownerSegment;
        let recreatedSocketIdentity: ReturnType<typeof lstatSync> | undefined;
        let recreatedOwnerSegment: string | undefined;
        await expect
          .poll(
            () => {
              const observedAt = Date.now();
              const timestamp = new Date(observedAt).toISOString();
              let socketRecord:
                | { dev: number; ino: number; mtimeMs: number; isSocket: boolean }
                | undefined;
              try {
                const stat = lstatSync(ownerSocket);
                socketRecord = {
                  dev: stat.dev,
                  ino: stat.ino,
                  mtimeMs: stat.mtimeMs,
                  isSocket: stat.isSocket(),
                };
              } catch {}
              const activeRecords = familyFiles(logDir, "server")
                .filter((file) => file.includes(".active-") && fileIncludes(file, "socket-owner-heartbeat"))
                .map((file) => {
                  try {
                    const stat = statSync(file);
                    return { name: basename(file), mtimeMs: stat.mtimeMs };
                  } catch {
                    return { name: basename(file), mtimeMs: undefined };
                  }
                });
              try {
                const identity = lstatSync(ownerSocket);
                if (!identity.isSocket()) {
                  console.error(
                    "liveness-rebind-poll",
                    JSON.stringify({ timestamp, elapsedMs: observedAt - rebindStartedAt, socket: socketRecord, active: activeRecords, matched: false }),
                  );
                  return false;
                }
                const expectedMarker = `-i-${identity.dev}-${identity.ino}`;
                const segment = familyFiles(logDir, "server").find(
                  (file) =>
                    file.includes(".active-") &&
                    file !== initialSegment &&
                    file.includes(expectedMarker) &&
                    fileIncludes(file, "socket-owner-heartbeat"),
                );
                console.error(
                  "liveness-rebind-poll",
                  JSON.stringify({ timestamp, elapsedMs: observedAt - rebindStartedAt, socket: socketRecord, active: activeRecords, matched: segment !== undefined }),
                );
                if (segment === undefined) return false;
                recreatedSocketIdentity = identity;
                recreatedOwnerSegment = segment;
                return true;
              } catch {
                console.error(
                  "liveness-rebind-poll",
                  JSON.stringify({ timestamp, elapsedMs: observedAt - rebindStartedAt, socket: socketRecord, active: activeRecords, matched: false }),
                );
                return false;
              }
            },
            { timeout: 3_000, interval: 10 },
          )
          .toBe(true);
        expect(readFileSync(diagnosticPath, "utf8")).toContain(
          "stdio active segment socket identity update failed: EBUSY",
        );
        ownerSegment = recreatedOwnerSegment!;
        expect(ownerSegment).not.toBe(initialSegment);
        expect(recreatedSocketIdentity).toBeDefined();
        expect(ownerSegment).toContain(
          `-i-${recreatedSocketIdentity!.dev}-${recreatedSocketIdentity!.ino}`,
        );
        expect(existsSync(ownerSegment)).toBe(true);
        expect(readFileSync(ownerSegment, "utf8")).toContain(
          "socket-owner-heartbeat",
        );
        owner.writerProcess.kill("SIGSTOP");
        unlinkSync(ownerSocket);
        writeFileSync(ownerSocket, "replacement path must not prove death");
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 1_800),
        );
        expect(existsSync(ownerSegment)).toBe(true);
        expect(readFileSync(ownerSegment, "utf8")).toContain(
          "socket-owner-heartbeat",
        );
        unlinkSync(ownerSocket);
        owner.writerProcess.kill("SIGCONT");
        let replacementSocketIdentity: ReturnType<typeof lstatSync> | undefined;
        let replacementOwnerSegment: string | undefined;
        await expect
          .poll(
            () => {
              try {
                const identity = lstatSync(ownerSocket);
                if (!identity.isSocket()) return false;
                const expectedMarker = `-i-${identity.dev}-${identity.ino}`;
                const segment = familyFiles(logDir, "server").find(
                  (file) =>
                    file.includes(".active-") &&
                    file.includes(expectedMarker) &&
                    fileIncludes(file, "socket-owner-heartbeat"),
                );
                if (segment === undefined) return false;
                replacementSocketIdentity = identity;
                replacementOwnerSegment = segment;
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 3_000, interval: 10 },
          )
          .toBe(true);
        ownerSegment = replacementOwnerSegment!;
        expect(replacementSocketIdentity).toBeDefined();
        expect(existsSync(ownerSegment)).toBe(true);
        writeFileSync(ownerStopPath, "stop");
        expect(await waitForExit(owner)).toBe(0);
        await owner.writerExit;
        expect(
          uniqueFamilyFiles(logDir, "server")
            .map((file) => readFileSync(file, "utf8"))
            .join(""),
        ).toContain("socket-restored-output");
        writeFileSync(observerStopPath, "stop");
        expect(await waitForExit(observer)).toBe(0);
        await observer.writerExit;
      } finally {
        if (observer !== undefined && observer.exitCode === null) {
          observer.kill("SIGKILL");
        }
        if (owner.exitCode === null) owner.kill("SIGKILL");
        if (owner.writerProcess.exitCode === null) {
          owner.writerProcess.kill("SIGKILL");
          await owner.writerExit;
        }
      }
    },
  );

  it("recovers a dead writer segment on a timer while a survivor stays below the rotation limit", async () => {
    const logDir = scratchDir();
    const deadStopPath = join(logDir, "stop-dead-child");
    const survivorContinuePath = join(logDir, "continue-survivor");
    const survivorStopPath = join(logDir, "stop-survivor");
    const completionPath = join(logDir, "survivor-writer-finished");
    const first = spawnLoggedProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs"); process.stdout.write("dead-segment-output\\n"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(deadStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
      ],
      env: process.env,
      logDir,
      logName: "server",
    });
    let survivor: ChildProcess | undefined;
    let writerPid: number | undefined;
    let firstSegment: string | undefined;
    let survivorSegment: string | undefined;
    try {
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").find((path) =>
              path.includes(".active-"),
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBeDefined();
      firstSegment = familyFiles(logDir, "server").find((path) =>
        path.includes(".active-"),
      );
      expect(firstSegment).toBeDefined();
      writerPid = Number(firstSegment!.match(/\.active-(\d+)-/)?.[1]);
      expect(Number.isInteger(writerPid)).toBe(true);
      await expect
        .poll(
          () =>
            readFileSync(firstSegment!, "utf8").includes(
              "dead-segment-output\n",
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      survivor = spawnLoggedProcess({
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("node:fs"); let continued = false; process.stdout.write("survivor-started\\n"); const timer = setInterval(() => { if (!continued && fs.existsSync(${JSON.stringify(survivorContinuePath)})) { continued = true; process.stdout.write("survivor-after-recovery\\n"); } if (fs.existsSync(${JSON.stringify(survivorStopPath)})) { clearInterval(timer); process.exit(0); } }, 10);`,
        ],
        env: process.env,
        logDir,
        logName: "server",
        testWriterBarrier: { recoveryIntervalMs: 25, completionPath },
      });
      await expect
        .poll(
          () =>
            familyFiles(logDir, "server").find(
              (path) => path.includes(".active-") && path !== firstSegment,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBeDefined();
      survivorSegment = familyFiles(logDir, "server").find(
        (path) => path.includes(".active-") && path !== firstSegment,
      );
      expect(survivorSegment).toBeDefined();
      expect(statSync(survivorSegment!).size).toBeLessThan(10 * 1024 * 1024);

      process.kill(writerPid!, "SIGKILL");
      await expect
        .poll(
          () => {
            try {
              process.kill(writerPid!, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      await expect
        .poll(() => !existsSync(firstSegment!), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
      expect(existsSync(survivorSegment!)).toBe(true);
      expect(
        familyFiles(logDir, "server").some((path) => path.includes(".active-")),
      ).toBe(true);
      expect(statSync(survivorSegment!).size).toBeLessThan(10 * 1024 * 1024);
      expect(
        uniqueFamilyFiles(logDir, "server").some(
          (path) =>
            path !== survivorSegment &&
            readFileSync(path, "utf8").includes("dead-segment-output\n"),
        ),
      ).toBe(true);

      writeFileSync(survivorContinuePath, "continue");
      await expect
        .poll(
          () =>
            readFileSync(survivorSegment!, "utf8").includes(
              "survivor-after-recovery\n",
            ),
          { timeout: 3_000, interval: 10 },
        )
        .toBe(true);
      expect(existsSync(survivorSegment!)).toBe(true);
      expect(statSync(survivorSegment!).size).toBeLessThan(10 * 1024 * 1024);
      writeFileSync(survivorStopPath, "stop");
      expect(await waitForExit(survivor)).toBe(0);
      await expect
        .poll(() => existsSync(completionPath), {
          timeout: 3_000,
          interval: 10,
        })
        .toBe(true);
      writeFileSync(deadStopPath, "stop");
      expect(await waitForExit(first)).toBe(0);
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
      const output = Buffer.concat(files.map((path) => readFileSync(path)));
      expect(output.toString()).toContain("dead-segment-output\n");
      expect(output.toString()).toContain("survivor-started\n");
      expect(output.toString()).toContain("survivor-after-recovery\n");
    } finally {
      writeFileSync(deadStopPath, "stop");
      writeFileSync(survivorStopPath, "stop");
      if (writerPid !== undefined) {
        try {
          process.kill(writerPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (first.exitCode === null)
        await waitForExit(first).catch(() => undefined);
      if (survivor?.exitCode === null)
        await waitForExit(survivor).catch(() => undefined);
    }
  });

  it("rotates an oversized active log without discarding its contents", async () => {
    const logDir = scratchDir();
    const logPath = join(logDir, "server-stdio.log");
    const writerFinishedPath = join(logDir, "writer-finished");
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
      testWriterBarrier: { completionPath: writerFinishedPath },
    });

    expect(await waitForExit(child)).toBe(0);
    await expect
      .poll(() => existsSync(writerFinishedPath), { timeout: 5_000 })
      .toBe(true);
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
      let child!: ReturnType<typeof spawnLoggedProcess>;
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
      await child.writerExit;
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
    const writerFinishedPath = join(logDir, "writer-finished");
    const child = spawnLoggedProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(61 * 1024 * 1024));`],
      env: process.env,
      logDir,
      logName: "server",
      testWriterBarrier: { completionPath: writerFinishedPath },
    });

    expect(await waitForExit(child)).toBe(0);
    await expect
      .poll(() => existsSync(writerFinishedPath), { timeout: 5_000 })
      .toBe(true);
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

  it("resolves writer exit promptly when the log writer cannot spawn", async () => {
    const logDir = scratchDir();
    const originalExecPath = Object.getOwnPropertyDescriptor(
      process,
      "execPath",
    );
    if (originalExecPath === undefined) throw new Error("Missing execPath");
    let child: ReturnType<typeof spawnLoggedProcess>;
    Object.defineProperty(process, "execPath", {
      ...originalExecPath,
      value: join(logDir, "missing-node"),
    });
    try {
      child = spawnLoggedProcess({
        command: String(originalExecPath.value),
        args: ["-e", "process.exit(0)"],
        env: process.env,
        logDir,
        logName: "server",
      });
    } finally {
      Object.defineProperty(process, "execPath", originalExecPath);
    }
    expect(child.writerProcess.pid).toBeUndefined();
    expect(await waitForExit(child)).toBe(0);
    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      child.writerExit.then(() => "exited" as const),
      new Promise<"timed-out">((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise("timed-out"), 500);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    expect(result).toBe("exited");
  });
});
