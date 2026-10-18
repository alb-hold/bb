// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { SidebarVisibilityCustomize } from "./SidebarVisibilityControls";

const moduleImports = await vi.hoisted(async () => {
  const { createDeferredPromise } = await import("@bb/test-helpers");
  return {
    download: createDeferredPromise<void>(),
    loaded: createDeferredPromise<void>(),
  };
});

vi.mock("./SidebarVisibilityCustomize", async (importOriginal) => {
  await moduleImports.download.promise;
  const module = await importOriginal();
  moduleImports.loaded.resolve();
  return module;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps Done, Escape and compact Back usable while the import is held", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onDone = vi.fn();
  const props = {
    items: [{ id: "section:review", title: "Review" }],
    visibleIds: [],
    title: "Customize list",
    listLabel: "Sections",
    onVisibleChange: vi.fn(),
    onReorder: vi.fn(),
    onActivate: vi.fn(),
    onExit: vi.fn(),
    onDone,
  };
  const view = render(<SidebarVisibilityCustomize {...props} variant="card" />);
  const done = screen.getByRole("button", { name: "Done" });
  expect(document.activeElement).toBe(done);
  expect(
    screen.getByRole("status", { name: "Loading sidebar customization" }),
  ).toBeDefined();
  fireEvent.keyDown(done, { key: "Escape" });
  fireEvent.click(done);
  expect(onDone).toHaveBeenCalledTimes(2);

  view.unmount();
  render(
    <CompactViewportOverrideProvider isCompactViewport={true}>
      <SidebarVisibilityCustomize {...props} variant="compact" />
    </CompactViewportOverrideProvider>,
  );
  await act(async () => {
    moduleImports.download.resolve();
    await moduleImports.loaded.promise;
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Show Review in sidebar" }),
  );
  expect(props.onVisibleChange).toHaveBeenCalledWith("section:review", true);
  expect(screen.queryByRole("alert")).toBeNull();
});
