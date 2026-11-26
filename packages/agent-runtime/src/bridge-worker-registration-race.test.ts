import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const identityControl = vi.hoisted(() => ({
  read: null as ((pid: number) => Promise<string | null>) | null,
}));

vi.mock("@bb/process-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/process-utils")>();
  return {
    ...actual,
    readProcessStartIdentity: (pid: number) =>
      identityControl.read === null
        ? actual.readProcessStartIdentity(pid)
        : identityControl.read(pid),
  };
});

const { SocketBridgeWorker } = await import("./bridge-worker-socket.js");

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createTempDir(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-bw-race-"));
  directories.push(directory);
  return directory;
}

function spawnWorker(dir: string) {
  const worker = new SocketBridgeWorker({
    kind: "spawn",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 60_000)"],
    cwd: dir,
    env: {},
    workerDir: join(dir, "w"),
    connectTimeoutMs: 5_000,
    appLaunch: { platform: "linux", run: () => undefined },
    registration: {
      environmentId: "env-1",
      pluginId: "p",
      processKey: "k",
      providerId: "f",
    },
    workspace: {
      workspacePath: dir,
      workspaceProvisionType: "unmanaged",
      personalWorkspaceRoot: null,
    },
  });
  worker.on("error", () => undefined);
  return worker;
}

describe("bridge worker registration close race", () => {
  const directories: string[] = [];
  const pendingResolvers: (() => void)[] = [];
  const pidsToKill: number[] = [];
  let activeUnhandledListener: ((reason: unknown) => void) | null = null;

  afterEach(() => {
    identityControl.read = null;
    if (activeUnhandledListener !== null) {
      process.off("unhandledRejection", activeUnhandledListener);
      activeUnhandledListener = null;
    }
    for (const resolve of pendingResolvers.splice(0)) resolve();
    for (const pid of pidsToKill.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function captureUnhandledRejections(): unknown[] {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    activeUnhandledListener = listener;
    process.on("unhandledRejection", listener);
    return unhandled;
  }

  function interceptRegistration(): {
    started: Deferred<number>;
    identity: Deferred<string | null>;
  } {
    const started = createDeferred<number>();
    const identity = createDeferred<string | null>();
    pendingResolvers.push(() => identity.resolve(null));
    identityControl.read = (pid: number) => {
      started.resolve(pid);
      return identity.promise;
    };
    return { started, identity };
  }

  it("awaits registration on stop and does not write or reject when closed mid-registration", async () => {
    const unhandled = captureUnhandledRejections();
    const { started, identity } = interceptRegistration();
    const dir = createTempDir(directories);
    const worker = spawnWorker(dir);
    if (worker.pid !== undefined) pidsToKill.push(worker.pid);

    await started.promise;

    const exited = new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
    });
    let stopResolved = false;
    const stopPromise = worker.stop({ gracePeriodMs: 0 }).then(() => {
      stopResolved = true;
    });

    await exited;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopResolved).toBe(false);

    rmSync(dir, { recursive: true, force: true });
    identity.resolve("linux:test-boot:12345");

    await stopPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopResolved).toBe(true);
    expect(worker.registeredPid).toBeNull();
    expect(existsSync(join(dir, "w"))).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it("does not write or reject when the spawned worker exits by signal while registering", async () => {
    const unhandled = captureUnhandledRejections();
    const { started, identity } = interceptRegistration();
    const dir = createTempDir(directories);
    const worker = spawnWorker(dir);
    if (worker.pid !== undefined) pidsToKill.push(worker.pid);

    await started.promise;

    const exited = new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
    });
    worker.kill("SIGKILL");
    await exited;

    if (process.platform !== "win32") {
      expect(worker.exitCode).toBeNull();
      expect(worker.signalCode).toBe("SIGKILL");
    }

    rmSync(dir, { recursive: true, force: true });
    identity.resolve("linux:test-boot:67890");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.registeredPid).toBeNull();
    expect(unhandled).toEqual([]);
  });

  it("does not write or reject when released while registering", async () => {
    const unhandled = captureUnhandledRejections();
    const { started, identity } = interceptRegistration();
    const dir = createTempDir(directories);
    const worker = spawnWorker(dir);
    const pid = worker.pid;
    if (pid !== undefined) pidsToKill.push(pid);

    await started.promise;

    worker.release();
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    rmSync(dir, { recursive: true, force: true });
    identity.resolve("linux:test-boot:99999");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.registeredPid).toBeNull();
    expect(unhandled).toEqual([]);
  });
});
