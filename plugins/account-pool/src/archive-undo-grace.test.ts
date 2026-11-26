import { createAccountPoolTestHost } from "./test-host.js";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusReportSchema } from "./contracts.js";
import { createAccountPoolPlugin } from "./server.js";
import { HubTokenStore } from "./store.js";
import { ThreadTokenStore } from "./thread-tokens.js";

const mintedTokens: string[] = [];

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const wrappedRandomBytes = ((
    size: number,
    callback?: (err: Error | null, buf: Buffer) => void,
  ) => {
    if (callback !== undefined) {
      return actual.randomBytes(size, callback);
    }
    const bytes = actual.randomBytes(size);
    if (size === 32) {
      mintedTokens.push(bytes.toString("base64url"));
    }
    return bytes;
  }) as typeof actual.randomBytes;
  return {
    ...actual,
    randomBytes: wrappedRandomBytes,
  };
});

const ARCHIVE_UNDO_GRACE_MS = 30_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture() {
  let thread = makeThreadResponse({
    id: "thread-one",
    providerId: "claude-code",
    status: "active",
  });
  let clock = Date.now();
  const dataDir = await mkdtemp(path.join(tmpdir(), "pool-archive-grace-"));
  const readThread = () => thread;
  const setThread = (update: Partial<typeof thread>) => {
    thread = makeThreadResponse({ ...thread, ...update });
  };
  const host = createAccountPoolTestHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      threads: { get: async () => readThread() },
      system: { providerStates: async () => ({ providers: [] }) },
    },
  });
  const upstream = vi.fn<typeof fetch>(async () =>
    Response.json({ routed: true }),
  );
  await createAccountPoolPlugin({
    now: () => clock,
    env: {},
    fetch: upstream,
  })(host.bb);
  await host.harness.behavior.callRpc("account.add", {
    provider: "claude",
    source: { kind: "api-key", apiKey: "test-archive-grace-key" },
    label: null,
    priority: 100,
  });
  const service = host.harness.behavior.runService("hub");
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  await vi.waitFor(async () => {
    const result = await host.harness.behavior.runCli(["status", "--json"]);
    expect(statusReportSchema.parse(JSON.parse(result.stdout)).accepting).toBe(
      true,
    );
  });
  const entries = await host.harness.behavior.resolveProviderEnv(
    "claude-code",
    {
      threadId: thread.id,
      projectId: thread.projectId,
      hostId: "host-one",
    },
  );
  const token = entries.find(
    (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
  )?.value;
  if (typeof token !== "string") throw new Error("Missing pool credential");
  const request = async () => {
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-4-1",
          messages: [],
          max_tokens: 1,
        }),
      },
    );
    await response.text();
    return response.status;
  };
  const archive = async () => {
    setThread({ archivedAt: clock });
    expect(
      await host.harness.behavior.emitThreadEvent("thread.archived", {
        thread: readThread(),
      }),
    ).toEqual({ errors: [] });
  };
  return {
    setThread,
    host,
    thread,
    readThread,
    request,
    archive,
    upstream,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("Account Pooler archive undo grace", () => {
  it("routes an archived active thread's credential inside the undo grace", async () => {
    const f = await fixture();
    expect(await f.request()).toBe(200);
    await f.archive();
    f.advance(ARCHIVE_UNDO_GRACE_MS - 1);
    expect(await f.request()).toBe(200);
    expect(f.upstream).toHaveBeenCalledTimes(2);
  });

  it("revokes the credential at the undo grace deadline", async () => {
    const f = await fixture();
    await f.archive();
    f.advance(ARCHIVE_UNDO_GRACE_MS);
    expect(await f.request()).toBe(401);
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("keeps the same credential live after unarchiving inside the grace", async () => {
    const f = await fixture();
    await f.archive();
    f.advance(ARCHIVE_UNDO_GRACE_MS - 1);
    f.setThread({ archivedAt: null });
    expect(
      await f.host.harness.behavior.emitThreadEvent("thread.unarchived", {
        thread: f.readThread(),
      }),
    ).toEqual({ errors: [] });
    f.advance(ARCHIVE_UNDO_GRACE_MS);
    expect(await f.request()).toBe(200);
  });

  it("revokes an archived idle thread's credential immediately", async () => {
    const f = await fixture();
    f.setThread({ status: "idle" });
    await f.archive();
    expect(await f.request()).toBe(401);
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("revokes when the archived turn stops inside the grace", async () => {
    const f = await fixture();
    await f.archive();
    expect(await f.request()).toBe(200);
    f.setThread({ status: "idle" });
    expect(await f.request()).toBe(401);
    expect(f.upstream).toHaveBeenCalledTimes(1);
  });

  it("revokes when the thread is deleted inside the grace", async () => {
    const f = await fixture();
    await f.archive();
    f.setThread({ deletedAt: Date.now() });
    expect(await f.request()).toBe(401);
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("returns unrouted entries without throwing when a thread is archived or deleted while minting environment credentials", async () => {
    for (const mode of ["archived-on-thread", "archived-on-nested", "deleted-on-thread"] as const) {
      let threadReads = 0;
      const dataDir = await mkdtemp(path.join(tmpdir(), "pool-archive-mint-race-"));
      let thread = makeThreadResponse({
        id: `thread-${mode}`,
        providerId: "codex",
        status: "idle",
      });
      const host = createAccountPoolTestHost({
        pluginId: "account-pool",
        dataDir,
        sdk: {
          hosts: { list: async () => [{ id: "host-one", name: "One" }] },
          threads: {
            get: async () => {
              threadReads += 1;
              if (
                (mode === "archived-on-thread" && threadReads === 2) ||
                (mode === "archived-on-nested" && threadReads === 3)
              ) {
                thread = makeThreadResponse({
                  ...thread,
                  archivedAt: Date.now(),
                });
              }
              if (mode === "deleted-on-thread" && threadReads === 2) {
                thread = makeThreadResponse({
                  ...thread,
                  deletedAt: Date.now(),
                });
              }
              return thread;
            },
          },
          system: { providerStates: async () => ({ providers: [] }) },
        },
      });
      await createAccountPoolPlugin({
        env: {},
        codexUsageUrl: "https://usage.invalid/wham/usage",
        fetch: async () => Response.json({}),
        importCodexCredentials: async () => ({
          accessToken: "codex-access-test",
          refreshToken: "codex-refresh-test",
          idToken: null,
          accountId: "codex-acc-1",
          planType: "pro",
          email: null,
          expiresAt: Date.now() + 3_600_000,
        }),
      })(host.bb);
      cleanups.push(async () => {
        await host.harness.lifecycle.dispose();
        await rm(dataDir, { recursive: true, force: true });
      });
      await host.harness.behavior.callRpc("account.add", {
        provider: "codex",
        source: { kind: "import" },
        label: null,
        priority: 100,
      });
      const entries = await host.harness.behavior.resolveProviderEnv("codex", {
        threadId: thread.id,
        projectId: thread.projectId,
        hostId: "host-one",
      });
      expect(entries).toEqual([]);
      expect(await host.bb.storage.kv.get(`retry-route:${thread.id}`)).toBeUndefined();
    }
  });

  it("fails closed when settling a half-minted credential rejects after forNested sees an archived thread", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-mint-settle-fail-"));
    let clock = Date.now();
    let threadReads = 0;
    let failSettleLookup = true;
    let thread = makeThreadResponse({
      id: "thr_race_settle_fail",
      providerId: "claude-code",
      status: "idle",
      archivedAt: null,
    });
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({ routed: true }),
    );
    const host = createAccountPoolTestHost({
      pluginId: "account-pool",
      dataDir,
      sdk: {
        hosts: {
          list: async () => [{ id: "host-one", name: "One" }] as never[],
        },
        threads: {
          get: async () => {
            threadReads += 1;
            if (threadReads === 3) {
              thread = makeThreadResponse({
                ...thread,
                archivedAt: clock,
              });
            }
            if (failSettleLookup && threadReads >= 4) {
              throw new Error("lookup failed while settling");
            }
            return thread;
          },
        },
        system: { providerStates: async () => ({ providers: [] }) },
      },
    });
    await createAccountPoolPlugin({
      now: () => clock,
      env: {},
      fetch: upstream,
      threadSweepIntervalMs: 25,
      threadSweepRetryMs: 25,
    })(host.bb);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await rm(dataDir, { recursive: true, force: true });
    });
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "test-settle-fail-key" },
      label: null,
      priority: 100,
    });
    await vi.waitFor(async () => {
      const result = await host.harness.behavior.runCli(["status", "--json"]);
      expect(
        statusReportSchema.parse(JSON.parse(result.stdout)).accepting,
      ).toBe(true);
    });

    mintedTokens.length = 0;
    await expect(
      host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: thread.id,
        projectId: thread.projectId,
        hostId: "host-one",
      }),
    ).rejects.toThrow("lookup failed while settling");
    expect(threadReads).toBe(5);
    expect(await host.bb.storage.kv.get(`retry-route:${thread.id}`)).toBeUndefined();

    const secretDir = path.join(
      dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
    );
    const scopedFiles = (await readdir(secretDir)).filter((name) =>
      name.startsWith("scoped-route-"),
    );
    expect(scopedFiles).toHaveLength(1);
    const scopedRecord = JSON.parse(
      await readFile(path.join(secretDir, scopedFiles[0]!), "utf8"),
    ) as { threadId: string; tokenDigest: string };
    expect(scopedRecord.threadId).toBe(thread.id);
    const leakedToken = mintedTokens.find(
      (candidate) =>
        createHash("sha256").update(candidate).digest("hex") ===
        scopedRecord.tokenDigest,
    );
    expect(leakedToken).toBeDefined();

    const requestWithLeakedToken = async () => {
      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${leakedToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-opus-4-1",
            messages: [],
            max_tokens: 1,
          }),
        },
      );
      await response.text();
      return response.status;
    };

    expect(await requestWithLeakedToken()).toBe(401);

    failSettleLookup = false;
    expect(await requestWithLeakedToken()).toBe(401);

    await vi.waitFor(async () => {
      const afterSweep = await readdir(secretDir);
      expect(
        afterSweep.filter((name) => name.startsWith("archived-thread-")),
      ).toHaveLength(1);
    });
    expect(await requestWithLeakedToken()).toBe(401);
    expect(upstream).not.toHaveBeenCalled();

    const verifyHubTokens = new HubTokenStore(secretDir, () => clock);
    await verifyHubTokens.initialize();
    const verifyThreadTokens = new ThreadTokenStore(
      secretDir,
      verifyHubTokens,
      () => clock,
    );
    await verifyThreadTokens.initialize(["host-one"]);
    expect(
      await verifyThreadTokens.authenticate(leakedToken!, "claude"),
    ).toBeNull();
    expect(
      await host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: thread.id,
        projectId: thread.projectId,
        hostId: "host-one",
      }),
    ).toEqual([]);
  });
});
