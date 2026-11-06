import type { BbPluginRuntime } from "./plugin-frontend";
import { createRetryingModuleLoader } from "./plugin-frontend-lazy";

export const lazyRuntimeGroups = [
  {
    slots: ["zod"],
    load: createRetryingModuleLoader(async () => {
      try {
        const { zodRuntimeSlots } =
          await import("../../../../packages/plugin-build/src/generated/zod-runtime.generated");
        return zodRuntimeSlots;
      } catch (error) {
        throw new Error(
          `Cannot load "zod": shared runtime chunk failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  },
  {
    slots: ["radixCheckbox", "radixSlot", "radixComposeRefs"],
    load: createRetryingModuleLoader(async () => {
      const { radixRuntimeSlots } = await import("./plugin-radix-runtime");
      return radixRuntimeSlots;
    }),
  },
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

export function prefetchPluginRuntimeSlots(slots: readonly string[]): void {
  for (const group of lazyRuntimeGroups) {
    if (group.slots.some((slot) => slots.includes(slot)))
      void group.load().catch(() => {});
  }
}
