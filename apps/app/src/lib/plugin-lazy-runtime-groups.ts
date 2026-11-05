import type { BbPluginRuntime } from "./plugin-frontend";
import { createRetryingModuleLoader } from "./plugin-frontend-lazy";

export const lazyRuntimeGroups = [
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
