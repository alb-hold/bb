import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { ChildProcess } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BbAppStartContext,
  ManagedProcessRun,
  ManagedFullStackProcesses,
} from "../src/launcher.js";
import {
  startFullStackServerProcess,
  waitForServerHealth,
} from "../src/launcher.js";

interface ListeningServer {
  close(): Promise<void>;
  port: number;
}

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

async function listen(handler: RequestHandler): Promise<ListeningServer> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to have a TCP address");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function reserveFreePort(): Promise<number> {
  const server = await listen(() => {});
  await server.close();
  return server.port;
}

function answerHealth(response: ServerResponse, body: object): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const FAKE_SERVER_ENTRY_SOURCE = `
import { createServer } from "node:http";
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, launchId: process.env.BB_SERVER_LAUNCH_ID }));
});
server.on("error", () => process.exit(1));
setTimeout(() => {
  server.listen(Number(process.env.BB_SERVER_PORT), "127.0.0.1");
}, 300);
`;

const IMMEDIATE_SERVER_ENTRY_SOURCE = `
import { createServer } from "node:http";
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, launchId: process.env.BB_SERVER_LAUNCH_ID }));
});
server.on("error", () => process.exit(1));
server.listen(Number(process.env.BB_SERVER_PORT), "127.0.0.1");
`;

function createStartContext(args: {
  serverEntry: string;
  serverPort: number;
}): BbAppStartContext {
  const dataDir = dirname(args.serverEntry);
  return {
    appDistDir: `${dataDir}/app/dist`,
    appVersion: "0.0.0-test",
    configFile: `${dataDir}/config.json`,
    daemonBundleDir: `${dataDir}/host-daemon/dist`,
    daemonEntry: `${dataDir}/host-daemon/dist/daemon-bundle.mjs`,
    daemonLockDir: `${dataDir}/daemon.lock.lock`,
    daemonLockFile: `${dataDir}/daemon.lock`,
    daemonPort: args.serverPort + 1,
    dataDir,
    dbPath: `${dataDir}/bb.db`,
    envFile: `${dataDir}/env.json`,
    logDir: `${dataDir}/logs`,
    packageRoot: `${dataDir}/package`,
    serverEntry: args.serverEntry,
    serverPort: args.serverPort,
    serverUrl: `http://127.0.0.1:${args.serverPort}`,
  };
}

describe("waitForServerHealth", () => {
  it("keeps polling past foreign answers until the child echoes its launch id", async () => {
    let healthRequests = 0;
    const server = await listen((_request, response) => {
      healthRequests += 1;
      answerHealth(
        response,
        healthRequests < 3
          ? { ok: true }
          : { ok: true, launchId: "launch-expected" },
      );
    });

    try {
      await waitForServerHealth({
        childProcess: null,
        expectedLaunchId: "launch-expected",
        timeoutMs: 5_000,
        url: `http://127.0.0.1:${server.port}/health`,
      });
      expect(healthRequests).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("times out when the responder never echoes the launch id", async () => {
    const server = await listen((_request, response) => {
      answerHealth(response, { ok: true, launchId: "launch-other" });
    });

    try {
      await expect(
        waitForServerHealth({
          childProcess: null,
          expectedLaunchId: "launch-expected",
          timeoutMs: 250,
          url: `http://127.0.0.1:${server.port}/health`,
        }),
      ).rejects.toThrow(
        `Timed out waiting for health at http://127.0.0.1:${server.port}/health: another server is already answering`,
      );
    } finally {
      await server.close();
    }
  });
});

describe("startFullStackServerProcess", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function writeFakeServerEntry(): string {
    const dir = mkdtempSync(join(tmpdir(), "bb-app-health-"));
    scratchDirs.push(dir);
    const entry = join(dir, "fake-server.mjs");
    writeFileSync(entry, FAKE_SERVER_ENTRY_SOURCE);
    return entry;
  }

  function writeImmediateServerEntry(): string {
    const dir = mkdtempSync(join(tmpdir(), "bb-app-health-"));
    scratchDirs.push(dir);
    const entry = join(dir, "immediate-server.mjs");
    writeFileSync(entry, IMMEDIATE_SERVER_ENTRY_SOURCE);
    return entry;
  }

  it("hands the child a launch id and accepts its /health once it listens", async () => {
    const serverPort = await reserveFreePort();
    const context = createStartContext({
      serverEntry: writeFakeServerEntry(),
      serverPort,
    });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };

    const serverRun = await startFullStackServerProcess({
      context,
      env: {
        BB_SERVER_PORT: String(context.serverPort),
        PATH: process.env.PATH,
      },
      processes,
    });
    try {
      expect(processes.serverRun).toBe(serverRun);
      const health = await fetch(`${context.serverUrl}/health`).then(
        (response) => response.json(),
      );
      expect(health).toEqual({
        ok: true,
        launchId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      });
    } finally {
      await serverRun.terminate("SIGTERM");
    }
  });

  it("terminates promptly when the stdio writer fails to spawn", async () => {
    const serverPort = await reserveFreePort();
    const entry = writeImmediateServerEntry();
    const context = createStartContext({ serverEntry: entry, serverPort });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };
    const originalExecPath = Object.getOwnPropertyDescriptor(
      process,
      "execPath",
    );
    if (originalExecPath === undefined) throw new Error("Missing execPath");
    const realExecPath = String(originalExecPath.value);
    let execPathReads = 0;
    let spawnedChild: ChildProcess | undefined;
    const restoreExecPath = () =>
      Object.defineProperty(process, "execPath", originalExecPath);
    Object.defineProperty(process, "execPath", {
      configurable: true,
      enumerable: originalExecPath.enumerable,
      get: () => {
        execPathReads += 1;
        return execPathReads === 1
          ? realExecPath
          : join(dirname(entry), "missing-writer-runtime");
      },
    });
    const starting: Promise<ManagedProcessRun> = startFullStackServerProcess({
      context,
      env: {
        BB_SERVER_PORT: String(context.serverPort),
        PATH: process.env.PATH,
      },
      onSpawned: (child) => {
        spawnedChild = child;
        restoreExecPath();
      },
      processes,
    });
    const serverRun = await starting.finally(restoreExecPath);
    expect(execPathReads).toBe(2);
    expect(spawnedChild).toBeDefined();
    const writerProcess = (
      spawnedChild as ChildProcess & { writerProcess: ChildProcess }
    ).writerProcess;
    expect(writerProcess.pid).toBeUndefined();
    const startedAt = Date.now();
    const termination = serverRun.terminate("SIGTERM").then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      termination,
      new Promise<"timed-out">((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise("timed-out"), 700);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    expect(result).toBe("resolved");
    expect(Date.now() - startedAt).toBeLessThan(700);
    expect(writerProcess.pid).toBeUndefined();
  });

  it("waits for stdio log finalization before termination resolves", async () => {
    const serverPort = await reserveFreePort();
    const entry = writeImmediateServerEntry();
    const context = createStartContext({ serverEntry: entry, serverPort });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };
    const finalizationEnteredPath = join(dirname(entry), "writer-finalizing");
    const finalizationReleasePath = join(dirname(entry), "release-writer");
    const completionPath = join(dirname(entry), "writer-finished");
    const serverRun = await startFullStackServerProcess({
      context,
      env: {
        BB_SERVER_PORT: String(context.serverPort),
        PATH: process.env.PATH,
      },
      processes,
      testWriterBarrier: {
        completionPath,
        finalizationEnteredPath,
        finalizationReleasePath,
      },
    });
    let terminationResolved = false;
    const termination = serverRun.terminate("SIGTERM").then(() => {
      terminationResolved = true;
    });

    try {
      await vi.waitFor(() =>
        expect(existsSync(finalizationEnteredPath)).toBe(true),
      );
      expect(terminationResolved).toBe(false);
      writeFileSync(finalizationReleasePath, "release");
      await termination;
      expect(existsSync(completionPath)).toBe(true);
      expect(() =>
        rmSync(context.logDir, { force: true, recursive: true }),
      ).not.toThrow();
    } finally {
      if (!existsSync(finalizationReleasePath)) {
        writeFileSync(finalizationReleasePath, "release");
      }
      await termination;
      await vi.waitFor(() => expect(existsSync(completionPath)).toBe(true));
    }
  });

  it("bounds termination when the stdio log writer does not finish", async () => {
    const serverPort = await reserveFreePort();
    const entry = writeImmediateServerEntry();
    const context = createStartContext({ serverEntry: entry, serverPort });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };
    const finalizationEnteredPath = join(dirname(entry), "writer-finalizing");
    const finalizationReleasePath = join(dirname(entry), "release-writer");
    const completionPath = join(dirname(entry), "writer-finished");
    const serverRun = await startFullStackServerProcess({
      context,
      env: {
        BB_SERVER_PORT: String(context.serverPort),
        PATH: process.env.PATH,
      },
      processes,
      testWriterBarrier: {
        completionPath,
        finalizationEnteredPath,
        finalizationReleasePath,
      },
    });
    const startedAt = Date.now();
    const termination = serverRun.terminate("SIGTERM");
    let writerPid: number | undefined;
    let writerKill: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await vi.waitFor(() =>
        expect(existsSync(finalizationEnteredPath)).toBe(true),
      );
      writerPid = Number(readFileSync(finalizationEnteredPath, "utf8"));
      expect(writerPid).toBeGreaterThan(0);
      const realKill = ChildProcess.prototype.kill;
      writerKill = vi
        .spyOn(ChildProcess.prototype, "kill")
        .mockImplementation(function (
          this: ChildProcess,
          signal?: number | NodeJS.Signals,
        ) {
          if (this.pid === writerPid && signal === "SIGKILL") {
            setTimeout(() => {
              try {
                process.kill(writerPid!, "SIGKILL");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                  throw error;
              }
            }, 200);
            return true;
          }
          return realKill.call(this, signal);
        });
      await termination;
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
      expect(Date.now() - startedAt).toBeLessThan(4_500);
      expect(existsSync(completionPath)).toBe(false);
      let writerIsGone = false;
      try {
        process.kill(writerPid, 0);
      } catch (error) {
        writerIsGone = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      expect(writerIsGone).toBe(true);
      const snapshot = readdirSync(context.logDir)
        .sort()
        .map((name) => {
          const info = statSync(join(context.logDir, name));
          return [name, info.ino, info.size, info.mtimeMs];
        });
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 50);
      });
      expect(
        readdirSync(context.logDir)
          .sort()
          .map((name) => {
            const info = statSync(join(context.logDir, name));
            return [name, info.ino, info.size, info.mtimeMs];
          }),
      ).toEqual(snapshot);
      expect(() =>
        rmSync(context.logDir, { force: true, recursive: true }),
      ).not.toThrow();
    } finally {
      writerKill?.mockRestore();
      if (writerPid !== undefined && !existsSync(finalizationReleasePath)) {
        let writerIsAlive = true;
        try {
          process.kill(writerPid, 0);
        } catch (error) {
          writerIsAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (writerIsAlive) writeFileSync(finalizationReleasePath, "release");
      }
      await termination.catch(() => undefined);
      if (writerPid !== undefined) {
        await vi.waitFor(() => {
          let writerIsGone = false;
          try {
            process.kill(writerPid!, 0);
          } catch (error) {
            writerIsGone = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
          expect(writerIsGone).toBe(true);
        });
      }
    }
  });

  it("does not treat a stdio writer kill error as writer exit", async () => {
    const serverPort = await reserveFreePort();
    const entry = writeImmediateServerEntry();
    const context = createStartContext({ serverEntry: entry, serverPort });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };
    const finalizationEnteredPath = join(dirname(entry), "writer-finalizing");
    const finalizationReleasePath = join(dirname(entry), "release-writer");
    const completionPath = join(dirname(entry), "writer-finished");
    const serverRun = await startFullStackServerProcess({
      context,
      env: {
        BB_SERVER_PORT: String(context.serverPort),
        PATH: process.env.PATH,
      },
      processes,
      testWriterBarrier: {
        completionPath,
        finalizationEnteredPath,
        finalizationReleasePath,
      },
    });
    const termination = serverRun.terminate("SIGTERM");
    let writerPid: number | undefined;
    let writerKill: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await vi.waitFor(() =>
        expect(existsSync(finalizationEnteredPath)).toBe(true),
      );
      writerPid = Number(readFileSync(finalizationEnteredPath, "utf8"));
      expect(writerPid).toBeGreaterThan(0);
      const realKill = ChildProcess.prototype.kill;
      writerKill = vi
        .spyOn(ChildProcess.prototype, "kill")
        .mockImplementation(function (
          this: ChildProcess,
          signal?: number | NodeJS.Signals,
        ) {
          if (this.pid === writerPid && signal === "SIGKILL") {
            const error = Object.assign(
              new Error("simulated SIGKILL delivery failure"),
              { code: "EPERM" },
            );
            this.emit("error", error);
            return false;
          }
          return realKill.call(this, signal);
        });

      await expect(termination).rejects.toThrow(String(writerPid));
      expect(() => process.kill(writerPid!, 0)).not.toThrow();
    } finally {
      writerKill?.mockRestore();
      if (!existsSync(finalizationReleasePath)) {
        writeFileSync(finalizationReleasePath, "release");
      }
      await vi.waitFor(() => expect(existsSync(completionPath)).toBe(true));
      if (writerPid !== undefined) {
        await vi.waitFor(() => {
          let writerIsGone = false;
          try {
            process.kill(writerPid!, 0);
          } catch (error) {
            writerIsGone = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
          expect(writerIsGone).toBe(true);
        });
      }
    }
  });

  it.each([90_000, 150_000])(
    "does not kill a server whose database migration delays /health for %i ms",
    async (migrationMs) => {
      const realFetch = globalThis.fetch;
      const realSetTimeout = globalThis.setTimeout;
      const serverPort = await reserveFreePort();
      const context = createStartContext({
        serverEntry: writeImmediateServerEntry(),
        serverPort,
      });
      const processes: ManagedFullStackProcesses = {
        daemonRun: null,
        serverRun: null,
      };
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const fakeStartedAt = Date.now();
      vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
        Date.now() - fakeStartedAt < migrationMs
          ? Promise.reject(new TypeError("fetch failed"))
          : realFetch(input, init),
      );
      let outcome: "pending" | "healthy" | "failed" = "pending";
      const starting = startFullStackServerProcess({
        context,
        env: {
          BB_SERVER_PORT: String(context.serverPort),
          PATH: process.env.PATH,
        },
        processes,
      }).then(
        (run) => {
          outcome = "healthy";
          return run;
        },
        (error: unknown) => {
          outcome = "failed";
          throw error;
        },
      );
      starting.catch(() => {});
      try {
        for (
          let listening = false;
          !listening;
          await new Promise<void>((resolvePromise) =>
            realSetTimeout(resolvePromise, 25),
          )
        ) {
          listening = await realFetch(`${context.serverUrl}/health`).then(
            (response) => response.ok,
            () => false,
          );
        }
        await vi.advanceTimersByTimeAsync(migrationMs - 1_000);
        expect(outcome).toBe("pending");
        await vi.advanceTimersByTimeAsync(2_000);
        const serverRun = await starting;
        expect(outcome).toBe("healthy");
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await serverRun.terminate("SIGTERM");
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await processes.serverRun?.terminate("SIGKILL");
      }
    },
  );

  it("runs the server preflight before it starts a child", async () => {
    const serverPort = await reserveFreePort();
    const context = createStartContext({
      serverEntry: writeFakeServerEntry(),
      serverPort,
    });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };
    const preflightError = new Error("native module ABI mismatch");

    await expect(
      startFullStackServerProcess({
        beforeStart: () => {
          throw preflightError;
        },
        context,
        env: {
          BB_SERVER_PORT: String(context.serverPort),
          PATH: process.env.PATH,
        },
        processes,
      }),
    ).rejects.toBe(preflightError);
    expect(processes.serverRun).toBeNull();
  });

  it("fails startup instead of adopting a server that already owns the port", async () => {
    const foreign = await listen((_request, response) => {
      answerHealth(response, { ok: true });
    });
    const context = createStartContext({
      serverEntry: writeFakeServerEntry(),
      serverPort: foreign.port,
    });
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun: null,
    };

    try {
      await expect(
        startFullStackServerProcess({
          context,
          env: {
            BB_SERVER_PORT: String(context.serverPort),
            PATH: process.env.PATH,
          },
          processes,
        }),
      ).rejects.toThrow(
        `Server failed to become healthy: Process exited before becoming healthy: another server is already answering at ${context.serverUrl}/health`,
      );
      expect(processes.serverRun).toBeNull();
    } finally {
      await foreign.close();
    }
  });
});
