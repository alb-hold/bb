// @vitest-environment jsdom

import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (original) => {
  const actual = await original<typeof import("react-dom/client")>();
  return { ...actual, createRoot: vi.fn(actual.createRoot) };
});
vi.mock("../App", () => {
  const pending = new Promise(() => {});
  function PendingRoute(): never {
    throw pending;
  }
  return {
    App: () => (
      <>
        <textarea />
        <div data-sidebar-thread-id="thread" />
        <Suspense fallback={<div>Route pending</div>}>
          <PendingRoute />
        </Suspense>
      </>
    ),
  };
});
vi.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("react-router-dom", () => ({
  BrowserRouter: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../components/AppErrorBoundary", () => ({
  AppErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../components/ApplicationUrlDialog", () => ({
  ApplicationUrlDialog: () => null,
}));
vi.mock("../components/AppToaster", () => ({ AppToaster: () => null }));
vi.mock("../components/provider-cli/provider-cli-install-store", () => ({
  registerProviderCliInstallQueryClient: vi.fn(),
}));
vi.mock("../hooks/useTheme", () => ({ initializePreferredTheme: vi.fn() }));
vi.mock("./app-theme-css", () => ({ applyCachedAppThemeCss: vi.fn() }));
vi.mock("./content-measure", () => ({ initializeContentMeasure: vi.fn() }));
vi.mock("./favicon-color-preference", () => ({ initializeFavicon: vi.fn() }));
vi.mock("./foreign-dom-mutation-guard", () => ({
  installForeignDomMutationGuard: vi.fn(),
}));
vi.mock("./query-client", () => ({
  installAppQueryClientBrowserEvents: vi.fn(),
}));
vi.mock("./app-query-client", () => ({ appQueryClient: {} }));
vi.mock("./bb-desktop", () => ({
  applyAppFrameGeometry: vi.fn(),
  getBbDesktopInfo: vi.fn(),
}));
vi.mock("./stale-chunk-recovery", () => ({
  installStaleChunkRecovery: vi.fn(),
}));
vi.mock("./stylesheet-property-registry", () => ({
  moveStylesheetPropertiesToRegistry: vi.fn(),
}));
vi.mock("./settled-split-downloads", () => ({
  scheduleSettledSplitDownloads: vi.fn(() => () => {}),
}));

const stackTraceLimit = Error.stackTraceLimit;
afterEach(async () => {
  for (const result of vi.mocked(createRoot).mock.results) {
    if (result.type === "return") await act(() => result.value.unmount());
  }
  Error.stackTraceLimit = stackTraceLimit;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("marks visible home before a parallel route boundary finishes suspending", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", {});
  vi.stubGlobal("performance", { mark: vi.fn(), getEntriesByName: () => [] });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 20),
  );
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("../main");
  });
  expect(document.querySelector("textarea")).not.toBeNull();
  expect(document.body.textContent).toContain("Route pending");
  expect(performance.mark).not.toHaveBeenCalledWith("app-home-composer-ready");
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
  frames.shift()!(0);
  expect(performance.mark).toHaveBeenCalledWith("app-home-composer-ready");
  expect(document.body.textContent).toContain("Route pending");
});
