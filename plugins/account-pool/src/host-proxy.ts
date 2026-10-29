import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import tls from "node:tls";
import {
  OAUTH_PROXY_HOST,
  OAUTH_PROXY_ROUTE,
  TARGET_HOST_HEADER,
  TARGET_METHOD_HEADER,
  TARGET_PATH_HEADER,
  classifyOAuthProxyRequest,
} from "./oauth-proxy-policy.js";

export const HUB_ROUTE_PREFIX = "/api/v1/plugins/account-pool/http";

const LOOPBACK = "127.0.0.1";
const MAX_CREDENTIALS = 4_096;
export const CREDENTIAL_LEASE_MS = 3 * 60_000;
const MAX_TUNNELS_PER_TOKEN = 256;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const HUB_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_REQUEST_BYTES = 32 * 1_024 * 1_024;
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "content-encoding",
  "user-agent",
  "anthropic-beta",
  "x-app",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const CONNECT_TARGET = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})$/u;

export interface HostProxyEnsureInput {
  caPem: string;
  leafCertPem: string;
  leafKeyPem: string;
  proxyCredentialSha256s: readonly string[];
  serverUrl: string;
}

export interface HostProxy {
  ensure(
    input: HostProxyEnsureInput,
  ): Promise<{ port: number; caPath: string }>;
  address(): string | null;
  close(): Promise<void>;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function proxyStatus(status: number, reason: string, extra = ""): string {
  return `HTTP/1.1 ${status} ${reason}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`;
}

function basicPassword(header: string | undefined): string | null {
  if (header === undefined || !/^Basic /iu.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString(
    "utf8",
  );
  const separator = decoded.indexOf(":");
  return separator === -1 ? null : decoded.slice(separator + 1);
}

function bearer(header: string | undefined): string | null {
  if (header === undefined || !/^Bearer /iu.test(header)) return null;
  const token = header.slice(7).trim();
  return token === "" ? null : token;
}

async function writeFileAtomic(
  file: string,
  content: string,
  mode: number,
): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { mode });
    await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function createHostProxy(options: {
  dataDir: string;
  fetch?: typeof fetch;
  leaseMs?: number;
}): HostProxy {
  const { dataDir } = options;
  const upstreamFetch = options.fetch ?? fetch;
  const caPath = path.join(dataDir, "ca.pem");
  const portPath = path.join(dataDir, "proxy-port");
  let credentials: Set<string> | null = null;
  let secureContext: tls.SecureContext | null = null;
  let serverUrl = "";
  let listener: http.Server | null = null;
  let boundPort = 0;
  const sockets = new Set<net.Socket>();
  const socketsByCredential = new Map<string, Set<net.Socket>>();
  let starting: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const interceptServer = http.createServer((request, response) => {
    void handleIntercepted(request, response).catch(() => {
      if (!response.headersSent) fail(response, 500, "internal");
      else response.destroy();
    });
  });
  interceptServer.on("clientError", (_error, socket) => socket.destroy());

  const leaseMs = options.leaseMs ?? CREDENTIAL_LEASE_MS;
  let leaseExpiresAt = 0;
  let leaseTimer: ReturnType<typeof setTimeout> | null = null;

  function expireLease(): void {
    leaseExpiresAt = 0;
    credentials = null;
    for (const socket of sockets) socket.destroy();
  }

  function renewLease(): void {
    leaseExpiresAt = Date.now() + leaseMs;
    if (leaseTimer !== null) clearTimeout(leaseTimer);
    leaseTimer = setTimeout(expireLease, leaseMs);
    leaseTimer.unref();
  }

  function knownDigest(digest: string): boolean {
    return Date.now() < leaseExpiresAt && credentials?.has(digest) === true;
  }

  function fail(
    response: http.ServerResponse,
    status: number,
    code: string,
  ): void {
    const body = JSON.stringify({ error: { type: "proxy_error", code } });
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "x-proxy-error": code,
    });
    response.end(body);
  }

  async function readBody(
    request: http.IncomingMessage,
  ): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_REQUEST_BYTES) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  async function handleIntercepted(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "";
    const target = request.url ?? "";
    const decision = classifyOAuthProxyRequest(method, target);
    if (decision.kind === "deny") {
      request.resume();
      fail(response, 403, "path-not-allowed");
      return;
    }
    if (decision.kind === "local") {
      request.resume();
      response.writeHead(
        decision.status,
        decision.body === null
          ? { "content-length": 0 }
          : {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(decision.body),
            },
      );
      response.end(decision.body ?? undefined);
      return;
    }
    const token = bearer(request.headers.authorization);
    if (token === null) {
      request.resume();
      fail(response, 401, "unauthorized");
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      fail(response, 413, "request-too-large");
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (FORWARDED_REQUEST_HEADERS.has(name) || name.startsWith("x-frame-"))
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("authorization", `Bearer ${token}`);
    headers.set(TARGET_HOST_HEADER, OAUTH_PROXY_HOST);
    headers.set(TARGET_METHOD_HEADER, method);
    headers.set(TARGET_PATH_HEADER, target);
    const payload = new ArrayBuffer(body.byteLength);
    new Uint8Array(payload).set(body);
    const aborted = new AbortController();
    response.once("close", () => aborted.abort());
    let upstream: Response;
    try {
      upstream = await upstreamFetch(
        `${serverUrl}${HUB_ROUTE_PREFIX}${OAUTH_PROXY_ROUTE}`,
        {
          method: "POST",
          headers,
          body: payload,
          redirect: "manual",
          signal: AbortSignal.any([
            aborted.signal,
            AbortSignal.timeout(HUB_TIMEOUT_MS),
          ]),
        },
      );
    } catch {
      fail(response, 502, "hub-unreachable");
      return;
    }
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of upstream.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        responseHeaders[name] = value;
    }
    response.writeHead(upstream.status, responseHeaders);
    if (upstream.body === null) {
      response.end();
      return;
    }
    pipeline(Readable.fromWeb(upstream.body as never), response, () => {
      response.destroy();
    });
  }

  function track(socket: net.Socket, digest: string): void {
    sockets.add(socket);
    const open = socketsByCredential.get(digest) ?? new Set<net.Socket>();
    open.add(socket);
    socketsByCredential.set(digest, open);
    socket.once("close", () => {
      sockets.delete(socket);
      open.delete(socket);
      if (open.size === 0 && socketsByCredential.get(digest) === open)
        socketsByCredential.delete(digest);
    });
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  }

  function onConnect(
    request: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void {
    socket.on("error", () => socket.destroy());
    if (!LOOPBACK_ADDRESSES.has(socket.remoteAddress ?? "")) {
      socket.destroy();
      return;
    }
    const password = basicPassword(request.headers["proxy-authorization"]);
    const digest = password === null ? null : sha256(password);
    if (digest === null || !knownDigest(digest)) {
      socket.end(
        proxyStatus(
          407,
          "Proxy Authentication Required",
          'Proxy-Authenticate: Basic realm="account-pool"\r\n',
        ),
      );
      return;
    }
    const match = CONNECT_TARGET.exec(request.url ?? "");
    const port = match === null ? 0 : Number(match[2]);
    if (match === null || port < 1 || port > 65_535) {
      socket.end(proxyStatus(400, "Bad Request"));
      return;
    }
    if ((socketsByCredential.get(digest)?.size ?? 0) >= MAX_TUNNELS_PER_TOKEN) {
      socket.end(proxyStatus(503, "Service Unavailable"));
      return;
    }
    const host = (match[1] ?? "").replace(/^\[|\]$/gu, "");
    track(socket, digest);
    if (host.toLowerCase() === OAUTH_PROXY_HOST && port === 443) {
      intercept(socket, head);
      return;
    }
    tunnel(socket, head, host, port);
  }

  function intercept(socket: net.Socket, head: Buffer): void {
    if (secureContext === null) {
      socket.end(proxyStatus(503, "Service Unavailable"));
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext,
      ALPNProtocols: ["http/1.1"],
    });
    secure.on("error", () => secure.destroy());
    interceptServer.emit("connection", secure);
  }

  function tunnel(
    socket: net.Socket,
    head: Buffer,
    host: string,
    port: number,
  ): void {
    const upstream = net.connect({ host, port });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (upstream.connecting) upstream.destroy(new Error("connect timeout"));
    });
    upstream.once("error", () => {
      if (!socket.destroyed && socket.writable && upstream.connecting)
        socket.end(proxyStatus(502, "Bad Gateway"));
      else socket.destroy();
      upstream.destroy();
    });
    upstream.once("connect", () => {
      upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
    });
  }

  async function listen(preferred: number): Promise<number> {
    const server = http.createServer((_request, response) => {
      response.writeHead(405, { allow: "CONNECT", "content-length": 0 });
      response.end();
    });
    server.on("connect", onConnect);
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(preferred, LOOPBACK, () => {
        server.off("error", reject);
        resolve();
      });
    });
    listener = server;
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Artifact proxy did not bind a TCP port.");
    return address.port;
  }

  async function start(): Promise<void> {
    const saved = Number((await readText(portPath))?.trim() ?? "");
    const preferred = Number.isInteger(saved) && saved > 0 ? saved : 0;
    try {
      boundPort = await listen(preferred);
    } catch (error) {
      if (preferred === 0) throw error;
      boundPort = await listen(0);
    }
    await writeFileAtomic(portPath, String(boundPort), 0o600);
  }

  async function ensureOnce(
    input: HostProxyEnsureInput,
  ): Promise<{ port: number; caPath: string }> {
    if (
      input.proxyCredentialSha256s.length > MAX_CREDENTIALS ||
      !input.proxyCredentialSha256s.every((digest) =>
        DIGEST_PATTERN.test(digest),
      )
    )
      throw new Error(
        "proxyCredentialSha256s must hold lowercase hex SHA-256 digests.",
      );
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(dataDir, 0o700);
    await writeFileAtomic(caPath, input.caPem, 0o644);
    secureContext = tls.createSecureContext({
      key: input.leafKeyPem,
      cert: input.leafCertPem,
    });
    serverUrl = input.serverUrl.replace(/\/+$/u, "");
    const active = new Set(input.proxyCredentialSha256s);
    credentials = active;
    renewLease();
    for (const [digest, open] of socketsByCredential)
      if (!active.has(digest)) for (const socket of open) socket.destroy();
    starting ??= start();
    await starting;
    return { port: boundPort, caPath };
  }

  return {
    ensure(input) {
      const run = queue.then(() => ensureOnce(input));
      queue = run.catch(() => undefined);
      return run;
    },
    address: () => (listener === null ? null : LOOPBACK),
    async close() {
      const server = listener;
      listener = null;
      starting = null;
      credentials = null;
      leaseExpiresAt = 0;
      if (leaseTimer !== null) clearTimeout(leaseTimer);
      leaseTimer = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (server === null) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
