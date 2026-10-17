import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalSession,
  getTerminalAttention,
  getThread,
  hasActiveThreadAttention,
  updateThread,
} from "@bb/db";
import {
  createTestAppHarness,
  type TestAppHarness,
  withTestHarness,
} from "../helpers/test-app.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";

describe("device handoff route validation", () => {
  let harness: TestAppHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com"])(
    "rejects non-HTTP URL %s with a clear error",
    async (url) => {
      harness = await createTestAppHarness();
      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url,
          origin: { threadId: "thr_example" },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("URL must use http or https");
    },
  );

  it("rejects text larger than 1 MiB by UTF-8 byte size", async () => {
    harness = await createTestAppHarness();
    const response = await harness.app.request("/api/v1/device-handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "copy-text",
        text: "é".repeat(600_000),
        origin: { threadId: "thr_example" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("1 MiB limit");
  });

  it("rejects text larger than the schema character limit", async () => {
    harness = await createTestAppHarness();
    const response = await harness.app.request("/api/v1/device-handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "copy-text",
        text: "x".repeat(1_048_577),
        origin: { threadId: "thr_example" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid device handoff");
  });
});

describe("device handoff pending attention", () => {
  it("raises fixed, payload-free terminal attention and clears it on delivery", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const terminal = createTerminalSession(harness.db, {
        cols: 80,
        environmentId: null,
        hostId: host.id,
        daemonSessionId: session.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: thread.id,
        title: "Handoff terminal",
      });
      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://login.example.com/private-code",
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });

      expect(response.status).toBe(200);
      expect(getTerminalAttention(harness.db, terminal.id)).toMatchObject({
        body: "",
        kind: "osc-9",
        title: "Link waiting for this device",
        clearedAt: null,
      });
      expect(
        JSON.stringify(getTerminalAttention(harness.db, terminal.id)),
      ).not.toContain("private-code");

      const viewer = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(viewer, {
        kind: "thread-detail",
        threadId: thread.id,
      });

      expect(getTerminalAttention(harness.db, terminal.id)?.clearedAt).not.toBe(
        null,
      );
      expect(
        viewer.messages.some((message) =>
          message.includes("device-handoff-expired"),
        ),
      ).toBe(false);
    });
  });

  it("queues a payload-free expiry notice for the originating thread only", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const { thread: unrelatedThread } = seedThreadFixture(harness);
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now());
        const response = await harness.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "private expired text",
            origin: { threadId: thread.id },
          }),
        });
        expect(response.status).toBe(200);
        const unrelated = {
          messages: [] as string[],
          close() {},
          send(data: string) {
            this.messages.push(data);
          },
        };
        harness.hub.subscribe(unrelated, {
          kind: "thread-detail",
          threadId: unrelatedThread.id,
        });

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        const originViewer = {
          messages: [] as string[],
          close() {},
          send(data: string) {
            this.messages.push(data);
          },
        };
        harness.hub.subscribe(originViewer, {
          kind: "thread-detail",
          threadId: thread.id,
        });

        const notice = originViewer.messages.find((message) =>
          message.includes("device-handoff-expired"),
        );
        expect(notice).toBeDefined();
        expect(Object.keys(JSON.parse(notice!)).sort()).toEqual([
          "id",
          "threadId",
          "type",
        ]);
        expect(notice).not.toContain("private expired text");
        expect(unrelated.messages.join("\n")).not.toContain(
          "device-handoff-expired",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("marks the source thread unread when no client is viewing it", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { title: "Pending handoff source" },
      });
      const { thread: unrelatedThread } = seedThreadFixture(harness, {
        thread: { title: "Unrelated thread" },
      });
      updateThread(harness.db, harness.hub, thread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      updateThread(harness.db, harness.hub, unrelatedThread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      const unrelatedViewer = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(unrelatedViewer, {
        kind: "thread-detail",
        threadId: unrelatedThread.id,
      });
      const attentionObserver = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(attentionObserver, { kind: "thread-list" });

      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "private copy payload",
          origin: { threadId: thread.id },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      const urlResponse = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://login.example.com/device?code=private-url",
          origin: { threadId: thread.id },
        }),
      });
      expect(urlResponse.status).toBe(200);
      expect(await urlResponse.json()).toEqual({ delivered: 0 });
      expect(
        getThread(harness.db, thread.id)?.latestAttentionAt,
      ).toBeGreaterThan(1);
      const markerAt = getThread(harness.db, thread.id)?.latestAttentionAt;
      expect(getThread(harness.db, unrelatedThread.id)?.latestAttentionAt).toBe(
        1,
      );
      expect(hasActiveThreadAttention(harness.db)).toBe(true);
      expect(unrelatedViewer.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(
        attentionObserver.messages.some((message) =>
          message.includes(thread.id),
        ),
      ).toBe(true);
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private-url",
      );

      const originViewer = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(originViewer, {
        kind: "thread-detail",
        threadId: thread.id,
      });

      const handoffMessages = originViewer.messages.filter(
        (message) => JSON.parse(message).type === "device-handoff",
      );
      expect(handoffMessages).toHaveLength(2);
      expect(handoffMessages[0]).toContain("private copy payload");
      expect(handoffMessages[1]).toContain(
        "https://login.example.com/device?code=private-url",
      );
      expect(getThread(harness.db, thread.id)?.latestAttentionAt).toBe(1);
      expect(markerAt).toBeGreaterThan(1);
      expect(unrelatedViewer.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private-url",
      );
    });
  });

  it("clears its attention marker when an undelivered handoff expires", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { title: "Expiring handoff source" },
      });
      updateThread(harness.db, harness.hub, thread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now());
        const response = await harness.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "expire me",
            origin: { threadId: thread.id },
          }),
        });
        expect(response.status).toBe(200);
        expect(
          getThread(harness.db, thread.id)?.latestAttentionAt,
        ).toBeGreaterThan(1);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

        expect(getThread(harness.db, thread.id)?.latestAttentionAt).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
