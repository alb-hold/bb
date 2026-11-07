// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { takeInitialNativeTerminalResponse } from "./initial-native-terminal-request";

afterEach(() => {
  delete globalThis.__bbInitialNativeTerminalRequest;
});

it("reuses the HTML response once and preserves the early socket reader", async () => {
  const path = "/api/v1/threads/native/native-terminal";
  const response = new Response(JSON.stringify({ threadId: "native" }));
  const initial = { path, response: Promise.resolve(response) };
  globalThis.__bbInitialNativeTerminalRequest = initial;
  const reused = await takeInitialNativeTerminalResponse(
    new URL(path, location.origin),
  );
  expect(await reused?.json()).toEqual({ threadId: "native" });
  expect(await (await initial.response).clone().json()).toEqual({
    threadId: "native",
  });
  expect(
    await takeInitialNativeTerminalResponse(new URL(path, location.origin)),
  ).toBeNull();
});

it("does not consume other threads or origins and retries an unsuccessful preload", async () => {
  const path = "/api/v1/threads/native/native-terminal";
  globalThis.__bbInitialNativeTerminalRequest = {
    path,
    response: Promise.resolve(new Response(null, { status: 503 })),
  };
  expect(
    await takeInitialNativeTerminalResponse(
      new URL(path, "https://other.example"),
    ),
  ).toBeNull();
  expect(
    await takeInitialNativeTerminalResponse(
      new URL("/api/v1/threads/other/native-terminal", location.origin),
    ),
  ).toBeNull();
  expect(globalThis.__bbInitialNativeTerminalRequest.claimed).toBeUndefined();
  expect(
    await takeInitialNativeTerminalResponse(new URL(path, location.origin)),
  ).toBeNull();
});

it("honors cancellation while waiting for the preload response", async () => {
  const path = "/api/v1/threads/native/native-terminal";
  const controller = new AbortController();
  globalThis.__bbInitialNativeTerminalRequest = {
    path,
    response: Promise.resolve(new Response()),
  };
  controller.abort();
  await expect(
    takeInitialNativeTerminalResponse(
      new URL(path, location.origin),
      controller.signal,
    ),
  ).rejects.toThrow();
});
