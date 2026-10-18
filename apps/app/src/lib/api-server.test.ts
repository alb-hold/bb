import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVICE_HANDOFF_CLIENT_TOKEN_HEADER } from "@bb/server-contract";
import { fetchWithDeviceHandoffSubmission } from "./api-server";
import { wsManager } from "./ws";

describe("device handoff submission headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("binds turn submissions to the current app device", async () => {
    vi.spyOn(wsManager, "waitForDeviceHandoffClientToken").mockResolvedValue(
      "0123456789abcdefghijk_",
    );
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);

    await fetchWithDeviceHandoffSubmission(
      "http://localhost/api/v1/threads/thr_test/send",
      { method: "POST" },
    );
    await fetchWithDeviceHandoffSubmission(
      "http://localhost/api/v1/threads/thr_test/queued-messages",
      { method: "POST" },
    );
    await fetchWithDeviceHandoffSubmission(
      "http://localhost/api/v1/threads/thr_test/steer",
      { method: "POST" },
    );

    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) {
      expect(
        new Headers(init?.headers).get(DEVICE_HANDOFF_CLIENT_TOKEN_HEADER),
      ).toBe("0123456789abcdefghijk_");
    }
  });

  it("waits for the first server-issued device identity before submitting a turn", async () => {
    let provideToken: ((token: string) => void) | undefined;
    vi.spyOn(wsManager, "waitForDeviceHandoffClientToken").mockImplementation(
      () =>
        new Promise((resolve) => {
          provideToken = resolve;
        }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);

    const submission = fetchWithDeviceHandoffSubmission(
      "http://localhost/api/v1/threads/thr_cold_start/send",
      { method: "POST" },
    );

    expect(wsManager.waitForDeviceHandoffClientToken).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    provideToken?.("0123456789abcdefghijk_");
    await submission;

    expect(fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
        DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
      ),
    ).toBe("0123456789abcdefghijk_");
  });

  it("does not attach the socket token to unrelated requests", async () => {
    vi.spyOn(wsManager, "waitForDeviceHandoffClientToken").mockResolvedValue(
      "0123456789abcdefghijk_",
    );
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);

    await fetchWithDeviceHandoffSubmission(
      "http://localhost/api/v1/threads/thr_test/read",
      { method: "POST" },
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).has(
        DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
      ),
    ).toBe(false);
  });
});
