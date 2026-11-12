// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createDeferredPromise } from "@bb/test-helpers";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import "./lib/initial-native-terminal-request";

const preload = vi.hoisted(() => ({
  workspace: vi.fn(async (): Promise<void> => undefined),
  thread: vi.fn(async () => undefined),
}));

vi.mock("./components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./views/thread-detail/LazyThreadDetailView", () => ({
  LazyThreadDetailView: Object.assign(() => null, { preload: preload.thread }),
}));

beforeEach(() => {
  vi.resetModules();
  preload.workspace.mockReset().mockResolvedValue(undefined);
  preload.thread.mockClear();
  vi.doMock("./views/SplitWorkspaceRoute", async () => {
    await preload.workspace();
    return { default: () => <p>Workspace ready</p> };
  });
  globalThis.__bbInitialNativeTerminalRequest = undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.__bbInitialNativeTerminalRequest = undefined;
});

function initialThreadHint() {
  globalThis.__bbInitialNativeTerminalRequest = {
    path: "/api/v1/threads/thr_initial/native-terminal",
    response: Promise.resolve(new Response("{}")),
  };
}

it("keeps initial thread code off startup without a thread preload hint", async () => {
  await import("./App");
  expect(preload.workspace).not.toHaveBeenCalled();
  expect(preload.thread).not.toHaveBeenCalled();
});

it("starts the existing route loaders before the initial thread is rendered", async () => {
  initialThreadHint();
  await import("./App");
  await vi.waitFor(() => expect(preload.workspace).toHaveBeenCalledOnce());
  expect(preload.thread).toHaveBeenCalledOnce();
});

it("shares the pending preload with the rendered workspace route", async () => {
  const download = createDeferredPromise<void>();
  preload.workspace.mockImplementationOnce(() => download.promise);
  initialThreadHint();
  const performance = await import("./lib/terminal-performance");
  const trace = vi.spyOn(performance, "traceTerminalGate");
  const { AppRoutes } = await import("./App");
  await vi.waitFor(() => expect(preload.workspace).toHaveBeenCalledOnce());
  render(
    <MemoryRouter initialEntries={["/threads/thr_initial"]}>
      <AppRoutes />
    </MemoryRouter>,
  );
  expect(screen.queryByText("Workspace ready")).toBeNull();
  await act(async () => download.resolve());
  expect(await screen.findByText("Workspace ready")).toBeTruthy();
  expect(preload.workspace).toHaveBeenCalledOnce();
  expect(
    trace.mock.calls.filter(([name]) => name === "terminal-workspace-route-import"),
  ).toHaveLength(1);
});

it("retries a rejected preload when the workspace is first rendered", async () => {
  const download = createDeferredPromise<void>();
  preload.workspace.mockImplementationOnce(() => download.promise);
  initialThreadHint();
  const performance = await import("./lib/terminal-performance");
  const trace = vi.spyOn(performance, "traceTerminalGate");
  const { AppRoutes } = await import("./App");
  await vi.waitFor(() => expect(preload.workspace).toHaveBeenCalledOnce());
  await act(async () => download.reject(new Error("download interrupted")));
  vi.doMock("./views/SplitWorkspaceRoute", () => {
    preload.workspace();
    return { default: () => <p>Workspace recovered</p> };
  });
  render(
    <MemoryRouter initialEntries={["/threads/thr_initial"]}>
      <AppRoutes />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Workspace recovered")).toBeTruthy();
  expect(preload.workspace).toHaveBeenCalledTimes(2);
  expect(
    trace.mock.calls.filter(([name]) => name === "terminal-workspace-route-import"),
  ).toHaveLength(2);
});
