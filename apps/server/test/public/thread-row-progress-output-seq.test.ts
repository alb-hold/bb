import {
  appendRetainedTerminalOutputChunks,
  createTerminalSession,
  getThreadRowProgressOutputSeqs,
} from "@bb/db";
import {
  threadListResponseSchema,
  threadRowStateSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture } from "../helpers/seed.js";
import {
  testLogger,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "../../src/services/threads/lifecycle-outcome.js";

async function readProgress(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/row-state`,
  );
  return threadRowStateSchema.parse(await readJson(response)).progress;
}

async function report(harness: TestAppHarness, threadId: string, body: unknown) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/row-state`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
  expect(response.status).toBe(200);
}

const set = (terminalId: string, value: number, outputSeq?: number) => ({
  action: "progress-set",
  progress: { value },
  terminalId,
  ...(outputSeq === undefined ? {} : { outputSeq }),
});

const clear = (terminalId: string, outputSeq?: number) => ({
  action: "progress-clear",
  terminalId,
  ...(outputSeq === undefined ? {} : { outputSeq }),
});

function seedTerminalWithOutput(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedThreadFixture>,
  lastSeq: number,
) {
  const terminal = createTerminalSession(harness.db, {
    cols: 80,
    daemonSessionId: fixture.session.id,
    environmentId: fixture.environment.id,
    hostId: fixture.host.id,
    initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
    rows: 24,
    status: "running",
    threadId: fixture.thread.id,
    title: "progress",
  });
  appendRetainedTerminalOutputChunks(harness.db, {
    hostId: fixture.host.id,
    terminalSessionId: terminal.id,
    chunks: Array.from({ length: lastSeq + 1 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.from(`chunk ${seq}\n`).toString("base64"),
    })),
    clock: Date.now,
  });
  return terminal;
}

describe("thread row progress output sequences", () => {
  it("applies a replayed clear that is newer than what the consumer already holds", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      await report(harness, thread.id, set("term-a", 0.6, 3));
      expect(await readProgress(harness, thread.id)).toEqual({ value: 0.6 });

      await report(harness, thread.id, set("term-a", 0.6, 3));
      await report(harness, thread.id, clear("term-a", 10));
      expect(await readProgress(harness, thread.id)).toBeNull();
    });
  });

  it("applies progress that advanced only in replay", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      await report(harness, thread.id, set("term-a", 0.4, 3));
      await report(harness, thread.id, set("term-a", 0.4, 3));
      await report(harness, thread.id, set("term-a", 0.8, 9));
      expect(await readProgress(harness, thread.id)).toEqual({ value: 0.8 });
    });
  });

  it("never lets a replayed set at or below the mark bring a closed or cleared bar back", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      await report(harness, thread.id, set("term-a", 0.6, 3));
      await report(harness, thread.id, clear("term-a", 10));
      await report(harness, thread.id, set("term-a", 0.6, 3));
      await report(harness, thread.id, set("term-a", 0.7, 10));
      expect(await readProgress(harness, thread.id)).toBeNull();
      expect(getThreadRowProgressOutputSeqs(harness.db, thread.id)).toEqual({
        "term-a": 10,
      });
    });
  });

  it("keeps a CLI clear cleared against a replay of older progress", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const { thread } = fixture;
      const terminal = seedTerminalWithOutput(harness, fixture, 9);
      await report(harness, thread.id, set(terminal.id, 0.7, 5));
      expect(await readProgress(harness, thread.id)).toEqual({ value: 0.7 });

      await report(harness, thread.id, { action: "progress-clear", force: true });
      expect(await readProgress(harness, thread.id)).toBeNull();

      await report(harness, thread.id, set(terminal.id, 0.7, 5));
      await report(harness, thread.id, set(terminal.id, 0.9, 9));
      expect(await readProgress(harness, thread.id)).toBeNull();

      await report(harness, thread.id, set(terminal.id, 0.2, 10));
      expect(await readProgress(harness, thread.id)).toEqual({ value: 0.2 });
    });
  });

  it("keeps a closed terminal's retained progress from coming back", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const { thread } = fixture;
      const terminal = seedTerminalWithOutput(harness, fixture, 7);
      await report(harness, thread.id, set(terminal.id, 0.6, 2));
      await report(harness, thread.id, clear(terminal.id));
      expect(await readProgress(harness, thread.id)).toBeNull();

      await report(harness, thread.id, set(terminal.id, 0.6, 2));
      expect(await readProgress(harness, thread.id)).toBeNull();
    });
  });

  it("raises the marks to the latest output when a turn outcome clears the row inside a transaction", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const { thread } = fixture;
      const terminal = seedTerminalWithOutput(harness, fixture, 9);
      await report(harness, thread.id, set(terminal.id, 0.3, 3));
      expect(await readProgress(harness, thread.id)).toEqual({ value: 0.3 });

      harness.db.transaction((tx) => {
        for (const type of ["run.started", "run.succeeded"] as const) {
          applyLoggedThreadLifecycleEventInTransaction(
            { db: tx, logger: testLogger },
            { event: { type }, threadId: thread.id },
          );
        }
      });
      expect(await readProgress(harness, thread.id)).toBeNull();
      expect(getThreadRowProgressOutputSeqs(harness.db, thread.id)).toEqual({
        [terminal.id]: 9,
      });

      await report(harness, thread.id, set(terminal.id, 0.6, 9));
      expect(await readProgress(harness, thread.id)).toBeNull();
      await report(harness, thread.id, set(terminal.id, 0.2, 10));
      expect(await readProgress(harness, thread.id)).toEqual({ value: 0.2 });
    });
  });

  it("tracks marks per terminal and keeps them across status updates and the thread list", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      await report(harness, thread.id, set("term-a", 0.6, 3));
      await report(harness, thread.id, set("term-b", 0.4, 1));
      await report(harness, thread.id, {
        action: "status-set",
        key: "review",
        status: { value: "Ready" },
      });
      await report(harness, thread.id, clear("term-b", 2));
      await report(harness, thread.id, { action: "clear" });
      await report(harness, thread.id, set("term-a", 0.6, 3));
      await report(harness, thread.id, set("term-b", 0.4, 1));
      expect(await readProgress(harness, thread.id)).toBeNull();

      const list = threadListResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/threads?projectId=${thread.projectId}`,
          ),
        ),
      );
      expect(list.find((entry) => entry.id === thread.id)?.rowState).toEqual({
        statuses: {},
        progress: null,
      });
    });
  });
});
