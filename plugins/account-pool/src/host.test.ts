import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "./host.js";
import { createProxyCertificateAuthority } from "./proxy-ca.js";

const TOKEN = "H".repeat(43);
const originalServerUrl = process.env.BB_SERVER_URL;
const originalNoProxy = process.env.NO_PROXY;
const dirs: string[] = [];

afterEach(async () => {
  if (originalServerUrl === undefined) delete process.env.BB_SERVER_URL;
  else process.env.BB_SERVER_URL = originalServerUrl;
  if (originalNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = originalNoProxy;
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function material() {
  const root = await mkdtemp(path.join(tmpdir(), "bb-host-entry-"));
  dirs.push(root);
  const authority = await createProxyCertificateAuthority({
    dir: path.join(root, "ca"),
    now: Date.now,
  });
  const leaf = await authority.leafFor("host-one");
  return {
    root,
    input: {
      caPem: await authority.caPem(),
      leafCertPem: leaf.certPem,
      leafKeyPem: leaf.keyPem,
      proxyCredentialSha256: createHash("sha256").update(TOKEN).digest("hex"),
    },
  };
}

function connectStatus(
  port: number,
  authorization: string | null,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n${
          authorization === null
            ? ""
            : `Proxy-Authorization: Basic ${Buffer.from(`pool:${authorization}`).toString("base64")}\r\n`
        }\r\n`,
      );
    });
    socket.once("data", (chunk) => {
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/u.exec(chunk.toString())?.[1]));
    });
  });
}

describe("account pool host entry", () => {
  it("starts the loopback proxy, retains its worker and stops on dispose", async () => {
    process.env.BB_SERVER_URL = "http://127.0.0.1:1";
    const { root, input } = await material();
    const harness = experimental_createHostEntryHarness(hostEntry, {
      experimental_paths: {
        dataDir: path.join(root, "data"),
        tempDir: path.join(root, "temp"),
      },
    });
    const first = await harness.experimental_call("ensureProxy", input);
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    expect(first.caPath).toBe(path.join(root, "data", "ca.pem"));
    expect(await connectStatus(first.port, null)).toBe(407);
    expect(await connectStatus(first.port, TOKEN)).toBe(200);
    const second = await harness.experimental_call("ensureProxy", {
      ...input,
      proxyCredentialSha256: null,
    });
    expect(second.port).toBe(first.port);
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await harness.experimental_dispose();
    await expect(connectStatus(first.port, TOKEN)).rejects.toThrow();
  });

  it("merges an existing NO_PROXY with loopback and the hub host instead of replacing it", async () => {
    process.env.BB_SERVER_URL = "http://hub.tailnet.test:38886";
    process.env.NO_PROXY = "corp.example, .internal.example";
    const { root, input } = await material();
    const harness = experimental_createHostEntryHarness(hostEntry, {
      experimental_paths: {
        dataDir: path.join(root, "data"),
        tempDir: path.join(root, "temp"),
      },
    });
    const result = await harness.experimental_call("ensureProxy", input);
    expect(result.noProxy.split(",")).toEqual([
      "corp.example",
      ".internal.example",
      "localhost",
      "127.0.0.1",
      "::1",
      "hub.tailnet.test",
    ]);
    await harness.experimental_dispose();
  });

  it("refuses to start without the server URL from the daemon", async () => {
    delete process.env.BB_SERVER_URL;
    const { root, input } = await material();
    const harness = experimental_createHostEntryHarness(hostEntry, {
      experimental_paths: {
        dataDir: path.join(root, "data"),
        tempDir: path.join(root, "temp"),
      },
    });
    await expect(
      harness.experimental_call("ensureProxy", input),
    ).rejects.toThrow(/BB_SERVER_URL/u);
    await harness.experimental_dispose();
  });
});
