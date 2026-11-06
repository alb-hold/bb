// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppToaster } from "./AppToaster";
import { appToast } from "./ui/app-toast";
import { startSplitPreloading } from "@/lib/split-prefetch";
import { bootPluginFrontends } from "@/lib/plugin-frontend-lazy";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("@/lib/plugin-frontend", () => ({
  bootPluginFrontends: async () => {},
}));
vi.mock("./AppToasterView", async (original) => {
  loaded();
  return original();
});

afterEach(cleanup);

it("leaves the toaster unloaded through plugin boot and idle, then shows the first notification", async () => {
  render(<AppToaster />);
  startSplitPreloading();
  await act(async () => {
    await bootPluginFrontends();
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  });
  expect(loaded).not.toHaveBeenCalled();
  await act(async () => {
    appToast.success("Saved draft");
  });
  expect(await screen.findByText("Saved draft")).toBeTruthy();
  expect(loaded).toHaveBeenCalledOnce();
});
