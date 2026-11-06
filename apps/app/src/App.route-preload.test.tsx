// @vitest-environment jsdom
import { sdk } from "./lib/sdk";
import { appQueryClient } from "./lib/app-query-client";
import {
  environmentProvidersQueryOptions,
  useSystemEnvironmentProviders,
} from "./hooks/queries/environment-provider-queries";
import {
  machineProvidersQueryOptions,
  useSystemMachineProviders,
} from "./hooks/queries/machine-provider-queries";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { AppRoutes, AuthCallbackRoute } from "./App";
import { startSplitPreloading } from "./lib/split-prefetch";

const downloads = await vi.hoisted(async () => {
  const { createDeferredPromise } = await import("@bb/test-helpers");
  return {
    workspace: createDeferredPromise<void>(),
    workspaceStarted: vi.fn(),
    compose: vi.fn(),
    progressive: vi.fn(),
    thread: vi.fn(),
    prefetch: vi.fn(),
  };
});
vi.mock("./lib/thread-open-prefetch", () => ({
  prefetchThreadOpen: downloads.prefetch,
}));
vi.mock("./views/SettingsView", () => ({
  SettingsView: () => <p>Settings ready</p>,
}));

vi.mock("./components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./views/SplitWorkspaceRoute", async () => {
  downloads.workspaceStarted();
  await downloads.workspace.promise;
  return { default: () => <p>Workspace ready</p> };
});
vi.mock("./components/promptbox/ProgressiveComposer", () => {
  downloads.progressive();
  return { ProgressiveComposer: () => null };
});
vi.mock("./views/RootComposeView", () => {
  downloads.compose();
  return { RootComposeView: () => <p>Compose ready</p> };
});
vi.mock("./views/thread-detail/ThreadDetailView", () => {
  downloads.thread();
  return { ThreadDetailView: () => <p>Thread ready</p> };
});

afterEach(() => {
  cleanup();
  appQueryClient.clear();
  vi.restoreAllMocks();
});

it.each([
  ["success", "Authentication completed"],
  ["error", "Authentication failed"],
])("loads the authentication result route for %s", async (status, title) => {
  render(
    <MemoryRouter initialEntries={[`/auth/callback?status=${status}`]}>
      <AuthCallbackRoute />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
  expect(downloads.workspaceStarted).not.toHaveBeenCalled();
});

it("keeps the workspace chunk off routes that do not use it", async () => {
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <AppRoutes />
    </MemoryRouter>,
  );
  await screen.findByText("Settings ready");
  expect(downloads.progressive).not.toHaveBeenCalled();
  expect(downloads.workspaceStarted).not.toHaveBeenCalled();
});

it("starts destination code before the workspace settles and keeps thread code off new-thread startup", async () => {
  const environments = vi
    .spyOn(sdk.environments, "listProviders")
    .mockResolvedValue([]);
  const machines = vi
    .spyOn(sdk.hosts, "experimental_listProviders")
    .mockResolvedValue([]);
  function Navigation() {
    const navigate = useNavigate();
    return (
      <>
        <button onClick={() => void navigate("/threads/thr_example")}>
          Open personal thread
        </button>
        <button
          onClick={() =>
            void navigate("/projects/proj_example/threads/thr_other")
          }
        >
          Open project thread
        </button>
      </>
    );
  }
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Navigation />
      <AppRoutes />
    </MemoryRouter>,
  );
  await waitFor(() => expect(downloads.compose).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(downloads.progressive).toHaveBeenCalledTimes(1));
  startSplitPreloading();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  expect(downloads.thread).not.toHaveBeenCalled();
  await waitFor(() => expect(environments).toHaveBeenCalledTimes(1));
  expect(machines).toHaveBeenCalledTimes(1);
  await appQueryClient.ensureQueryData(environmentProvidersQueryOptions({}));
  await appQueryClient.ensureQueryData(machineProvidersQueryOptions());
  renderHook(
    () => {
      useSystemEnvironmentProviders();
      useSystemMachineProviders();
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={appQueryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  expect(environments).toHaveBeenCalledTimes(1);
  expect(environments).toHaveBeenCalledWith({});
  expect(machines).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Open personal thread" }));
  await waitFor(() => expect(downloads.thread).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(downloads.prefetch).toHaveBeenCalledWith("thr_example"),
  );

  fireEvent.click(screen.getByRole("button", { name: "Open project thread" }));
  expect(downloads.thread).toHaveBeenCalledTimes(1);
  await act(async () => {
    downloads.workspace.resolve();
  });
});
