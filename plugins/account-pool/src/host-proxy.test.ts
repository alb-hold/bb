import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostProxy, type HostProxy } from "./host-proxy.js";
import { createProxyCertificateAuthority } from "./proxy-ca.js";

const POOL_TOKEN = "T".repeat(43);
const CREDENTIAL = "C".repeat(43);
const OTHER_TOKEN = "U".repeat(43);
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

interface HubCall {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error();
  return address.port;
}

async function startHub(
  respond: (call: HubCall) => { status: number; body: string },
): Promise<{ url: string; calls: HubCall[] }> {
  const calls: HubCall[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const call = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    calls.push(call);
    const reply = respond(call);
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body);
  });
  const port = await listen(server);
  cleanups.push(() => server.closeAllConnections());
  return { url: `http://127.0.0.1:${port}`, calls };
}

function readUntil(socket: net.Socket, marker: string): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const finish = () => {
      socket.off("data", onData);
      socket.off("end", finish);
      socket.off("close", finish);
      resolve(data);
    };
    const onData = (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.includes(marker)) finish();
    };
    socket.on("data", onData);
    socket.resume();
    socket.once("end", finish);
    socket.once("close", finish);
  });
}

async function connect(
  port: number,
  target: string,
  authorization?: string,
): Promise<{ socket: net.Socket; status: number; head: string }> {
  const socket = net.connect(port, "127.0.0.1");
  cleanups.push(() => void socket.destroy());
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${
      authorization === undefined
        ? ""
        : `Proxy-Authorization: ${authorization}\r\n`
    }\r\n`,
  );
  const head = await readUntil(socket, "\r\n\r\n");
  socket.pause();
  const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(head)?.[1] ?? 0);
  return { socket, status, head };
}

const basic = (token: string) =>
  `Basic ${Buffer.from(`pool:${token}`).toString("base64")}`;

async function intercepted(
  port: number,
  caPem: string,
  request: {
    method: string;
    path: string;
    authorization?: string;
    body?: string;
  },
): Promise<{ status: number; headers: string; body: string }> {
  const { socket, status } = await connect(
    port,
    "api.anthropic.com:443",
    basic(CREDENTIAL),
  );
  expect(status).toBe(200);
  const secure = tls.connect({
    socket,
    servername: "api.anthropic.com",
    ca: caPem,
    ALPNProtocols: ["http/1.1"],
  });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  const body = request.body ?? "";
  secure.write(
    `${request.method} ${request.path} HTTP/1.1\r\nHost: api.anthropic.com\r\n` +
      (request.authorization === undefined
        ? ""
        : `Authorization: ${request.authorization}\r\n`) +
      `Cookie: thread=secret\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  let raw = "";
  for await (const chunk of secure) raw += chunk.toString("utf8");
  const [headers = "", ...rest] = raw.split("\r\n\r\n");
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/u.exec(headers)?.[1] ?? 0),
    headers,
    body: rest.join("\r\n\r\n"),
  };
}

describe("host Artifact proxy", () => {
  let dataDir: string;
  let caPem: string;
  let material: { caPem: string; leafCertPem: string; leafKeyPem: string };

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "bb-host-proxy-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const authority = await createProxyCertificateAuthority({
      dir: path.join(dataDir, "server-ca"),
      now: Date.now,
    });
    const leaf = await authority.leafFor("host-one");
    caPem = await authority.caPem();
    material = {
      caPem,
      leafCertPem: leaf.certPem,
      leafKeyPem: leaf.keyPem,
    };
  });

  async function start(serverUrl: string): Promise<{
    proxy: HostProxy;
    port: number;
    caPath: string;
  }> {
    const proxy = createHostProxy({ dataDir: path.join(dataDir, "host") });
    cleanups.push(() => proxy.close());
    const { port, caPath } = await proxy.ensure({
      ...material,
      proxyCredentialSha256: sha256(CREDENTIAL),
      serverUrl,
    });
    return { proxy, port, caPath };
  }

  it("answers 407 to a CONNECT without a valid pool token", async () => {
    const { port } = await start("http://127.0.0.1:1");
    for (const authorization of [
      undefined,
      "Basic !!!",
      "Bearer " + POOL_TOKEN,
      basic(OTHER_TOKEN),
    ]) {
      const result = await connect(
        port,
        "api.anthropic.com:443",
        authorization,
      );
      expect(result.status).toBe(407);
      expect(result.head).toMatch(/Proxy-Authenticate: Basic/iu);
    }
    const tunnel = await connect(port, "example.com:443");
    expect(tunnel.status).toBe(407);
  });

  it("listens on loopback only and keeps no leaf key or token on disk", async () => {
    const { proxy, caPath } = await start("http://127.0.0.1:1");
    expect(proxy.address()).toBe("127.0.0.1");
    expect(await fs.readFile(caPath, "utf8")).toBe(caPem);
    const hostDir = path.join(dataDir, "host");
    const files = await fs.readdir(hostDir);
    expect(files).not.toContain("leaf.key");
    expect(files).not.toContain("leaf.pem");
    for (const name of files) {
      const content = await fs.readFile(path.join(hostDir, name), "utf8");
      expect(content).not.toContain(CREDENTIAL);
      expect(content).not.toContain(material.leafKeyPem.trim());
    }
    expect(
      (await fs.stat(path.join(hostDir, "credentials.json"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("tunnels other hosts directly from the host without inspecting them", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const { port } = await start("http://127.0.0.1:1");
    const { socket, status } = await connect(
      port,
      `127.0.0.1:${echoPort}`,
      basic(CREDENTIAL),
    );
    expect(status).toBe(200);
    socket.write("ping");
    expect(await readUntil(socket, "ping")).toBe("ping");
  });

  it("forwards allowlisted Artifact requests to the hub with the pool token and no thread cookie", async () => {
    const hub = await startHub(() => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }));
    const { port } = await start(hub.url);
    const result = await intercepted(port, caPem, {
      method: "POST",
      path: "/api/frame/deploy/prepare",
      authorization: `Bearer ${POOL_TOKEN}`,
      body: '{"a":1}',
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain('{"ok":true}');
    expect(hub.calls).toHaveLength(1);
    const call = hub.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("/api/v1/plugins/account-pool/http/claude-oauth");
    expect(call?.headers.authorization).toBe(`Bearer ${POOL_TOKEN}`);
    expect(call?.headers["x-pool-target-host"]).toBe("api.anthropic.com");
    expect(call?.headers["x-pool-target-method"]).toBe("POST");
    expect(call?.headers["x-pool-target-path"]).toBe(
      "/api/frame/deploy/prepare",
    );
    expect(call?.headers.cookie).toBeUndefined();
    expect(call?.body).toBe('{"a":1}');
  });

  it("refuses, answers locally, or authenticates without touching the hub", async () => {
    const hub = await startHub(() => ({ status: 200, body: "{}" }));
    const { port } = await start(hub.url);
    const denied = await intercepted(port, caPem, {
      method: "GET",
      path: "/api/oauth/profile",
      authorization: `Bearer ${POOL_TOKEN}`,
    });
    expect(denied.status).toBe(403);
    expect(denied.headers).toMatch(/x-proxy-error: path-not-allowed/iu);
    const telemetry = await intercepted(port, caPem, {
      method: "POST",
      path: "/api/event_logging/v2/batch",
      body: "{}",
    });
    expect(telemetry.status).toBe(204);
    const settings = await intercepted(port, caPem, {
      method: "GET",
      path: "/api/claude_code/settings",
      authorization: `Bearer ${POOL_TOKEN}`,
    });
    expect([200, 404]).toContain(settings.status);
    const anonymous = await intercepted(port, caPem, {
      method: "GET",
      path: "/api/claude_code/policy_limits",
    });
    expect(anonymous.status).toBe(401);
    expect(hub.calls).toEqual([]);
  });

  it("reports an unreachable hub as a 502 and keeps serving", async () => {
    const { port } = await start("http://127.0.0.1:1");
    const result = await intercepted(port, caPem, {
      method: "GET",
      path: "/api/claude_code/policy_limits",
      authorization: `Bearer ${POOL_TOKEN}`,
    });
    expect(result.status).toBe(502);
    expect(result.headers).toMatch(/x-proxy-error: hub-unreachable/iu);
  });

  it("keeps serving after the hub resets a response mid-stream", async () => {
    let calls = 0;
    const hub = http.createServer((request, response) => {
      request.resume();
      calls += 1;
      if (calls === 1) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("partial");
        setTimeout(() => response.destroy(), 30);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const hubPort = await listen(hub);
    cleanups.push(() => hub.closeAllConnections());
    const failures: unknown[] = [];
    const record = (error: unknown) => failures.push(error);
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    cleanups.push(() => {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    });
    const { port } = await start(`http://127.0.0.1:${hubPort}`);
    await intercepted(port, caPem, {
      method: "GET",
      path: "/api/claude_code/policy_limits",
      authorization: `Bearer ${POOL_TOKEN}`,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await intercepted(port, caPem, {
      method: "GET",
      path: "/api/claude_code/policy_limits",
      authorization: `Bearer ${POOL_TOKEN}`,
    });
    expect(second.status).toBe(200);
    expect(second.body).toContain('{"ok":true}');
    expect(failures).toEqual([]);
  });

  it("registers every token when ensure calls run concurrently", async () => {
    const proxy = createHostProxy({ dataDir: path.join(dataDir, "host") });
    cleanups.push(() => proxy.close());
    const tokens = Array.from({ length: 8 }, (_, index) =>
      String(index).repeat(43).slice(0, 43),
    );
    const results = await Promise.all(
      tokens.map((token) =>
        proxy.ensure({
          ...material,
          proxyCredentialSha256: sha256(token),
          serverUrl: "http://127.0.0.1:1",
        }),
      ),
    );
    const port = results[0]?.port ?? 0;
    expect(new Set(results.map((result) => result.port)).size).toBe(1);
    for (const token of tokens) {
      const result = await connect(port, "api.anthropic.com:443", basic(token));
      expect(result.status).toBe(200);
      result.socket.destroy();
    }
  });

  it("keeps its port and registered tokens across a restart", async () => {
    const first = await start("http://127.0.0.1:1");
    await first.proxy.close();
    const proxy = createHostProxy({ dataDir: path.join(dataDir, "host") });
    cleanups.push(() => proxy.close());
    const second = await proxy.ensure({
      ...material,
      proxyCredentialSha256: null,
      serverUrl: "http://127.0.0.1:1",
    });
    expect(second.port).toBe(first.port);
    const result = await connect(
      second.port,
      "api.anthropic.com:443",
      basic(CREDENTIAL),
    );
    expect(result.status).toBe(200);
  });
});
