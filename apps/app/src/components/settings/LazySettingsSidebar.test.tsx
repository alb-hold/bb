// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LazySettingsSidebar } from "./LazySettingsSidebar";
import { startSplitPreloading } from "@/lib/split-prefetch";
import { SidebarProvider } from "@/components/ui/sidebar";
import { MemoryRouter } from "react-router-dom";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./SettingsSidebar", () => {
  loaded();
  return { SettingsSidebar: () => <p>Settings navigation</p> };
});

afterEach(cleanup);

it("waits for the settings route to mount instead of warming on home idle", async () => {
  startSplitPreloading();
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  });
  expect(loaded).not.toHaveBeenCalled();
  render(
    <MemoryRouter>
      <SidebarProvider>
        <LazySettingsSidebar
          backTo="/"
          isResizing={false}
          onResizeMouseDown={() => {}}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
  expect(await screen.findByText("Settings navigation")).toBeTruthy();
  expect(loaded).toHaveBeenCalledOnce();
});
