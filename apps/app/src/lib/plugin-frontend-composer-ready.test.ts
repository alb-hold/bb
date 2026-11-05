// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  whenRouteSurfaceMounted,
  PLUGIN_FRONTEND_BOOT_TIMEOUT_MS,
  PLUGIN_FRONTEND_THREAD_SURFACE_TIMEOUT_MS,
} from "./plugin-frontend-boot-schedule";

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

it("keeps background bundles waiting until the home editor mounts", async () => {
  const ready = vi.fn();
  const mounted = whenRouteSurfaceMounted().then(ready);
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  document.body.append(document.createElement("textarea"));
  await mounted;
  expect(ready).toHaveBeenCalledOnce();
});

it("eventually releases background slots if the editor fails to mount", async () => {
  vi.useFakeTimers();
  const ready = vi.fn();
  const mounted = whenRouteSurfaceMounted().then(ready);
  await vi.advanceTimersByTimeAsync(PLUGIN_FRONTEND_BOOT_TIMEOUT_MS);
  await mounted;
  expect(ready).toHaveBeenCalledOnce();
});

it.each([".xterm-screen", "[data-timeline-row-id]"])(
  "keeps background bundles waiting for thread content %s",
  async (selector) => {
    window.history.replaceState(null, "", "/threads/thr_cold");
    const ready = vi.fn();
    const mounted = whenRouteSurfaceMounted().then(ready);
    document.body.append(document.createElement("textarea"));
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    const content = document.createElement("div");
    if (selector === ".xterm-screen") content.className = "xterm-screen";
    else content.dataset.timelineRowId = "message";
    document.body.append(content);
    await mounted;
    expect(ready).toHaveBeenCalledOnce();
  },
);

it("releases background bundles for empty or unavailable threads", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/threads/thr_empty");
  const ready = vi.fn();
  const mounted = whenRouteSurfaceMounted().then(ready);
  await vi.advanceTimersByTimeAsync(PLUGIN_FRONTEND_BOOT_TIMEOUT_MS);
  expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(
    PLUGIN_FRONTEND_THREAD_SURFACE_TIMEOUT_MS - PLUGIN_FRONTEND_BOOT_TIMEOUT_MS,
  );
  await mounted;
  expect(ready).toHaveBeenCalledOnce();
});

it("waits for thread content on project routes too", async () => {
  window.history.replaceState(null, "", "/projects/proj_one/threads/thr_one");
  const ready = vi.fn();
  const mounted = whenRouteSurfaceMounted().then(ready);
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  const row = document.createElement("div");
  row.dataset.timelineRowId = "message";
  document.body.append(row);
  await mounted;
  expect(ready).toHaveBeenCalledOnce();
});

it("ignores hidden thread rows until their surface becomes visible", async () => {
  window.history.replaceState(null, "", "/threads/thr_one");
  const row = document.createElement("div");
  row.dataset.timelineRowId = "message";
  row.hidden = true;
  row.checkVisibility = () => !row.hidden;
  document.body.append(row);
  const ready = vi.fn();
  const mounted = whenRouteSurfaceMounted().then(ready);
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  row.hidden = false;
  await mounted;
  expect(ready).toHaveBeenCalledOnce();
});

it("releases a pending thread wait when the user leaves the route", async () => {
  window.history.replaceState(null, "", "/threads/thr_one");
  const mounted = whenRouteSurfaceMounted();
  window.history.replaceState(null, "", "/settings");
  document.body.append(document.createElement("main"));
  await mounted;
});
