import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import http from "node:http";
import http2 from "node:http2";
import { once } from "node:events";
import type { LookupFunction } from "node:net";
import type { Dispatcher } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import net from "node:net";
import {
  CONNECT_ATTEMPT_TIMEOUT_MS,
  CONNECT_MAX_ADDRESSES,
  CONNECT_SURFACE_LIMIT_MS,
  CONNECT_TIMEOUT_MS,
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";

const cleanups: Array<() => Promise<void>> = [];
const nativeFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("no_proxy", "*");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function upstream() {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
    }
    requests++;
    response.end("OK");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests };
}

it("uses an independent transport when the default dispatcher retains a destroyed HTTP/2 session", async () => {
  const cause = Object.assign(new Error("The session has been destroyed"), {
    code: "ERR_HTTP2_INVALID_SESSION",
  });
  const brokenDefault = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit & { dispatcher?: Dispatcher },
  ) => {
    if (init?.dispatcher === undefined) {
      throw new TypeError("fetch failed", { cause });
    }
    return nativeFetch(input, init);
  };
  vi.stubGlobal("fetch", brokenDefault);
  const target = await upstream();
  await expect(fetch(target.url)).rejects.toMatchObject({
    cause: {
      code: "ERR_HTTP2_INVALID_SESSION",
      message: "The session has been destroyed",
    },
  });
  expect(target.requests()).toBe(0);
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  for (let i = 0; i < 2; i++) {
    const response = await transport.fetch(target.url, {
      method: "POST",
      body: "hello",
    });
    expect(await response.text()).toBe("OK");
  }
  expect(target.requests()).toBe(2);
});

it("negotiates HTTP/1.1 when the upstream also offers HTTP/2", async () => {
  const cert = new URL("./fixtures/localhost-cert.pem", import.meta.url);
  const key = new URL("./fixtures/localhost-key.pem", import.meta.url);
  const server = http2.createSecureServer({
    cert: await readFile(cert),
    key: await readFile(key),
    allowHTTP1: true,
  });
  let alpn: string | false | undefined;
  server.on("secureConnection", (socket) => {
    alpn = socket.alpnProtocol;
  });
  server.on("request", (request, response) => {
    response.end(JSON.stringify({ httpVersion: request.httpVersion, alpn }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  const moduleUrl = new URL("./upstream-transport.ts", import.meta.url);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import { createUpstreamTransport } from ${JSON.stringify(moduleUrl.href)};
      const transport = createUpstreamTransport();
      try {
        const response = await transport.fetch("https://127.0.0.1:${address.port}");
        console.log(await response.text());
      } finally {
        await transport.destroy();
      }
    `,
    ],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(cert) },
      timeout: 10_000,
    },
  );
  expect(JSON.parse(stdout)).toEqual({ httpVersion: "1.1", alpn: "http/1.1" });
}, 15_000);

it("releases its connections on disposal and refuses later requests", async () => {
  const target = await upstream();
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  expect(await (await transport.fetch(target.url)).text()).toBe("OK");
  await transport.destroy();
  await expect(transport.fetch(target.url)).rejects.toThrow();
  expect(target.requests()).toBe(1);
});

it("preserves cancellation without sending a request", async () => {
  const target = await upstream();
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.fetch(target.url, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(target.requests()).toBe(0);
});

it("does not replay an accepted POST whose response connection fails", async () => {
  let requests = 0;
  const server = http.createServer(async (request) => {
    for await (const _chunk of request) {
    }
    requests++;
    request.socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  await expect(
    transport.fetch(`http://127.0.0.1:${address.port}`, {
      method: "POST",
      body: "hello",
    }),
  ).rejects.toThrow();
  expect(requests).toBe(1);
});

it("does not expose arbitrary error messages or unrecognized codes", () => {
  const error = Object.assign(new Error("secret-token"), {
    code: "SECRET_TOKEN",
  });
  expect(transportErrorCode(error)).toBe("unclassified transport error");
  error.cause = error;
  expect(transportErrorCode(error)).toBe("unclassified transport error");
});

const stallingDualStackLookup: LookupFunction = (_hostname, _options, done) => {
  done(null, [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
  const until = Date.now() + 600;
  while (Date.now() < until) {}
};

it("connects when the event loop stalls longer than Node's default 250ms address-attempt window", async () => {
  const target = await upstream();
  const transport = createUpstreamTransport({
    lookup: stallingDualStackLookup,
  });
  cleanups.push(transport.destroy);
  const response = await transport.fetch(
    target.url.replace("127.0.0.1", "upstream.test"),
  );
  expect(await response.text()).toBe("OK");
  expect(target.requests()).toBe(1);
});

it("names the member errors of an aggregate connect failure", () => {
  const aggregate = Object.assign(new AggregateError([], "connect failed"), {
    code: "ETIMEDOUT",
    errors: [
      Object.assign(new Error("a"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("b"), { code: "EHOSTUNREACH" }),
      new Error("no code"),
    ],
  });
  expect(
    transportErrorCode(new TypeError("fetch failed", { cause: aggregate })),
  ).toBe("ETIMEDOUT [ETIMEDOUT, EHOSTUNREACH]");
});

const droppedAddress = (index: number) => ({
  address: `192.0.2.${index + 1}`,
  family: 4,
});

it.each(["direct TLS", "proxy CONNECT"])(
  "bounds a stalled TLS connect in real time while the event loop is busy: %s",
  async (mode) => {
    const sockets = new Set<net.Socket>();
    let received = "";
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("data", (data) => {
        received += data.toString();
      });
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No port");
    if (mode === "proxy CONNECT") {
      vi.stubEnv("NO_PROXY", "");
      vi.stubEnv("no_proxy", "");
      vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${address.port}`);
      vi.stubEnv("https_proxy", `http://127.0.0.1:${address.port}`);
    }
    const stall = setInterval(() => {
      const until = performance.now() + 450;
      while (performance.now() < until) {}
    }, 600);
    try {
      const result = await timedFetch(
        `https://127.0.0.1:${address.port}`,
        stallingDualStackLookup,
      );
      console.log(
        JSON.stringify({ scenario: mode, elapsedMs: result.elapsedMs }),
      );
      expect(result.text).toBeNull();
      expect(transportErrorCode(result.error)).toBe("UND_ERR_CONNECT_TIMEOUT");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 200);
      expect(result.elapsedMs).toBeLessThanOrEqual(CONNECT_SURFACE_LIMIT_MS);
      if (mode === "proxy CONNECT") expect(received).toContain("CONNECT ");
    } finally {
      clearInterval(stall);
    }
  },
  20_000,
);

it("keeps a connected response readable beyond the connect deadline", async () => {
  const server = http.createServer((_request, response) => {
    response.write("connected");
    const timer = setTimeout(
      () => response.end(" complete"),
      CONNECT_TIMEOUT_MS + 200,
    );
    response.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  const response = await transport.fetch(`http://127.0.0.1:${address.port}`);
  expect(await response.text()).toBe("connected complete");
}, 15_000);

async function addressesAreSilentlyDropped(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({
      host: droppedAddress(0).address,
      port: 9,
      autoSelectFamily: false,
    });
    socket.setTimeout(500);
    socket.on("connect", () => resolve(false));
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => resolve(true));
  });
}

const dropped = await addressesAreSilentlyDropped();

async function timedFetch(
  url: string,
  lookup: LookupFunction,
): Promise<{ elapsedMs: number; text: string | null; error: unknown }> {
  const transport = createUpstreamTransport({ lookup });
  cleanups.push(transport.destroy);
  const started = performance.now();
  try {
    const response = await transport.fetch(url);
    return {
      elapsedMs: performance.now() - started,
      text: await response.text(),
      error: null,
    };
  } catch (error) {
    return { elapsedMs: performance.now() - started, text: null, error };
  }
}

it("starts every permitted address attempt before the connect timeout and keeps the timeout under the surface limit", () => {
  expect((CONNECT_MAX_ADDRESSES - 1) * CONNECT_ATTEMPT_TIMEOUT_MS).toBeLessThan(
    CONNECT_TIMEOUT_MS,
  );
  expect(CONNECT_TIMEOUT_MS).toBeLessThan(CONNECT_SURFACE_LIMIT_MS);
});

it.skipIf(!dropped)(
  "surfaces a named error within 10 s when every address is silently dropped",
  async () => {
    const target = await upstream();
    const addresses = Array.from(
      { length: CONNECT_MAX_ADDRESSES + 2 },
      (_, index) => droppedAddress(index),
    );
    const result = await timedFetch(
      target.url.replace("127.0.0.1", "upstream.test"),
      (_hostname, _options, done) => done(null, addresses),
    );
    expect(result.text).toBeNull();
    expect(transportErrorCode(result.error)).toBe("UND_ERR_CONNECT_TIMEOUT");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 200);
    expect(result.elapsedMs).toBeLessThanOrEqual(CONNECT_SURFACE_LIMIT_MS);
    expect(target.requests()).toBe(0);
  },
  20_000,
);

it.skipIf(!dropped)(
  "still reaches a reachable address listed after the last permitted dropped one inside the connect timeout",
  async () => {
    const target = await upstream();
    const result = await timedFetch(
      target.url.replace("127.0.0.1", "upstream.test"),
      (_hostname, _options, done) =>
        done(null, [
          ...Array.from({ length: CONNECT_MAX_ADDRESSES - 1 }, (_, index) =>
            droppedAddress(index),
          ),
          { address: "127.0.0.1", family: 4 },
          ...Array.from({ length: 3 }, (_, index) =>
            droppedAddress(index + 10),
          ),
        ]),
    );
    expect(result.text).toBe("OK");
    expect(result.elapsedMs).toBeLessThan(CONNECT_TIMEOUT_MS);
  },
  20_000,
);

it.skipIf(!dropped)(
  "falls through a silently dropped first address to a reachable second one within one attempt window",
  async () => {
    const target = await upstream();
    const result = await timedFetch(
      target.url.replace("127.0.0.1", "upstream.test"),
      (_hostname, _options, done) =>
        done(null, [droppedAddress(0), { address: "127.0.0.1", family: 4 }]),
    );
    expect(result.text).toBe("OK");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(
      CONNECT_ATTEMPT_TIMEOUT_MS - 200,
    );
    expect(result.elapsedMs).toBeLessThan(CONNECT_ATTEMPT_TIMEOUT_MS + 1_000);
  },
  20_000,
);

it("connects through IPv4 without waiting a window when the IPv6 address is unusable", async () => {
  const target = await upstream();
  const result = await timedFetch(
    target.url.replace("127.0.0.1", "upstream.test"),
    (_hostname, _options, done) =>
      done(null, [
        { address: "2001:db8::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]),
  );
  expect(result.text).toBe("OK");
  expect(result.elapsedMs).toBeLessThan(CONNECT_ATTEMPT_TIMEOUT_MS + 1_000);
}, 20_000);
