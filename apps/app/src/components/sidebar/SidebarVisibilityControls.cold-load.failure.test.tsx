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

it("preserves Done, Escape and compact Back callbacks through an import failure", async () => {
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
  const held = render(<SidebarVisibilityCustomize {...props} variant="card" />);
  const heldDone = screen.getByRole("button", { name: "Done" });
  expect(
    screen.getByRole("status", { name: "Loading sidebar customization" }),
  ).toBeDefined();
  fireEvent.keyDown(heldDone, { key: "Escape" });
  fireEvent.click(heldDone);
  expect(onDone).toHaveBeenCalledTimes(2);
  held.unmount();

  render(
    <>
      <button type="button">Before failure</button>
      <CompactViewportOverrideProvider isCompactViewport={true}>
        <SidebarVisibilityCustomize
          {...props}
          variant="compact"
        />
      </CompactViewportOverrideProvider>
    </>,
  );
  const beforeFailure = screen.getByRole("button", { name: "Before failure" });
  beforeFailure.focus();
  expect(document.activeElement).toBe(beforeFailure);
  await act(async () => {
    download.reject(new Error("module initialization failed"));
  });
  expect(await screen.findByRole("alert")).toBeDefined();
  const done = screen.getByRole("button", { name: "Done" });
  expect(document.activeElement).toBe(done);
  fireEvent.click(done);
  expect(onDone).toHaveBeenCalledTimes(3);
});
