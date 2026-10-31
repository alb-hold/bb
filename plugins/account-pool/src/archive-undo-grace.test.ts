import { createAccountPoolTestHost } from "./test-host.js";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusReportSchema } from "./contracts.js";
import { createAccountPoolPlugin } from "./server.js";

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
});
