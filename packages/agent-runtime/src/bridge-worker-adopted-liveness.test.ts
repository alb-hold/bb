import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_SOCKET_TRANSPORT_VERSION } from "@bb/provider-bridge-protocol/bridge-kit";
import { PROVIDER_BRIDGE_PROTOCOL_VERSION } from "@bb/provider-bridge-protocol";

const identityRead = vi.hoisted(() => ({
  result: null as string | null,
}));

vi.mock("./bridge-worker-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bridge-worker-registry.js")>()),
  readProcessIdentityAsync: async () => identityRead.result,
}));

const { SocketBridgeWorker } = await import("./bridge-worker-socket.js");
const { BRIDGE_WORKER_REGISTRY_FORMAT_VERSION } =
  await import("./bridge-worker-registry.js");

describe("an adopted bridge worker whose process identity cannot be read", () => {
  let root: string;
  const workers: InstanceType<typeof SocketBridgeWorker>[] = [];

  beforeEach(() => {
    root = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "bbl-"),
    );
    identityRead.result = null;
  });

  afterEach(() => {
    for (const worker of workers.splice(0)) worker.release();
    rmSync(root, { recursive: true, force: true });
  });

  function adopt(pid: number) {
    const worker = new SocketBridgeWorker({
      kind: "adopt",
      workerDir: root,
      connectTimeoutMs: 30_000,
      entry: {
        id: "abcdef012345",
        formatVersion: BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
        pid,
        processIdentity: "recorded-identity",
        socketPath: join(root, "abcdef012345.sock"),
        pluginId: "provider-scripted-echo",
        providerId: "fake",
        processKey: "fake#bridge:1",
        environmentId: "env-1",
        bridgeProtocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        transportVersion: BRIDGE_SOCKET_TRANSPORT_VERSION,
        capabilities: null,
        startedAt: new Date().toISOString(),
        workspace: {
          workspacePath: root,
          workspaceProvisionType: "unmanaged",
          personalWorkspaceRoot: null,
        },
        threads: {},
      },
    });
    workers.push(worker);
    return worker;
  }

  it("is not reported as exited while the recorded pid is still running", async () => {
    const worker = adopt(process.pid);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(worker.exitCode).toBeNull();
  });

  it("is reported as exited once the recorded pid is gone", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.once("exit", resolve));
    const worker = adopt(pid);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(worker.exitCode).toBe(-1);
  });

  it("is reported as exited when the pid now belongs to a different process", async () => {
    identityRead.result = "another-identity";
    const worker = adopt(process.pid);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(worker.exitCode).toBe(-1);
  });
});
