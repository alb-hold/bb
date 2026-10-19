import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVICE_HANDOFF_CLIENT_TOKEN_HEADER } from "@bb/server-contract";
import { fetchWithDeviceHandoffSubmission } from "./api-server";

describe("device handoff submission headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function installBrowserWindow(): void {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
      crypto: globalThis.crypto,
      btoa: globalThis.btoa,
      location: { origin: "http://localhost" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }

  it("reuses one generated device id across turn submissions", async () => {
    installBrowserWindow();
    vi.resetModules();
    const [{ fetchWithDeviceHandoffSubmission }, { wsManager: freshManager }] =
      await Promise.all([import("./api-server"), import("./ws")]);
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
    const identity = freshManager.getDeviceHandoffClientToken();
    expect(identity).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    for (const [, init] of fetch.mock.calls) {
      expect(
        new Headers(init?.headers).get(DEVICE_HANDOFF_CLIENT_TOKEN_HEADER),
      ).toBe(identity);
    }
  });

  it("sends the generated first-run identity immediately before any socket connects", async () => {
    installBrowserWindow();
    vi.resetModules();
    const [{ fetchWithDeviceHandoffSubmission }, { wsManager: freshManager }] =
      await Promise.all([import("./api-server"), import("./ws")]);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);

    await fetchWithDeviceHandoffSubmission(
      "http://localhost/api/v1/threads/thr_cold_start/send",
      { method: "POST" },
    );

    const identity = freshManager.getDeviceHandoffClientToken();
    expect(identity).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(window.localStorage.getItem("bb-device-handoff-device-id")).toBe(
      identity,
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
        DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
      ),
    ).toBe(identity);
  });

  it("sends a turn when secure identity generation is unavailable", async () => {
    installBrowserWindow();
    Object.defineProperty(window, "crypto", {
      configurable: true,
      value: {
        getRandomValues: () => {
          throw new Error("secure randomness unavailable");
        },
      },
    });
    vi.resetModules();
    const [{ fetchWithDeviceHandoffSubmission }] = await Promise.all([
      import("./api-server"),
      import("./ws"),
    ]);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await fetchWithDeviceHandoffSubmission(
      "http://localhost/api/v1/threads/thr_private_mode/send",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).has(
        DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
      ),
    ).toBe(false);
  });

  it("does not attach the socket token to unrelated requests", async () => {
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
