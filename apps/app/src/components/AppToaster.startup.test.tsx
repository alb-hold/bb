// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppToaster } from "./AppToaster";
import { appToast } from "./ui/app-toast";
import { startSplitPreloading } from "@/lib/split-prefetch";
import { bootPluginFrontends } from "@/lib/plugin-frontend-lazy";

const loaded = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => {
  let finish = () => {};
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { completed, finish };
});
vi.mock("@/lib/plugin-frontend", () => ({
  bootPluginFrontends: async () => {},
}));
vi.mock("./AppToasterView", async (original) => {
  loaded();
  const view = await original();
  download.finish();
  return view;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("leaves the toaster unloaded through plugin boot and idle, then shows the first notification", async () => {
  vi.useFakeTimers();
  render(<AppToaster />);
  startSplitPreloading();
  await act(async () => {
    await bootPluginFrontends();
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(loaded).not.toHaveBeenCalled();
  vi.useRealTimers();
  await act(async () => {
    appToast.success("Saved draft");
  });
  await act(async () => download.completed);
  expect(await screen.findByText("Saved draft")).toBeTruthy();
  expect(loaded).toHaveBeenCalledOnce();
});
