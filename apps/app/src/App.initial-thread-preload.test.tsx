// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./lib/initial-native-terminal-request";

const preload = vi.hoisted(() => ({
  workspace: vi.fn(),
  thread: vi.fn(async () => undefined),
}));

vi.mock("./views/SplitWorkspaceRoute", () => {
  preload.workspace();
  return { default: () => null };
});

vi.mock("./views/thread-detail/LazyThreadDetailView", () => ({
  LazyThreadDetailView: Object.assign(() => null, { preload: preload.thread }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  globalThis.__bbInitialNativeTerminalRequest = undefined;
});

afterEach(() => {
  globalThis.__bbInitialNativeTerminalRequest = undefined;
});

it("keeps initial thread code off startup without a thread preload hint", async () => {
  await import("./App");
  expect(preload.workspace).not.toHaveBeenCalled();
  expect(preload.thread).not.toHaveBeenCalled();
});

it("starts the existing route loaders before the initial thread is rendered", async () => {
  globalThis.__bbInitialNativeTerminalRequest = {
    path: "/api/v1/threads/thr_initial/native-terminal",
    response: Promise.resolve(new Response("{}")),
  };
  await import("./App");
  await vi.waitFor(() => expect(preload.workspace).toHaveBeenCalledOnce());
  expect(preload.thread).toHaveBeenCalledOnce();
});
