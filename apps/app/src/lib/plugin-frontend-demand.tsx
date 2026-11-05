import * as react from "react";
import { createRetryingModuleLoader } from "./plugin-frontend-lazy";
import { prefetchPluginModule } from "./plugin-module-preload";
import { prefetchPluginCss } from "./plugin-css";
export { prefetchPluginModule } from "./plugin-module-preload";
import {
  parsePluginFrontendInventory,
  type PluginFrontendInventory,
} from "@bb/domain";
import type {
  PluginFrontendCandidate,
  PluginFrontendLoaderDeps,
  PluginFrontendRecord,
  BbPluginRuntime,
  PluginFrontendReconcileState,
  PluginFrontendReconcileDeps,
} from "./plugin-frontend";

interface DeferredState {
  deferred: Map<string, PluginFrontendCandidate>;
  demanded: Set<string>;
  demandLoads: Map<string, Promise<void>>;
}
const states = new WeakMap<PluginFrontendReconcileState, DeferredState>();
function deferredState(owner: PluginFrontendReconcileState): DeferredState {
  let state = states.get(owner);
  if (state === undefined) {
    state = {
      deferred: new Map(),
      demanded: new Set(),
      demandLoads: new Map(),
    };
    states.set(owner, state);
  }
  return state;
}

export function disposeDeferredFrontends(
  owner: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
): void {
  const state = states.get(owner);
  if (state === undefined) return;
  for (const pluginId of state.deferred.keys())
    deps.removeRegistrations(pluginId);
  states.delete(owner);
}

export function selectEagerFrontends(
  candidates: readonly PluginFrontendCandidate[],
  owner: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
  load: (candidate: PluginFrontendCandidate) => Promise<void>,
): PluginFrontendCandidate[] {
  const state = deferredState(owner);
  const ids = new Set(candidates.map((candidate) => candidate.pluginId));
  for (const pluginId of state.deferred.keys()) {
    if (ids.has(pluginId)) continue;
    state.deferred.delete(pluginId);
    state.demanded.delete(pluginId);
    deps.removeRegistrations(pluginId);
  }
  return candidates.filter((candidate) => {
    const inventory = parsePluginFrontendInventory(
      candidate.bundle.frontendInventory,
    );
    if (
      inventory === null ||
      state.demanded.has(candidate.pluginId) ||
      owner.records.has(candidate.pluginId)
    )
      return true;
    if (
      state.deferred.get(candidate.pluginId)?.bundle.hash !==
      candidate.bundle.hash
    ) {
      state.deferred.set(candidate.pluginId, candidate);
      publishDeferredSections(candidate, inventory, owner, deps, load);
    }
    return false;
  });
}

function publishDeferredSections(
  candidate: PluginFrontendCandidate,
  inventory: PluginFrontendInventory,
  owner: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
  load: (candidate: PluginFrontendCandidate) => Promise<void>,
  failure: Error | null = null,
): void {
  function DeferredSettingsSection() {
    const [error, setError] = react.useState(failure);
    react.useEffect(() => {
      let mounted = true;
      if (failure === null)
        void demandPluginFrontend(candidate.pluginId, owner, deps, load).catch(
          (reason: unknown) => {
            if (mounted)
              setError(
                reason instanceof Error ? reason : new Error(String(reason)),
              );
          },
        );
      return () => {
        mounted = false;
      };
    }, []);
    if (error !== null) throw error;
    return react.createElement(
      "p",
      { role: "status", className: "text-sm text-muted-foreground" },
      "Loading…",
    );
  }
  deps.setRegistrations(candidate.pluginId, {
    homepageSections: [],
    navPanels: [],
    threadPanelActions: [],
    sidebarFooterActions: [],
    fileOpeners: [],
    messageDirectives: [],
    messageActions: [],
    settingsSections: inventory.settingsSections.map((section) => ({
      ...section,
      component: DeferredSettingsSection,
    })),
  });
}

function demandPluginFrontend(
  pluginId: string,
  owner: PluginFrontendReconcileState,
  deps: PluginFrontendReconcileDeps,
  reconcile: (candidate: PluginFrontendCandidate) => Promise<void>,
): Promise<void> {
  const state = deferredState(owner);
  const pending = state.demandLoads.get(pluginId);
  if (pending !== undefined) return pending;
  const candidate = state.deferred.get(pluginId);
  if (candidate === undefined || owner.tornDown) return Promise.resolve();
  state.demanded.add(pluginId);
  const load = reconcile(candidate)
    .then(() => {
      if (owner.tornDown || states.get(owner) !== state) return;
      const record = owner.records.get(pluginId);
      if (record?.status !== "loaded") {
        const error = new Error(
          record?.status === "failed"
            ? record.error
            : "Plugin frontend unavailable",
        );
        const inventory = parsePluginFrontendInventory(
          candidate.bundle.frontendInventory,
        );
        if (inventory !== null)
          publishDeferredSections(
            candidate,
            inventory,
            owner,
            deps,
            reconcile,
            error,
          );
        throw error;
      }
      state.deferred.delete(pluginId);
    })
    .finally(() => {
      state.demandLoads.delete(pluginId);
    });
  state.demandLoads.set(pluginId, load);
  return load;
}

interface PluginFrontendPageLifecycleDeps {
  restore: () => void;
  teardown: () => void;
}

export function createPluginFrontendPageLifecycle(
  deps: PluginFrontendPageLifecycleDeps,
): {
  onPageHide: (event: { persisted: boolean }) => void;
  onPageShow: (event: { persisted: boolean }) => void;
} {
  return {
    onPageHide(event) {
      if (event.persisted) return;
      deps.teardown();
    },
    onPageShow(event) {
      if (!event.persisted) return;
      deps.restore();
    },
  };
}

export function prefetchPriorityFrontends(
  plugins: import("@bb/server-contract").PluginListResponse["plugins"],
  priorityPluginIds: readonly string[],
): void {
  for (const plugin of plugins) {
    const bundle = plugin.app.bundle;
    if (
      !priorityPluginIds.includes(plugin.id) ||
      !plugin.enabled ||
      !["running", "needs-configuration", "degraded"].includes(plugin.status) ||
      bundle === null ||
      !bundle.compatible ||
      parsePluginFrontendInventory(bundle.frontendInventory) !== null
    )
      continue;
    prefetchPluginModule(bundle.jsUrl);
    if (bundle.cssUrl !== null) prefetchPluginCss(bundle.cssUrl);
  }
}

export async function loadPluginFrontend(
  { pluginId, bundle }: PluginFrontendCandidate,
  deps: PluginFrontendLoaderDeps,
  installRuntime: () => BbPluginRuntime,
): Promise<PluginFrontendRecord> {
  if (!bundle.compatible) {
    deps.warn(
      `[plugin:${pluginId}] frontend bundle was built against plugin SDK ${bundle.sdkVersion} (incompatible major) — skipping until the plugin is updated`,
    );
    return {
      pluginId,
      status: "needs-update",
      sdkMajor: bundle.sdkMajor,
      sdkVersion: bundle.sdkVersion,
    };
  }
  try {
    const runtimeGroups = lazyRuntimeGroups.filter((group) =>
      group.slots.some((slot) => bundle.runtimeSlots.includes(slot)),
    );
    if (runtimeGroups.length > 0) {
      const slotsProvided = Promise.all(
        runtimeGroups.map(async (group) => {
          const slots = await group.load();
          Object.assign(installRuntime(), slots);
        }),
      );
      deps.prefetchModule(bundle.jsUrl);
      await slotsProvided;
    }
    const mod = await deps.importModule(bundle.jsUrl);
    if (typeof mod !== "object" || mod === null) {
      throw new Error("bundle did not evaluate to a module namespace");
    }
    return {
      pluginId,
      status: "loaded",
      module: mod as Record<string, unknown>,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warn(
      `[plugin:${pluginId}] frontend bundle failed to load: ${message}`,
    );
    return { pluginId, status: "failed", error: message };
  }
}

const lazyRuntimeGroups = [
  {
    slots: ["radixAlertDialog"],
    load: createRetryingModuleLoader(async () => ({
      radixAlertDialog: await import("@radix-ui/react-alert-dialog"),
    })),
  },
  {
    slots: ["radixHoverCard"],
    load: createRetryingModuleLoader(async () => ({
      radixHoverCard: await import("@radix-ui/react-hover-card"),
    })),
  },
  {
    slots: ["radixMenubar"],
    load: createRetryingModuleLoader(async () => ({
      radixMenubar: await import("@radix-ui/react-menubar"),
    })),
  },
  {
    slots: ["radixNavigationMenu"],
    load: createRetryingModuleLoader(async () => ({
      radixNavigationMenu: await import("@radix-ui/react-navigation-menu"),
    })),
  },
  {
    slots: ["radixSelect"],
    load: createRetryingModuleLoader(async () => ({
      radixSelect: await import("@radix-ui/react-select"),
    })),
  },
  {
    slots: ["vaul"],
    load: createRetryingModuleLoader(async () => ({
      vaul: await import("vaul"),
    })),
  },
  {
    slots: ["pierreDiffs", "pierreDiffsReact"],
    load: createRetryingModuleLoader(async () => {
      const { pierreRuntimeSlots } = await import("./plugin-pierre-runtime");
      return pierreRuntimeSlots;
    }),
  },
] satisfies {
  slots: (keyof BbPluginRuntime)[];
  load: () => Promise<Partial<BbPluginRuntime>>;
}[];
