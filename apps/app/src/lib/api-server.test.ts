import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVICE_HANDOFF_CLIENT_TOKEN_HEADER } from "@bb/server-contract";
import { fetchWithDeviceHandoffSubmission } from "./api-server";
import { wsManager } from "./ws";

describe("device handoff submission headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("binds turn submissions to the current app device", async () => {
    vi.spyOn(wsManager, "getDeviceHandoffClientToken").mockReturnValue(
      "0123456789abcdefghijk_",
    );
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
    expect(wsManager.waitForDeviceHandoffClientToken).not.toHaveBeenCalled();
    for (const [, init] of fetch.mock.calls) {
      expect(
        new Headers(init?.headers).get(DEVICE_HANDOFF_CLIENT_TOKEN_HEADER),
      ).toBe("0123456789abcdefghijk_");
    }
  });

  it("sends immediately with the stored identity while the websocket is down", async () => {
    vi.spyOn(wsManager, "getDeviceHandoffClientToken").mockReturnValue(
      "stored-device-identity",
    );
    const wait = vi
      .spyOn(wsManager, "waitForDeviceHandoffClientToken")
      .mockResolvedValue("stored-device-identity");
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);

    await fetchWithDeviceHandoffSubmission(
      "http://localhost/api/v1/threads/thr_cold_start/send",
      { method: "POST" },
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
        DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
      ),
    ).toBe("stored-device-identity");
    expect(wait).not.toHaveBeenCalled();
  });

  it("submits first-run turns without identity after the bounded wait expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(wsManager, "getDeviceHandoffClientToken").mockReturnValue(null);
    const wait = vi
      .spyOn(wsManager, "waitForDeviceHandoffClientToken")
      .mockImplementation(
        (timeoutMs = 0) =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("identity wait expired")),
              timeoutMs,
            );
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

    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(3_000);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await submission;
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).has(
        DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
      ),
    ).toBe(false);
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
