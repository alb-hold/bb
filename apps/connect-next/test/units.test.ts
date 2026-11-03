import { createMachineLabelProxy } from "../src/machine-label.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  FRP_CREDENTIAL_META,
  GATE_PRESENCE_BATCH_MAX,
  GATE_RESOLVE_BATCH_MAX,
  type GatePresenceRequest,
  type GateResolveRequest,
  type GateResolveResponse,
} from "@bb/tunnel-contract/next";
import {
  createAccountApi,
  parseGateResolveResponse,
} from "../src/account-api.js";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import type { AccountApi } from "../src/account-api.js";
import {
  brotliQuality,
  compressor,
  LARGE_BROTLI_QUALITY,
  LARGE_DYNAMIC_BYTES,
  preferredEncoding,
  shouldCompress,
  STORED_BROTLI_QUALITY,
} from "../src/compress.js";
import { silentLog } from "../src/log.js";
import { startPresence } from "../src/presence.js";
import { trackServerFrames, WEBSOCKET_GOING_AWAY } from "../src/ws-frames.js";
import { configFromEnv } from "../src/config.js";
import { createLocalDirectory } from "../src/directory.js";
import { createFrpConnections } from "../src/frp-connections.js";
import {
  createFrpHooks,
  isOwnSubdomain,
  parseHookCall,
  REMOVAL_SETTLE_MS,
} from "../src/frp-hooks.js";
import type { FrpProxyState, FrpState } from "../src/frp-state.js";
import { isTenantSetCookie, tenantCookies } from "../src/forwarding.js";
import { Lru } from "../src/lru.js";
import { isMcpLocalPath } from "../src/mcp.js";

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ASK: GateResolveRequest = {
  label: "bee",
  session: "s1",
  desktopSession: null,
  credential: null,
  machineCredential: null,
  oauth: null,
};

const OWNED: GateResolveResponse = {
  label: {
    kind: "server",
    serverId: "srv",
    userId: "u1",
    revoked: false,
    lastSeenAt: null,
  },
  session: { userId: "u1", needsRefresh: false },
  desktopSession: null,
  credential: null,
  machine: null,
  oauth: null,
};

interface StubCall {
  url: string;
  body: { requests?: GateResolveRequest[]; reports?: GatePresenceRequest[] };
  auth: string | null;
}

function stubFetch(
  answers: (request: GateResolveRequest) => unknown,
  status: () => number = () => 200,
) {
  const calls: StubCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as StubCall["body"];
    calls.push({
      url: String(input),
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const code = status();
    if (code !== 200) return new Response("no", { status: code });
    if (body.reports !== undefined) {
      return Response.json({ results: body.reports.map(() => "recorded") });
    }
    return Response.json({ answers: (body.requests ?? []).map(answers) });
  };
  return { calls, fetchImpl };
}

function asked(calls: StubCall[]): number {
  return calls.reduce(
    (sum, call) => sum + (call.body.requests?.length ?? 0),
    0,
  );
}

const REVOKED: GateResolveResponse = {
  ...OWNED,
  label: { ...OWNED.label!, revoked: true } as GateResolveResponse["label"],
  session: { userId: "u1", needsRefresh: false },
  credential: false,
};

describe("account API client", () => {
  it("rejects answers that are not exactly the contract", () => {
    expect(parseGateResolveResponse(OWNED, ASK)).toEqual(OWNED);
    expect(
      parseGateResolveResponse({ ...OWNED, oauth: undefined }, ASK),
    ).toBeNull();
    expect(
      parseGateResolveResponse({ ...OWNED, session: { userId: "u1" } }, ASK),
    ).toBeNull();
    expect(
      parseGateResolveResponse({ ...OWNED, credential: true }, ASK),
    ).toBeNull();
    expect(
      parseGateResolveResponse(
        { ...OWNED, label: { ...OWNED.label, kind: "planet" } },
        ASK,
      ),
    ).toBeNull();
    expect(
      parseGateResolveResponse(
        {
          ...OWNED,
          session: null,
          desktopSession: { userId: "u1", setCookie: 5 },
        },
        { ...ASK, desktopSession: "d" },
      ),
    ).toBeNull();
  });

  it("dedupes concurrent lookups into one batch and keeps answers fresh for at most 60 s", async () => {
    let clock = 0;
    const { calls, fetchImpl } = stubFetch(() => OWNED);
    const api = createAccountApi({
      baseUrl: "https://connect.test/",
      secret: "s3cret",
      fetch: fetchImpl,
      positiveTtlMs: 600_000,
      random: () => 0,
      now: () => clock,
    });
    await Promise.all([
      api.resolve(ASK),
      api.resolve(ASK),
      api.resolve({ ...ASK, session: "s2" }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://connect.test/api/gate/resolve/batch");
    expect(calls[0]?.auth).toBe("Bearer s3cret");
    expect(calls[0]?.body).toEqual({
      requests: [ASK, { ...ASK, session: "s2" }],
    });
    clock = 59_000;
    await api.resolve(ASK);
    expect(calls).toHaveLength(1);
    clock = 60_001;
    expect(await api.resolve(ASK)).toEqual(OWNED);
    await waitUntil(() => calls.length === 2);
    expect(await api.resolve(ASK)).toEqual(OWNED);
    expect(calls).toHaveLength(2);
    api.forget(ASK);
    await api.resolve(ASK);
    expect(calls).toHaveLength(3);
  });

  it("jitters the fresh time downwards by up to a fifth", async () => {
    let clock = 0;
    const { calls, fetchImpl } = stubFetch(() => OWNED);
    const api = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: fetchImpl,
      random: () => 1,
      now: () => clock,
    });
    await api.resolve(ASK);
    clock = 47_999;
    await api.resolve(ASK);
    expect(calls).toHaveLength(1);
    clock = 48_001;
    await api.resolve(ASK);
    await waitUntil(() => calls.length === 2);
  });

  it("serves the last good answer through an outage, but not past the max staleness", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let clock = 0;
    let status = 200;
    const failures: unknown[] = [];
    const { calls, fetchImpl } = stubFetch(
      () => OWNED,
      () => status,
    );
    const api = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: fetchImpl,
      random: () => 0,
      deadlineMs: 50,
      onRevalidateFailed: (error) => failures.push(error),
      now: () => clock,
    });
    await Promise.all([api.resolve(ASK), vi.runAllTimersAsync()]);
    status = 502;
    clock = 61_000;
    expect(await api.resolve(ASK)).toEqual(OWNED);
    await vi.runAllTimersAsync();
    expect(failures).toHaveLength(1);
    clock = 62_000;
    expect(await api.resolve(ASK)).toEqual(OWNED);
    expect(calls).toHaveLength(2);
    clock = 67_000;
    expect(await api.resolve(ASK)).toEqual(OWNED);
    await vi.runAllTimersAsync();
    expect(failures).toHaveLength(2);
    clock = 300_001;
    await Promise.all([
      expect(api.resolve(ASK)).rejects.toThrow("HTTP 502"),
      vi.runAllTimersAsync(),
    ]);
    status = 200;
    await Promise.all([
      expect(api.resolve(ASK)).resolves.toEqual(OWNED),
      vi.runAllTimersAsync(),
    ]);
  });

  it("forgets every answer for a label, session or credential once one answer refutes it", async () => {
    let revoked = false;
    const { calls, fetchImpl } = stubFetch((request) =>
      revoked
        ? {
            ...REVOKED,
            session: request.session === null ? null : REVOKED.session,
            credential: request.credential === null ? null : false,
          }
        : {
            ...OWNED,
            session: request.session === null ? null : OWNED.session,
            credential: request.credential === null ? null : true,
          },
    );
    let clock = 0;
    const api = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: fetchImpl,
      random: () => 0,
      now: () => clock,
    });
    const login = { ...ASK, session: null, credential: "cred" };
    await Promise.all([
      api.resolve(ASK),
      api.resolve({ ...ASK, session: "s2" }),
      api.resolve(login),
    ]);
    revoked = true;
    clock = 61_000;
    await api.resolve(login);
    await waitUntil(() => asked(calls) === 4);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const answer = await api.resolve(ASK);
    expect(answer.label?.revoked).toBe(true);
    expect((await api.resolve({ ...ASK, session: "s2" })).label?.revoked).toBe(
      true,
    );
    expect(asked(calls)).toBe(6);
  });

  it("holds background refreshes back so they travel together, unless a visitor lookup goes first", async () => {
    let clock = 0;
    const { calls, fetchImpl } = stubFetch(() => OWNED);
    const api = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: fetchImpl,
      random: () => 0,
      backgroundWindowMs: 200,
      now: () => clock,
    });
    const asks = Array.from({ length: 30 }, (_, index) => ({
      ...ASK,
      session: `s${index}`,
    }));
    await Promise.all(asks.map((request) => api.resolve(request)));
    const first = calls.length;
    clock = 61_000;
    for (const request of asks.slice(0, 20)) await api.resolve(request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toHaveLength(first);
    await waitUntil(() => calls.length === first + 1);
    expect(calls.at(-1)?.body.requests).toHaveLength(20);
    clock = 122_000;
    for (const request of asks.slice(20)) await api.resolve(request);
    await api.resolve({ ...ASK, session: "new" });
    expect(calls).toHaveLength(first + 2);
    expect(calls.at(-1)?.body.requests).toHaveLength(11);
  });

  it("keeps negative answers briefly and bounds the cache", async () => {
    let clock = 0;
    const { calls, fetchImpl } = stubFetch(() => ({ ...OWNED, session: null }));
    const api = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: fetchImpl,
      negativeTtlMs: 1_000,
      maxEntries: 2,
      random: () => 0,
      now: () => clock,
    });
    await api.resolve(ASK);
    await api.resolve(ASK);
    expect(asked(calls)).toBe(1);
    clock = 1_001;
    await api.resolve(ASK);
    expect(asked(calls)).toBe(2);
    await api.resolve({ ...ASK, session: "s2" });
    await api.resolve({ ...ASK, session: "s3" });
    await api.resolve(ASK);
    expect(asked(calls)).toBe(5);
  });

  it(`batches up to ${GATE_RESOLVE_BATCH_MAX} lookups per call and caps the calls in flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    const calls: number[] = [];
    const api = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      maxBatchesInFlight: 2,
      fetch: async (_input, init) => {
        const { requests } = JSON.parse(String(init?.body)) as {
          requests: GateResolveRequest[];
        };
        calls.push(requests.length);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return Response.json({ answers: requests.map(() => OWNED) });
      },
    });
    await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        api.resolve({ ...ASK, session: `s${index}` }),
      ),
    );
    expect(calls).toEqual([50, 50, 50, 50, 20]);
    expect(peak).toBe(2);
  });

  it("retries transient failures with backoff inside the deadline and gives up on the rest", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let failuresLeft = 2;
    const { calls, fetchImpl } = stubFetch(
      () => OWNED,
      () => (failuresLeft-- > 0 ? 502 : 200),
    );
    const api = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: fetchImpl,
      random: () => 0,
    });
    const recovered = expect(
      api.resolve(ASK, { deadlineMs: 5_000 }),
    ).resolves.toEqual(OWNED);
    await vi.runAllTimersAsync();
    await recovered;
    expect(calls).toHaveLength(3);
    const refused = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: async () => new Response("no", { status: 404 }),
    });
    const started = Date.now();
    const refusal = expect(refused.resolve(ASK)).rejects.toThrow("HTTP 404");
    await vi.runAllTimersAsync();
    await refusal;
    expect(Date.now() - started).toBeLessThan(1_000);
    const down = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      random: () => 0,
      fetch: async () => new Response("no", { status: 503 }),
    });
    const tried = Date.now();
    const exhausted = expect(
      down.resolve(ASK, { deadlineMs: 600 }),
    ).rejects.toThrow("HTTP 503");
    await vi.runAllTimersAsync();
    await exhausted;
    expect(Date.now() - tried).toBeLessThan(1_500);
  });

  it("treats a null batch answer as could-not-check and a malformed one as an error", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const unchecked = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      random: () => 0,
      fetch: async () => Response.json({ answers: [null] }),
    });
    const uncheckedResult = expect(
      unchecked.resolve(ASK, { deadlineMs: 300 }),
    ).rejects.toThrow("could not check");
    await Promise.all([uncheckedResult, vi.runAllTimersAsync()]);
    const malformed = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: async () => Response.json({ answers: [{ label: null }] }),
    });
    const malformedResult = expect(malformed.resolve(ASK)).rejects.toThrow(
      "malformed",
    );
    await Promise.all([malformedResult, vi.runAllTimersAsync()]);
  });

  it(`sends presence in calls of at most ${GATE_PRESENCE_BATCH_MAX} and checks the results`, async () => {
    const { calls, fetchImpl } = stubFetch(() => OWNED);
    const api = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: fetchImpl,
    });
    const reports = Array.from(
      { length: GATE_PRESENCE_BATCH_MAX + 10 },
      (_, index): GatePresenceRequest => ({
        label: `l${index}`,
        state: "connected",
        region: "sjc",
        gateMachineId: "m",
        at: 1,
      }),
    );
    const results = await api.presence(reports);
    expect(results).toHaveLength(reports.length);
    expect(calls.map((call) => call.url)).toEqual([
      "https://connect.test/api/gate/presence/batch",
      "https://connect.test/api/gate/presence/batch",
    ]);
    expect(calls.map((call) => call.body.reports?.length)).toEqual([
      GATE_PRESENCE_BATCH_MAX,
      10,
    ]);
    const malformed = createAccountApi({
      baseUrl: "https://connect.test",
      secret: "s",
      fetch: async () => Response.json({ results: ["maybe"] }),
    });
    await expect(malformed.presence(reports.slice(0, 1))).rejects.toThrow(
      "malformed",
    );
  });
});

describe("frp hooks", () => {
  it("accepts only the label and its share ports", () => {
    expect(isOwnSubdomain("bee", "bee")).toBe(true);
    expect(isOwnSubdomain("bee", "bee--3000")).toBe(true);
    expect(isOwnSubdomain("bee", "bee--65535")).toBe(true);
    expect(isOwnSubdomain("bee", "bee--65536")).toBe(false);
    expect(isOwnSubdomain("bee", "bee--0")).toBe(false);
    expect(isOwnSubdomain("bee", "bee--x")).toBe(false);
    expect(isOwnSubdomain("bee", "beehive")).toBe(false);
    expect(isOwnSubdomain("bee", "wasp")).toBe(false);
  });

  it("parses both user shapes frps sends", () => {
    expect(
      parseHookCall({
        op: "Login",
        content: { user: "bee", metas: { credential: "c" } },
      })?.user,
    ).toEqual({ label: "bee", credential: "c", runId: "" });
    expect(
      parseHookCall({
        op: "NewProxy",
        content: {
          user: { user: "bee", metas: {}, run_id: "r1" },
          proxy_name: "bee.bb",
          proxy_type: "http",
          subdomain: "bee",
        },
      }),
    ).toMatchObject({
      user: { label: "bee", credential: null, runId: "r1" },
      proxyName: "bee.bb",
      subdomain: "bee",
      customDomains: [],
    });
    expect(parseHookCall({ op: "Login", content: { user: 5 } })).toBeNull();
  });

  describe("proxy removal", () => {
    const LINKED_ACCOUNTS: AccountApi = {
      resolve: async () => ({ ...OWNED, credential: true }),
      forget: () => {},
      presence: async () => [],
    };
    const TIMINGS = { registerGraceMs: 60, stateRetryMs: 20, reconcileMs: 250 };
    const PROXY_NAME = "bee.bb";
    const SUBDOMAIN = "bee--3000";

    function createFrpsStub() {
      const registered = new Map<string, string>();
      const stub = {
        down: false,
        unknownAnswers: 0,
        offlineAnswers: 0,
        queries: 0,
        gate: null as Promise<void> | null,
        register(name: string, clientId: string) {
          registered.set(name, clientId);
        },
        unregister(name: string) {
          registered.delete(name);
        },
        registered(name: string) {
          return registered.has(name);
        },
        state: {
          async proxy(name: string): Promise<FrpProxyState> {
            stub.queries += 1;
            const clientId = registered.get(name);
            await stub.gate;
            if (stub.down) return { kind: "unknown" };
            if (stub.unknownAnswers > 0) {
              stub.unknownAnswers -= 1;
              return { kind: "unknown" };
            }
            if (stub.offlineAnswers > 0) {
              stub.offlineAnswers -= 1;
              return { kind: "offline" };
            }
            return clientId === undefined
              ? { kind: "offline" }
              : { kind: "online", clientId };
          },
          async online() {
            if (stub.down) return null;
            if (stub.unknownAnswers > 0) {
              stub.unknownAnswers -= 1;
              return null;
            }
            return new Map(registered);
          },
        } satisfies FrpState,
      };
      return stub;
    }

    async function startHooks(
      accounts: AccountApi = LINKED_ACCOUNTS,
      extraTimings: { runBindingIdleMs?: number } = {},
    ) {
      const connections = createFrpConnections();
      const directory = createLocalDirectory({ graceMs: 60_000 });
      const frps = createFrpsStub();
      const hooks = createFrpHooks({
        accounts,
        directory,
        log: silentLog,
        onLogin: (address, label, runId) =>
          connections.loggedIn(address, label, runId),
        claimConnection: (label, runId) => connections.claim(label, runId),
        connectionOpen: (connectionId) => connections.isOpen(connectionId),
        runConnected: (label, runId) => connections.holds(label, runId),
        frpState: frps.state,
        timings: { ...TIMINGS, ...extraTimings },
      });
      await new Promise<void>((resolve) =>
        hooks.server.listen(0, "127.0.0.1", resolve),
      );
      onTestFinished(() => {
        hooks.server.close();
      });
      const address = hooks.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("hook server has no port");
      }
      const post = async (op: string, content: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/frp`, {
          method: "POST",
          body: JSON.stringify({ op, content }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ reject: false });
      };
      const ask = async (op: string, content: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/frp`, {
          method: "POST",
          body: JSON.stringify({ op, content }),
        });
        return response.json();
      };
      const metas = { [FRP_CREDENTIAL_META]: "credential" };
      const login = async (clientAddress: string, runId?: string) => {
        const socket = new PassThrough();
        connections.track(clientAddress, [socket]);
        await post("Login", {
          user: "bee",
          metas,
          ...(runId === undefined ? {} : { run_id: runId }),
          client_address: clientAddress,
        });
        return socket;
      };
      const proxyCall = (op: string, runId?: string) =>
        post(op, {
          user: {
            user: "bee",
            metas,
            ...(runId === undefined ? {} : { run_id: runId }),
          },
          proxy_name: PROXY_NAME,
          proxy_type: "http",
          subdomain: SUBDOMAIN,
        });
      const newProxy = async (runId: string) => {
        await proxyCall("NewProxy", runId);
        frps.register(PROXY_NAME, runId);
      };
      return { directory, frps, login, proxyCall, newProxy, ask, metas };
    }

    type Harness = Awaited<ReturnType<typeof startHooks>>;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const STILL_WAITING = "still waiting";
    const SETTLED_MS = TIMINGS.registerGraceMs + 150;

    function pending(waiting: Promise<unknown>) {
      return Promise.race([waiting, sleep(0).then(() => STILL_WAITING)]);
    }

    async function connectFirst(harness: Harness) {
      const first = await harness.login("control-1:1");
      await harness.newProxy("run-1");
      await sleep(300);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
      return first;
    }

    async function replaceControl(
      harness: Harness,
      previous: PassThrough,
      index: number,
    ) {
      previous.destroy();
      harness.frps.unregister(PROXY_NAME);
      await sleep(20);
      const next = await harness.login(`control-${index}:1`, "run-1");
      await harness.newProxy("run-1");
      return next;
    }

    async function chainOfControls(harness: Harness, controls: number) {
      let current = await connectFirst(harness);
      for (let index = 2; index <= controls; index += 1) {
        current = await replaceControl(harness, current, index);
      }
    }

    it("keeps a waiting request when a new client logs in before the old proxy's removal check", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      const first = await connectFirst(harness);

      first.destroy();
      harness.frps.unregister(PROXY_NAME);
      await sleep(20);
      await harness.proxyCall("CloseProxy", "run-1");
      const waiting = harness.directory.awaitReturn(SUBDOMAIN, signal);
      await harness.login("second:1");
      await sleep(REMOVAL_SETTLE_MS + 200);
      expect(await pending(waiting)).toBe(STILL_WAITING);

      await harness.newProxy("run-2");
      expect(await waiting).toEqual({ kind: "here" });
    });

    it("keeps a waiting request when the same run reconnects before the removal check", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      const first = await connectFirst(harness);

      first.destroy();
      harness.frps.unregister(PROXY_NAME);
      await sleep(20);
      await harness.proxyCall("CloseProxy", "run-1");
      const waiting = harness.directory.awaitReturn(SUBDOMAIN, signal);
      await harness.login("second:1", "run-1");
      await sleep(REMOVAL_SETTLE_MS + 200);
      expect(await pending(waiting)).toBe(STILL_WAITING);

      await harness.newProxy("run-1");
      expect(await waiting).toEqual({ kind: "here" });
    });

    it("stops waiting for a proxy its still-connected client closed", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      await connectFirst(harness);

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      expect(await harness.directory.awaitReturn(SUBDOMAIN, signal)).toEqual({
        kind: "offline",
      });
    });

    it("does not end the wait when a hook payload carries no run id", async () => {
      const harness = await startHooks();
      const abort = new AbortController();
      await harness.login("control-1:1");
      await harness.proxyCall("NewProxy");
      harness.frps.register(PROXY_NAME, "");
      await sleep(300);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy");
      const waiting = harness.directory.awaitReturn(SUBDOMAIN, abort.signal);
      await sleep(REMOVAL_SETTLE_MS + 200);
      expect(await pending(waiting)).toBe(STILL_WAITING);
      abort.abort();
      expect(await waiting).toEqual({ kind: "offline" });
    });

    it("keeps the replacement routed when the replaced control's close arrives after its new proxy", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      const first = await connectFirst(harness);
      await replaceControl(harness, first, 2);
      const waiting = harness.directory.awaitReturn(SUBDOMAIN, signal);

      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(REMOVAL_SETTLE_MS + 200);
      expect(await waiting).toEqual({ kind: "here" });
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
    });

    it("keeps an already routed replacement when the replaced control's close arrives late", async () => {
      const harness = await startHooks();
      const first = await connectFirst(harness);
      await replaceControl(harness, first, 2);
      await sleep(300);

      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(REMOVAL_SETTLE_MS + 200);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
    });

    it("still ends the replacement's own close after a replaced control's close was kept out", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      const first = await connectFirst(harness);
      await replaceControl(harness, first, 2);
      await sleep(300);
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(SETTLED_MS);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      expect(await harness.directory.awaitReturn(SUBDOMAIN, signal)).toEqual({
        kind: "offline",
      });
    });

    for (const controls of [3, 4]) {
      for (const delivery of [
        "after the newest proxy",
        "after each next proxy",
      ]) {
        it(`keeps the newest of ${controls} same-run controls routed when the older closes arrive ${delivery}`, async () => {
          const harness = await startHooks();
          const signal = new AbortController().signal;
          let current = await connectFirst(harness);
          for (let index = 2; index <= controls; index += 1) {
            current = await replaceControl(harness, current, index);
            if (delivery === "after each next proxy") {
              await harness.proxyCall("CloseProxy", "run-1");
            }
          }
          const waiting = harness.directory.awaitReturn(SUBDOMAIN, signal);
          if (delivery === "after the newest proxy") {
            for (let late = 1; late < controls; late += 1) {
              await harness.proxyCall("CloseProxy", "run-1");
            }
          }
          await sleep(REMOVAL_SETTLE_MS + 200);
          expect(await waiting).toEqual({ kind: "here" });
          expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");

          harness.frps.unregister(PROXY_NAME);
          await harness.proxyCall("CloseProxy", "run-1");
          expect(
            await harness.directory.awaitReturn(SUBDOMAIN, signal),
          ).toEqual({
            kind: "offline",
          });
        });
      }
    }

    it("keeps the newest control routed when one older close is lost and another arrives", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      await chainOfControls(harness, 3);
      const waiting = harness.directory.awaitReturn(SUBDOMAIN, signal);

      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(REMOVAL_SETTLE_MS + 200);
      expect(await waiting).toEqual({ kind: "here" });
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      expect(await harness.directory.awaitReturn(SUBDOMAIN, signal)).toEqual({
        kind: "offline",
      });
    });

    it("removes the record when the newest control's close arrives before the older ones", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      await chainOfControls(harness, 3);
      await sleep(300);

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(SETTLED_MS);
      expect(harness.directory.locate(SUBDOMAIN).kind).not.toBe("here");

      await harness.proxyCall("CloseProxy", "run-1");
      await harness.proxyCall("CloseProxy", "run-1");
      expect(await harness.directory.awaitReturn(SUBDOMAIN, signal)).toEqual({
        kind: "offline",
      });
    });

    it("removes a record whose close was lost once frps no longer lists the proxy", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      await connectFirst(harness);

      harness.frps.unregister(PROXY_NAME);
      await sleep(TIMINGS.reconcileMs + TIMINGS.registerGraceMs + 200);
      expect(await harness.directory.awaitReturn(SUBDOMAIN, signal)).toEqual({
        kind: "offline",
      });
    });

    it("keeps a record frps still lists when its close was a stale one, across reconciles", async () => {
      const harness = await startHooks();
      await connectFirst(harness);

      await sleep(TIMINGS.reconcileMs * 2 + 100);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
    });

    it("keeps the record while frps cannot be asked, and removes it once frps says it is gone", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      await connectFirst(harness);

      harness.frps.down = true;
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(TIMINGS.stateRetryMs * 3);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");

      harness.frps.unregister(PROXY_NAME);
      harness.frps.down = false;
      await sleep(TIMINGS.stateRetryMs * 3);
      expect(await harness.directory.awaitReturn(SUBDOMAIN, signal)).toEqual({
        kind: "offline",
      });
    });

    it("asks again when another close arrives while frps is being asked", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      await connectFirst(harness);

      let release = () => {};
      harness.frps.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(SETTLED_MS);
      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      harness.frps.gate = null;
      release();
      await sleep(SETTLED_MS);
      expect(await harness.directory.awaitReturn(SUBDOMAIN, signal)).toEqual({
        kind: "offline",
      });
    });

    it("never removes a record because frps could not answer, however many times", async () => {
      const harness = await startHooks();
      await connectFirst(harness);

      harness.frps.unknownAnswers = 15;
      await harness.proxyCall("CloseProxy", "run-1");
      await waitUntil(() => harness.frps.unknownAnswers === 0);
      await sleep(TIMINGS.reconcileMs * 2);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
    });

    it("removes a record after unanswered questions once a listing shows frps dropped it", async () => {
      const harness = await startHooks();
      const signal = new AbortController().signal;
      await connectFirst(harness);

      harness.frps.unregister(PROXY_NAME);
      harness.frps.unknownAnswers = 15;
      await harness.proxyCall("CloseProxy", "run-1");
      await waitUntil(() => harness.frps.unknownAnswers === 0);
      await waitUntil(
        () => harness.directory.locate(SUBDOMAIN).kind !== "here",
      );
      expect(await harness.directory.awaitReturn(SUBDOMAIN, signal)).toEqual({
        kind: "offline",
      });
    });

    it("keeps a record whose proxy frps lists under an id no record owns", async () => {
      const harness = await startHooks();
      await connectFirst(harness);

      harness.frps.unregister(PROXY_NAME);
      harness.frps.register(PROXY_NAME, "stranger");
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(TIMINGS.reconcileMs * 3);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
    });

    it("refuses a login that names a client id other than its run id", async () => {
      const harness = await startHooks();
      const login = (content: Record<string, unknown>) =>
        harness.ask("Login", {
          user: "bee",
          metas: harness.metas,
          client_address: "x:1",
          ...content,
        });

      expect(await login({ client_id: "run-1" })).toMatchObject({
        reject: true,
      });
      expect(
        await login({ client_id: "run-2", run_id: "run-1" }),
      ).toMatchObject({
        reject: true,
      });
      expect(
        await login({ client_id: "run-1", run_id: "run-1" }),
      ).toMatchObject({
        reject: false,
      });
      expect(await login({})).toMatchObject({ reject: false });
      expect(await login({ run_id: "run-9" })).toMatchObject({
        reject: false,
      });
    });

    it("refuses a login that reuses a run id another label holds", async () => {
      const harness = await startHooks();
      await connectFirst(harness);

      const stolen = await harness.ask("Login", {
        user: "wasp",
        metas: harness.metas,
        run_id: "run-1",
        client_address: "x:2",
      });
      expect(stolen).toMatchObject({ reject: true });
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
    });

    function slowAccounts() {
      let release: () => void = () => {};
      const opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      const accounts: AccountApi = {
        resolve: async () => {
          await opened;
          return { ...OWNED, credential: true };
        },
        forget: () => {},
        presence: async () => [],
      };
      return { accounts, release };
    }

    const loginAs = (harness: Harness, user: string, runId: string) =>
      harness.ask("Login", {
        user,
        metas: harness.metas,
        run_id: runId,
        client_address: `${user}:1`,
      });

    const proxyAs = (harness: Harness, user: string, runId: string) =>
      harness.ask("NewProxy", {
        user: { user, metas: harness.metas, run_id: runId },
        proxy_name: PROXY_NAME,
        proxy_type: "http",
        subdomain: user === "bee" ? SUBDOMAIN : user,
      });

    it("refuses the second of two logins that name one run id before either registered a proxy", async () => {
      const slow = slowAccounts();
      const harness = await startHooks(slow.accounts);

      const first = loginAs(harness, "bee", "run-shared");
      await sleep(30);
      const second = await loginAs(harness, "wasp", "run-shared");
      expect(second).toMatchObject({ reject: true });

      slow.release();
      expect(await first).toMatchObject({ reject: false });
    });

    it("refuses the second of two concurrent proxies that name one run id", async () => {
      const slow = slowAccounts();
      const harness = await startHooks(slow.accounts);

      const first = proxyAs(harness, "bee", "run-shared");
      await sleep(30);
      const second = await proxyAs(harness, "wasp", "run-shared");
      expect(second).toMatchObject({ reject: true });

      slow.release();
      expect(await first).toMatchObject({ reject: false });
      harness.frps.register(PROXY_NAME, "run-shared");
      await sleep(300);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
      expect(harness.directory.locate("wasp").kind).not.toBe("here");
    });

    function gatedAccounts() {
      const held = new Map<string, Promise<void>>();
      const open = new Map<string, () => void>();
      const refusing = new Set<string>();
      const accounts: AccountApi = {
        resolve: async (request) => {
          await held.get(request.label ?? "");
          return { ...OWNED, credential: !refusing.has(request.label ?? "") };
        },
        forget: () => {},
        presence: async () => [],
      };
      return {
        accounts,
        hold(label: string) {
          held.set(
            label,
            new Promise<void>((resolve) => {
              open.set(label, resolve);
            }),
          );
        },
        release(label: string) {
          open.get(label)?.();
        },
        refuse(label: string) {
          refusing.add(label);
        },
      };
    }

    it("keeps a login-only run id bound while its control connection is open, however old, and frees it once the connection closes", async () => {
      const harness = await startHooks(LINKED_ACCOUNTS, {
        runBindingIdleMs: 150,
      });
      const control = await harness.login("control-7:1", "run-7");

      await sleep(TIMINGS.reconcileMs * 3);
      expect(await loginAs(harness, "wasp", "run-7")).toMatchObject({
        reject: true,
      });
      expect(await proxyAs(harness, "wasp", "run-7")).toMatchObject({
        reject: true,
      });

      control.destroy();
      await sleep(TIMINGS.reconcileMs * 3);
      expect(await loginAs(harness, "wasp", "run-7")).toMatchObject({
        reject: false,
      });
    });

    it("keeps a run id bound while any of the label's controls has no run id assigned, and frees it once all have closed", async () => {
      const harness = await startHooks(LINKED_ACCOUNTS, {
        runBindingIdleMs: 150,
      });
      const first = await harness.login("control-a:1");
      const second = await harness.login("control-b:1");
      await harness.newProxy("run-r");
      await sleep(300);

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-r");
      await sleep(TIMINGS.reconcileMs * 3);
      expect(await loginAs(harness, "wasp", "run-r")).toMatchObject({
        reject: true,
      });
      expect(await proxyAs(harness, "wasp", "run-r")).toMatchObject({
        reject: true,
      });

      first.destroy();
      await sleep(TIMINGS.reconcileMs * 3);
      expect(await loginAs(harness, "wasp", "run-r")).toMatchObject({
        reject: true,
      });

      second.destroy();
      await sleep(TIMINGS.reconcileMs * 3);
      expect(await loginAs(harness, "wasp", "run-r")).toMatchObject({
        reject: false,
      });
    });

    it("ignores a delayed close from the label that used to hold a run id another label has since claimed", async () => {
      const harness = await startHooks(LINKED_ACCOUNTS, {
        runBindingIdleMs: 150,
      });
      const control = await connectFirst(harness);

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      control.destroy();
      await sleep(TIMINGS.reconcileMs * 3);
      expect(await loginAs(harness, "wasp", "run-1")).toMatchObject({
        reject: false,
      });
      expect(await proxyAs(harness, "wasp", "run-1")).toMatchObject({
        reject: false,
      });
      harness.frps.register(PROXY_NAME, "run-1");

      harness.frps.offlineAnswers = 1;
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(TIMINGS.registerGraceMs + 200);

      expect(harness.directory.locate("wasp").kind).toBe("here");
      expect(await loginAs(harness, "bee", "run-1")).toMatchObject({
        reject: true,
      });
      expect(harness.frps.offlineAnswers).toBe(1);
    });

    it("keeps a reconnecting run id bound while an older close settles and another label asks for it", async () => {
      const gate = gatedAccounts();
      const harness = await startHooks(gate.accounts);
      await connectFirst(harness);

      gate.hold("bee");
      const reconnect = proxyAs(harness, "bee", "run-1");
      await sleep(30);
      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(TIMINGS.registerGraceMs + 200);

      expect(await loginAs(harness, "wasp", "run-1")).toMatchObject({
        reject: true,
      });
      expect(await proxyAs(harness, "wasp", "run-1")).toMatchObject({
        reject: true,
      });

      gate.release("bee");
      expect(await reconnect).toMatchObject({ reject: false });
      harness.frps.register(PROXY_NAME, "run-1");
      await sleep(300);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
      expect(harness.directory.locate("wasp").kind).not.toBe("here");
    });

    it("frees the run id when the pending claim that kept it is refused after its record closed", async () => {
      const gate = gatedAccounts();
      const harness = await startHooks(gate.accounts);
      const control = await connectFirst(harness);

      gate.hold("bee");
      gate.refuse("bee");
      const reconnect = proxyAs(harness, "bee", "run-1");
      await sleep(30);
      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(TIMINGS.registerGraceMs + 200);
      expect(await loginAs(harness, "wasp", "run-1")).toMatchObject({
        reject: true,
      });

      control.destroy();
      await sleep(50);
      gate.release("bee");
      expect(await reconnect).toMatchObject({ reject: true });
      expect(await loginAs(harness, "wasp", "run-1")).toMatchObject({
        reject: false,
      });
    });

    it.each([
      { first: "bee", second: "wasp" },
      { first: "wasp", second: "bee" },
    ])(
      "never lets $second take over a run id that $first claimed first, whichever check finishes first",
      async ({ first, second }) => {
        const gate = gatedAccounts();
        const harness = await startHooks(gate.accounts);
        gate.hold(first);
        gate.hold(second);

        const early = proxyAs(harness, first, "run-9");
        await sleep(30);
        const late = proxyAs(harness, second, "run-9");
        gate.release(second);
        expect(await late).toMatchObject({ reject: true });
        gate.release(first);
        expect(await early).toMatchObject({ reject: false });

        harness.frps.register(PROXY_NAME, "run-9");
        await sleep(300);
        const firstSubdomain = first === "bee" ? SUBDOMAIN : first;
        const secondSubdomain = second === "bee" ? SUBDOMAIN : second;
        expect(harness.directory.locate(firstSubdomain).kind).toBe("here");
        expect(harness.directory.locate(secondSubdomain).kind).not.toBe("here");
      },
    );

    it("refuses another label's proxy under a registered key and keeps the first route", async () => {
      const harness = await startHooks();
      await connectFirst(harness);

      const refused = await proxyAs(harness, "wasp", "run-1");
      expect(refused).toMatchObject({ reject: true });
      await sleep(300);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
      expect(harness.directory.locate("wasp").kind).not.toBe("here");
    });

    it("lets the owner reconnect under its own run id", async () => {
      const harness = await startHooks();
      await connectFirst(harness);

      expect(await loginAs(harness, "bee", "run-1")).toMatchObject({
        reject: false,
      });
      expect(await proxyAs(harness, "bee", "run-1")).toMatchObject({
        reject: false,
      });
      await sleep(300);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");
    });

    it("keeps a run id bound after its last proxy is gone while its control is open, and releases it once the control closes", async () => {
      const harness = await startHooks(LINKED_ACCOUNTS, {
        runBindingIdleMs: 150,
      });
      const control = await connectFirst(harness);
      expect(await loginAs(harness, "wasp", "run-1")).toMatchObject({
        reject: true,
      });

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(TIMINGS.reconcileMs * 3);

      expect(await loginAs(harness, "wasp", "run-1")).toMatchObject({
        reject: true,
      });
      expect(await proxyAs(harness, "wasp", "run-1")).toMatchObject({
        reject: true,
      });

      control.destroy();
      await sleep(TIMINGS.reconcileMs * 3);

      expect(await loginAs(harness, "wasp", "run-1")).toMatchObject({
        reject: false,
      });
    });

    it("releases a run id whose login was refused by the account check", async () => {
      const harness = await startHooks({
        resolve: async (request) => ({
          ...OWNED,
          credential: request.label !== "bee",
        }),
        forget: () => {},
        presence: async () => [],
      });
      expect(await loginAs(harness, "bee", "run-x")).toMatchObject({
        reject: true,
      });
      expect(await loginAs(harness, "wasp", "run-x")).toMatchObject({
        reject: false,
      });
    });

    it("drops an older run's record when frps lists the proxy under another run's record", async () => {
      const harness = await startHooks();
      await harness.login("control-1:1");
      await harness.newProxy("run-1");
      await sleep(300);

      harness.frps.unregister(PROXY_NAME);
      await harness.login("control-2:1");
      await harness.newProxy("run-2");
      await sleep(300);
      await harness.proxyCall("CloseProxy", "run-1");
      await sleep(SETTLED_MS);
      expect(harness.directory.locate(SUBDOMAIN).kind).toBe("here");

      harness.frps.unregister(PROXY_NAME);
      await harness.proxyCall("CloseProxy", "run-2");
      await sleep(SETTLED_MS);
      expect(harness.directory.locate(SUBDOMAIN).kind).not.toBe("here");
    });
  });
});

describe("tunnel directory", () => {
  it("holds a label while any of its proxies is online", () => {
    const directory = createLocalDirectory();
    const events: string[] = [];
    directory.onLabelPresence((label, state) =>
      events.push(`${label}:${state}`),
    );
    directory.connected({
      label: "bee",
      subdomain: "bee--3000",
      clientId: "a",
    });
    expect(events).toEqual(["bee:connected"]);
    expect(directory.onlineLabels()).toEqual(["bee"]);
    directory.connected({ label: "bee", subdomain: "bee", clientId: "b" });
    directory.connected({ label: "bee", subdomain: "bee", clientId: "c" });
    directory.disconnected({ label: "bee", subdomain: "bee", clientId: "b" });
    expect(directory.locate("bee").kind).toBe("here");
    directory.disconnected({ label: "bee", subdomain: "bee", clientId: "c" });
    expect(events).toEqual(["bee:connected"]);
    directory.disconnected({
      label: "bee",
      subdomain: "bee--3000",
      clientId: "a",
    });
    expect(events).toEqual(["bee:connected", "bee:disconnected"]);
    expect(directory.onlineLabels()).toEqual([]);
  });

  it("stops waiting for a machine share its still-connected client removed", async () => {
    const directory = createLocalDirectory({ graceMs: 60_000 });
    const signal = new AbortController().signal;
    const share = { label: "air", subdomain: "air--3000", clientId: "a" };
    directory.connected(share);
    directory.disconnected(share);
    const waiting = directory.awaitReturn("air--3000", signal);
    directory.removed("air--3000");
    expect(await waiting).toEqual({ kind: "offline" });
    expect(await directory.awaitReturn("air--3000", signal)).toEqual({
      kind: "offline",
    });
    directory.connected(share);
    directory.connected({ ...share, subdomain: "air--4000" });
    directory.disconnected(share);
    expect(await directory.awaitReturn("air--3000", signal)).toEqual({
      kind: "offline",
    });
  });

  it("waits only within the grace after a drop", async () => {
    let clock = 0;
    const directory = createLocalDirectory({
      graceMs: 1_000,
      now: () => clock,
    });
    const signal = new AbortController().signal;
    expect(await directory.awaitReturn("bee", signal)).toEqual({
      kind: "offline",
    });
    directory.connected({ label: "bee", subdomain: "bee", clientId: "a" });
    directory.disconnected({ label: "bee", subdomain: "bee", clientId: "a" });
    const waiting = directory.awaitReturn("bee", signal);
    directory.connected({ label: "bee", subdomain: "bee", clientId: "b" });
    expect(await waiting).toEqual({ kind: "here" });
    directory.disconnected({ label: "bee", subdomain: "bee", clientId: "b" });
    clock = 1_001;
    expect(await directory.awaitReturn("bee", signal)).toEqual({
      kind: "offline",
    });
  });

  it("does not wait for a share its still-connected client closed", async () => {
    const clock = 0;
    const directory = createLocalDirectory({
      graceMs: 60_000,
      now: () => clock,
    });
    const signal = new AbortController().signal;
    const share = { label: "bee", subdomain: "bee--3000", clientId: "a" };
    directory.connected({ label: "bee", subdomain: "bee", clientId: "a" });
    directory.connected(share);
    directory.disconnected(share);
    expect(await directory.awaitReturn("bee--3000", signal)).toEqual({
      kind: "offline",
    });

    directory.connected(share);
    directory.disconnected(share);
    directory.disconnected({ label: "bee", subdomain: "bee", clientId: "a" });
    const waiting = directory.awaitReturn("bee--3000", signal);
    directory.connected({ label: "bee", subdomain: "bee", clientId: "b" });
    directory.connected({ ...share, clientId: "b" });
    expect(await waiting).toEqual({ kind: "here" });
  });
});

function presenceRecorder(failFirst = 0) {
  const calls: { at: number; reports: GatePresenceRequest[] }[] = [];
  let failures = failFirst;
  const accounts: AccountApi = {
    resolve: () => Promise.reject(new Error("unused")),
    forget: () => {},
    async presence(reports) {
      calls.push({ at: Date.now(), reports });
      if (failures > 0) {
        failures -= 1;
        throw new Error("account API answered HTTP 502");
      }
      return reports.map(() => "recorded" as const);
    },
  };
  return { calls, accounts };
}

function connectLabel(
  directory: ReturnType<typeof createLocalDirectory>,
  label: string,
): void {
  directory.connected({ label, subdomain: label, clientId: label });
}

describe("presence", () => {
  it("coalesces events per label into one batch per flush", async () => {
    const { calls, accounts } = presenceRecorder();
    const directory = createLocalDirectory();
    const presence = startPresence({
      accounts,
      directory,
      region: "sjc",
      gateMachineId: "m1",
      refreshMs: 60_000,
      flushMs: 50,
      log: silentLog,
    });
    connectLabel(directory, "a");
    connectLabel(directory, "b");
    connectLabel(directory, "c");
    directory.disconnected({ label: "c", subdomain: "c", clientId: "c" });
    await waitUntil(() => calls.length > 0);
    await presence.settle();
    expect(calls).toHaveLength(1);
    expect(
      calls[0]?.reports.map((report) => `${report.label}:${report.state}`),
    ).toEqual(["a:connected", "b:connected", "c:disconnected"]);
    expect(calls[0]?.reports[0]).toMatchObject({
      region: "sjc",
      gateMachineId: "m1",
    });
    await presence.stop(100);
  });

  it("spreads refreshes over the interval instead of sending them at once", async () => {
    const { calls, accounts } = presenceRecorder();
    const directory = createLocalDirectory();
    const refreshMs = 600;
    const presence = startPresence({
      accounts,
      directory,
      region: "sjc",
      gateMachineId: "m1",
      refreshMs,
      flushMs: 20,
      log: silentLog,
    });
    const started = Date.now();
    for (let index = 0; index < 60; index += 1) {
      connectLabel(directory, `l${index}`);
    }
    await new Promise((resolve) => setTimeout(resolve, refreshMs + 100));
    const refreshes = calls.slice(1);
    await presence.stop(100);
    const labels = new Set(
      refreshes.flatMap((call) => call.reports.map((report) => report.label)),
    );
    expect(labels.size).toBe(60);
    expect(refreshes.length).toBeGreaterThanOrEqual(5);
    expect(
      Math.max(...refreshes.map((call) => call.reports.length)),
    ).toBeLessThan(30);
    expect(refreshes[0]!.at - started).toBeGreaterThanOrEqual(
      refreshMs / 2 - 30,
    );
  });

  it("retries a failed batch with the newest state of each label", async () => {
    const { calls, accounts } = presenceRecorder(1);
    const directory = createLocalDirectory();
    const presence = startPresence({
      accounts,
      directory,
      region: "sjc",
      gateMachineId: "m1",
      refreshMs: 60_000,
      flushMs: 20,
      log: silentLog,
    });
    connectLabel(directory, "a");
    connectLabel(directory, "b");
    await waitUntil(() => calls.length === 1);
    directory.disconnected({ label: "a", subdomain: "a", clientId: "a" });
    await waitUntil(() => calls.length === 2);
    expect(
      calls[1]?.reports
        .map((report) => `${report.label}:${report.state}`)
        .sort(),
    ).toEqual(["a:disconnected", "b:connected"]);
    await presence.stop(100);
  });

  it("says goodbye for every held label in one go when it stops, then stays quiet", async () => {
    const { calls, accounts } = presenceRecorder();
    const directory = createLocalDirectory();
    const presence = startPresence({
      accounts,
      directory,
      region: "sjc",
      gateMachineId: "m1",
      refreshMs: 60_000,
      flushMs: 10_000,
      log: silentLog,
    });
    connectLabel(directory, "a");
    connectLabel(directory, "b");
    await presence.stop(1_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.reports.map((report) => report.state)).toEqual([
      "disconnected",
      "disconnected",
    ]);
    directory.disconnected({ label: "a", subdomain: "a", clientId: "a" });
    await presence.settle();
    expect(calls).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("ends an frp WebSocket on a frame boundary with a going-away close frame", () => {
    const head = Buffer.from(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n",
    );
    const small = Buffer.from([0x82, 0x03, 1, 2, 3]);
    const medium = Buffer.concat([
      Buffer.from([0x82, 0x7e, 0x01, 0x00]),
      Buffer.alloc(256, 7),
    ]);
    const stream = Buffer.concat([head, small, medium]);
    for (const cut of [1, 7, 40, head.length + 1, head.length + 6]) {
      const tracker = trackServerFrames();
      tracker.observe(stream.subarray(0, cut));
      tracker.observe(stream.subarray(cut));
      expect(tracker.closing()).toEqual(WEBSOCKET_GOING_AWAY);
    }
    const partial = trackServerFrames();
    partial.observe(stream.subarray(0, stream.length - 10));
    expect(partial.closing()).toEqual(
      Buffer.concat([Buffer.alloc(10), WEBSOCKET_GOING_AWAY]),
    );
    const midHeader = trackServerFrames();
    midHeader.observe(Buffer.concat([head, small, medium.subarray(0, 3)]));
    expect(midHeader.closing()).toEqual(Buffer.alloc(0));
    const beforeUpgrade = trackServerFrames();
    beforeUpgrade.observe(head.subarray(0, 10));
    expect(beforeUpgrade.closing()).toEqual(Buffer.alloc(0));
  });

  it("compresses large dynamic bodies with a cheaper brotli quality", async () => {
    expect(brotliQuality({ length: 200_000, stored: false })).toBe(
      LARGE_BROTLI_QUALITY,
    );
    expect(brotliQuality({ length: null, stored: false })).toBe(
      LARGE_BROTLI_QUALITY,
    );
    expect(
      brotliQuality({ length: LARGE_DYNAMIC_BYTES - 1, stored: false }),
    ).toBe(5);
    expect(brotliQuality({ length: 200_000, stored: true })).toBe(
      STORED_BROTLI_QUALITY,
    );
    const body = Buffer.from(
      JSON.stringify(
        Array.from({ length: 3_000 }, (_, index) => ({
          index,
          name: `row-${index}`,
        })),
      ),
    );
    for (const length of [body.length, null]) {
      const encoder = compressor("br", { length, stored: false });
      const chunks: Buffer[] = [];
      encoder.on("data", (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise((resolve) => encoder.on("end", resolve));
      encoder.end(body);
      await ended;
      expect(brotliDecompressSync(Buffer.concat(chunks))).toEqual(body);
    }
    expect(
      brotliCompressSync(body, {
        params: { [constants.BROTLI_PARAM_QUALITY]: LARGE_BROTLI_QUALITY },
      }).length,
    ).toBeLessThan(body.length / 4);
  });

  it("tells the LRU's owner about every entry it drops", () => {
    const dropped: string[] = [];
    const lru = new Lru<string>({
      maxEntries: 2,
      maxBytes: 100,
      sizeOf: () => 1,
      onDelete: (key) => dropped.push(key),
    });
    lru.set("a", "1", 10);
    lru.set("b", "2", 100);
    lru.set("c", "3", 100);
    expect(lru.get("b", 50)).toBe("2");
    expect(lru.get("c", 200)).toBeUndefined();
    lru.delete("b");
    expect(dropped).toEqual(["a", "c", "b"]);
    expect(lru.peek("b")).toBeUndefined();
  });

  it("bounds the LRU by entries and bytes", () => {
    const lru = new Lru<string>({
      maxEntries: 3,
      maxBytes: 10,
      sizeOf: (v) => v.length,
    });
    lru.set("a", "aaaa", 100);
    lru.set("b", "bbbb", 100);
    lru.get("a", 0);
    lru.set("c", "cccc", 100);
    expect(lru.get("b", 0)).toBeUndefined();
    expect(lru.get("a", 0)).toBe("aaaa");
    expect(lru.totalBytes).toBe(8);
    expect(lru.get("a", 100)).toBeUndefined();
    lru.set("huge", "x".repeat(11), 100);
    expect(lru.get("huge", 0)).toBeUndefined();
  });

  it("picks encodings by q-value", () => {
    expect(preferredEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(preferredEncoding("gzip, br;q=0")).toBe("gzip");
    expect(preferredEncoding("identity")).toBe("identity");
    expect(preferredEncoding(undefined)).toBe("identity");
    expect(preferredEncoding("*")).toBe("br");
  });

  it("compresses only text-like bodies the origin left alone", () => {
    const json = [["content-type", "application/json"]] as [string, string][];
    expect(shouldCompress("GET", 200, json)).toBe(true);
    expect(shouldCompress("HEAD", 200, json)).toBe(false);
    expect(shouldCompress("GET", 304, json)).toBe(false);
    expect(
      shouldCompress("GET", 200, [...json, ["content-encoding", "br"]]),
    ).toBe(false);
    expect(
      shouldCompress("GET", 200, [...json, ["content-length", "20"]]),
    ).toBe(false);
    expect(
      shouldCompress("GET", 200, [["content-type", "text/event-stream"]]),
    ).toBe(false);
    expect(shouldCompress("GET", 200, [["content-type", "image/png"]])).toBe(
      false,
    );
    expect(
      shouldCompress("GET", 200, [...json, ["cache-control", "no-transform"]]),
    ).toBe(false);
  });

  it("filters platform cookies both ways", () => {
    expect(
      tenantCookies(
        "__Secure-better-auth.session_token=a; theme=dark; bb-connect.desktop_session=b",
      ),
    ).toBe("theme=dark");
    expect(tenantCookies("better-auth.session_token=a")).toBeNull();
    expect(isTenantSetCookie("kept=1; Path=/")).toBe(true);
    expect(isTenantSetCookie("x=1; Domain=getbb.app")).toBe(false);
    expect(isTenantSetCookie("__Secure-bb-connect.x=1")).toBe(false);
    expect(isTenantSetCookie("a=1, b=2")).toBe(false);
  });

  it("recognises the local MCP path in disguise", () => {
    expect(isMcpLocalPath("/api/v1/plugins/bb--mcp/http/mcp")).toBe(true);
    expect(isMcpLocalPath("/x/../API/v1/plugins/bb--mcp/http/%256dcp")).toBe(
      true,
    );
    expect(isMcpLocalPath("/api/v1/plugins/bb--mcp/http/mcpx")).toBe(false);
  });

  it("reads its configuration from the environment", () => {
    const key = JSON.stringify({
      kid: "k1",
      kty: "OKP",
      crv: "Ed25519",
      x: "x",
      d: "d",
    });
    const config = configFromEnv({
      ACCOUNT_API_URL: "https://connect.getbb.app",
      GATE_SECRET: "s",
      GATE_SIGNING_KEY: key,
    });
    expect(config).toMatchObject({
      baseDomain: "next.getbb.app",
      scheme: "https",
      accountAppUrl: "https://getbb.app",
      ports: { web: 8080, frpTcp: null },
    });
    expect(() =>
      configFromEnv({
        ACCOUNT_API_URL: "https://x.test/path",
        GATE_SECRET: "s",
        GATE_SIGNING_KEY: key,
      }),
    ).toThrow("ACCOUNT_API_URL");
    expect(() =>
      configFromEnv({
        ACCOUNT_API_URL: "https://x.test",
        GATE_SECRET: "s",
        GATE_SIGNING_KEY: "{}",
      }),
    ).toThrow("GATE_SIGNING_KEY");
  });
});

describe("machine label proxy", () => {
  it("posts the body with the machine credential and passes the answer through", async () => {
    const seen: Array<{
      url: string;
      credential: string | null;
      body: string;
    }> = [];
    const proxy = createMachineLabelProxy({
      accountApiUrl: "https://connect.getbb.app",
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          credential: new Headers(init?.headers).get("x-bb-connect-machine"),
          body: new TextDecoder().decode(init?.body as Uint8Array),
        });
        return Response.json({ label: "laptop" }, { status: 200 });
      },
    });
    const answer = await proxy.assign(
      "cred-machine",
      Buffer.from('{"desiredName":"Laptop"}'),
    );
    expect(seen).toEqual([
      {
        url: "https://connect.getbb.app/api/connect/machine-label",
        credential: "cred-machine",
        body: '{"desiredName":"Laptop"}',
      },
    ]);
    expect(answer.status).toBe(200);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(answer.body.toString())).toEqual({ label: "laptop" });
  });
});
