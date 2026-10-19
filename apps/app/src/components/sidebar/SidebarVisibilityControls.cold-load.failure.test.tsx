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

vi.mock("./SidebarVisibilityCustomize", async () => {
  await download.promise;
  throw new Error("module initialization failed");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows an import failure and keeps Done focused and working", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onDone = vi.fn();
  render(
    <CompactViewportOverrideProvider isCompactViewport={true}>
      <SidebarVisibilityCustomize
        items={[{ id: "section:review", title: "Review" }]}
        visibleIds={[]}
        title="Customize list"
        listLabel="Sections"
        onVisibleChange={vi.fn()}
        onReorder={vi.fn()}
        onActivate={vi.fn()}
        onExit={vi.fn()}
        onDone={onDone}
        variant="compact"
      />
    </CompactViewportOverrideProvider>,
  );
  await act(async () => {
    download.reject(new Error("module initialization failed"));
  });
  expect(await screen.findByRole("alert")).toBeDefined();
  const done = screen.getByRole("button", { name: "Done" });
  expect(document.activeElement).toBe(done);
  fireEvent.click(done);
  expect(onDone).toHaveBeenCalledTimes(1);
});
