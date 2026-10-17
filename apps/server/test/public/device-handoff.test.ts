import { afterEach, describe, expect, it } from "vitest";
import { getThread, hasActiveThreadAttention, updateThread } from "@bb/db";
import {
  createTestAppHarness,
  type TestAppHarness,
  withTestHarness,
} from "../helpers/test-app.js";
import { seedThreadFixture } from "../helpers/seed.js";

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
  it("marks the source thread unread when no client is viewing it", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { title: "Pending handoff source" },
      });
      updateThread(harness.db, harness.hub, thread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });

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
      expect(
        getThread(harness.db, thread.id)?.latestAttentionAt,
      ).toBeGreaterThan(1);
      expect(hasActiveThreadAttention(harness.db)).toBe(true);
    });
  });
});
