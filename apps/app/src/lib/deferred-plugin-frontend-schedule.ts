import { whenHomeBackgroundWorkMayStart } from "./home-composer-ready";
import {
  requestBrowserIdle,
  whenRouteSurfaceMounted,
} from "./plugin-frontend-boot-schedule";
import { whenRouteContentPainted } from "./route-content-paint";
import { createSettledWorkSchedule } from "./settled-split-downloads";

export function createDeferredPluginFrontendSchedule() {
  let schedule: ReturnType<typeof createSettledWorkSchedule> | null = null;
  let observer: MutationObserver | null = null;
  const dispose = () => {
    observer?.disconnect();
    observer = null;
    schedule?.cancel();
    schedule = null;
  };
  const yieldBetweenDeferredLoads = async () => {
    await whenRouteSurfaceMounted();
    if (schedule !== null && window.location.pathname === "/") {
      if (await schedule.whenIdle()) return;
    }
    await whenRouteSurfaceMounted();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await new Promise<void>((resolve) => requestBrowserIdle(resolve));
  };
  const waitForDeferredLoad = async () => {
    await whenRouteContentPainted();
    await whenRouteSurfaceMounted();
    const settledAt = await whenHomeBackgroundWorkMayStart();
    if (settledAt !== null) {
      schedule = createSettledWorkSchedule(
        () => window.location.pathname === "/",
        settledAt,
      );
      observer = new MutationObserver(() => {
        if (window.location.pathname !== "/") dispose();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
    await yieldBetweenDeferredLoads();
  };
  const downloadDeferredModule = async (url: string) => {
    try {
      const response = await fetch(url, {
        cache: "force-cache",
        priority: "low",
      });
      if (response.ok) await response.arrayBuffer();
    } catch {}
  };
  return {
    waitForDeferredLoad,
    yieldBetweenDeferredLoads,
    downloadDeferredModule,
    dispose,
  };
}
