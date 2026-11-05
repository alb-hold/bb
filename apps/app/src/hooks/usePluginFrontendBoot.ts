import { useEffect } from "react";
import {
  PLUGIN_FRONTEND_BOOT_TIMEOUT_MS,
  requestBrowserIdle,
  scheduleDeferredPluginFrontendBoot,
} from "../lib/plugin-frontend-boot-schedule";
import { markPluginFrontendSettleFloorReached } from "../lib/plugin-frontend-boot-state";
import {
  bootPluginFrontends,
  preloadPluginFrontend,
} from "../lib/plugin-frontend-lazy";
import { frontendPriorityPluginIds } from "../lib/plugin-surface-providers";
import { holdSplitPreloads } from "../lib/split-prefetch";
import { whenRouteContentPainted } from "../lib/route-content-paint";
import { getPluginPanelRoutePluginId } from "../lib/route-paths";
import { useSystemConfig } from "./queries/system-queries";
import { pluginListQueryOptions } from "./queries/plugin-settings-queries";
import { appQueryClient } from "../lib/app-query-client";

export const PLUGIN_FRONTEND_SETTLE_FLOOR_MS = 15_000;
const PRIORITY_PRELOAD_HOLD_MAX_MS = 10_000;

export function usePluginFrontendBoot(): void {
  const systemConfig = useSystemConfig();
  const resolved = systemConfig.data !== undefined;
  useEffect(() => {
    const pathname = window.location.pathname;
    const priorityPluginIds = frontendPriorityPluginIds(pathname);
    let cancelled = false;
    void appQueryClient
      .fetchQuery(pluginListQueryOptions({ enabled: true }))
      .then(async (plugins) => {
        const host = await import("../lib/plugin-frontend-demand");
        if (!cancelled)
          host.prefetchPriorityFrontends(plugins, priorityPluginIds);
      })
      .catch(() => {});
    if (
      priorityPluginIds.length > 0 ||
      getPluginPanelRoutePluginId(pathname) !== null
    ) {
      preloadPluginFrontend();
    }
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!resolved) return;
    const pathname = window.location.pathname;
    const priorityPluginIds = frontendPriorityPluginIds(pathname);
    const releaseHold =
      priorityPluginIds.length > 0 ? holdSplitPreloads() : () => {};
    const holdTimeout = window.setTimeout(
      releaseHold,
      PRIORITY_PRELOAD_HOLD_MAX_MS,
    );
    const releasePreloads = () => {
      window.clearTimeout(holdTimeout);
      releaseHold();
    };
    const cleanup = () => {
      releasePreloads();
    };
    const boot = () => void bootPluginFrontends().then(releasePreloads);
    if (
      priorityPluginIds.length > 0 ||
      getPluginPanelRoutePluginId(pathname) !== null
    ) {
      boot();
      return cleanup;
    }
    const cancelBoot = scheduleDeferredPluginFrontendBoot(boot, {
      whenRoutePainted: whenRouteContentPainted,
      requestIdle: requestBrowserIdle,
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      timeoutMs: PLUGIN_FRONTEND_BOOT_TIMEOUT_MS,
    });
    return () => {
      cancelBoot();
      cleanup();
    };
  }, [resolved]);
  useEffect(() => {
    const timeout = window.setTimeout(
      markPluginFrontendSettleFloorReached,
      PLUGIN_FRONTEND_SETTLE_FLOOR_MS,
    );
    return () => window.clearTimeout(timeout);
  }, []);
}
