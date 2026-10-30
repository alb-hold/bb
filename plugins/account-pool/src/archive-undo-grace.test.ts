import {
  archiveThread,
  createConnection,
  createThread,
  ensurePersonalProject,
  getThread,
  markThreadDeleted,
  migrate,
  noopNotifier,
  unarchiveThread,
} from "@bb/db";
import { ARCHIVE_UNDO_GRACE_MS } from "@bb/domain";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusReportSchema } from "./contracts.js";
import { createAccountPoolPlugin } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture() {
  const db = createConnection(":memory:");
  migrate(db);
  const project = ensurePersonalProject(db);
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
    status: "active",
  });
  let clock = Date.now();
  const dataDir = await mkdtemp(path.join(tmpdir(), "pool-archive-grace-"));
  const readThread = () => {
    const current = getThread(db, thread.id);
    if (current === null) throw new Error("Missing thread fixture");
    return makeThreadResponse(current);
  };
  const host = createFakePluginHost({
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
    db.$client.close();
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
      projectId: project.id,
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
    const archived = archiveThread(db, noopNotifier, thread.id);
    if (archived?.archivedAt === null || archived === null)
      throw new Error("Archive failed");
    clock = archived.archivedAt;
    expect(
      await host.harness.behavior.emitThreadEvent("thread.archived", {
        thread: readThread(),
      }),
    ).toEqual({ errors: [] });
  };
  return {
    db,
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
    expect(unarchiveThread(f.db, noopNotifier, f.thread.id)).not.toBeNull();
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
    f.db.$client
      .prepare("UPDATE threads SET status = ? WHERE id = ?")
      .run("idle", f.thread.id);
    await f.archive();
    expect(await f.request()).toBe(401);
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("revokes when the archived turn stops inside the grace", async () => {
    const f = await fixture();
    await f.archive();
    expect(await f.request()).toBe(200);
    f.db.$client
      .prepare("UPDATE threads SET status = ? WHERE id = ?")
      .run("idle", f.thread.id);
    expect(await f.request()).toBe(401);
    expect(f.upstream).toHaveBeenCalledTimes(1);
  });

  it("revokes when the thread is deleted inside the grace", async () => {
    const f = await fixture();
    await f.archive();
    markThreadDeleted(f.db, noopNotifier, { threadId: f.thread.id });
    expect(await f.request()).toBe(401);
    expect(f.upstream).not.toHaveBeenCalled();
  });
});
