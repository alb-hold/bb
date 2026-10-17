import { afterEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

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
