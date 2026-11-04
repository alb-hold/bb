// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  whenHomeComposerMounted,
  PLUGIN_FRONTEND_BOOT_TIMEOUT_MS,
} from "./plugin-frontend-boot-schedule";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("keeps background bundles waiting until the home editor mounts", async () => {
  const ready = vi.fn();
  const mounted = whenHomeComposerMounted().then(ready);
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  document.body.append(document.createElement("textarea"));
  await mounted;
  expect(ready).toHaveBeenCalledOnce();
});

it("eventually releases background slots if the editor fails to mount", async () => {
  vi.useFakeTimers();
  const ready = vi.fn();
  const mounted = whenHomeComposerMounted().then(ready);
  await vi.advanceTimersByTimeAsync(PLUGIN_FRONTEND_BOOT_TIMEOUT_MS);
  await mounted;
  expect(ready).toHaveBeenCalledOnce();
});
