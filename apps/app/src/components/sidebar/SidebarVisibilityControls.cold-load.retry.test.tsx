// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { SidebarVisibilityCustomize } from "./SidebarVisibilityControls";

const download = await vi.hoisted(async () => {
  const { createDeferredPromise } = await import("@bb/test-helpers");
  return createDeferredPromise<void>();
});

const retryLoaded = await vi.hoisted(async () => {
  const { createDeferredPromise } = await import("@bb/test-helpers");
  return createDeferredPromise<void>();
});

vi.mock("./SidebarVisibilityCustomize", async () => {
  await download.promise;
  throw new Error("module initialization failed");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("retries the failed import and updates sidebar visibility", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onVisibleChange = vi.fn();
  render(
    <CompactViewportOverrideProvider isCompactViewport={true}>
      <SidebarVisibilityCustomize
        items={[{ id: "section:review", title: "Review" }]}
        visibleIds={[]}
        title="Customize list"
        listLabel="Sections"
        onVisibleChange={onVisibleChange}
        onReorder={vi.fn()}
        onActivate={vi.fn()}
        onExit={vi.fn()}
        onDone={vi.fn()}
        variant="compact"
      />
    </CompactViewportOverrideProvider>,
  );
  await act(async () => {
    download.reject(new Error("module initialization failed"));
  });
  expect(await screen.findByRole("alert")).toBeDefined();
  vi.resetModules();
  vi.doMock("./SidebarVisibilityCustomize", async (importOriginal) => {
    const module = await importOriginal();
    retryLoaded.resolve();
    return module;
  });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await act(async () => {
    await retryLoaded.promise;
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Show Review in sidebar" }));
  expect(onVisibleChange).toHaveBeenCalledWith("section:review", true);
  expect(screen.queryByRole("alert")).toBeNull();
});
