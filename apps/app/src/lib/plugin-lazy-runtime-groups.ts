import type { BbPluginRuntime } from "./plugin-frontend";
import { createRetryingModuleLoader } from "./plugin-frontend-lazy";

export const lazyRuntimeGroups = [
  {
    id: "plugin-question-form-runtime",
    slots: ["questionFormHost"],
    load: createRetryingModuleLoader(async () => ({
      questionFormHost: await import("@bb/shared-ui/question-form-host"),
    })),
  },
  {
    id: "plugin-voice-input-runtime",
    slots: ["voiceInputTextarea"],
    load: createRetryingModuleLoader(async () => ({
      voiceInputTextarea: await import("@bb/shared-ui/voice-input-textarea"),
    })),
  },
  {
    id: "plugin-zod-runtime",
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
    id: "plugin-radix-runtime",
    slots: ["radixCheckbox", "radixSlot", "radixComposeRefs"],
    load: createRetryingModuleLoader(async () => {
      const { radixRuntimeSlots } = await import("./plugin-radix-runtime");
      return radixRuntimeSlots;
    }),
  },
  {
    id: "plugin-alert-runtime",
    slots: ["radixAlertDialog"],
    load: createRetryingModuleLoader(async () => ({
      radixAlertDialog: await import("@radix-ui/react-alert-dialog"),
    })),
  },
  {
    id: "plugin-hover-runtime",
    slots: ["radixHoverCard"],
    load: createRetryingModuleLoader(async () => ({
      radixHoverCard: await import("@radix-ui/react-hover-card"),
    })),
  },
  {
    id: "plugin-menubar-runtime",
    slots: ["radixMenubar"],
    load: createRetryingModuleLoader(async () => ({
      radixMenubar: await import("@radix-ui/react-menubar"),
    })),
  },
  {
    id: "plugin-navigation-runtime",
    slots: ["radixNavigationMenu"],
    load: createRetryingModuleLoader(async () => ({
      radixNavigationMenu: await import("@radix-ui/react-navigation-menu"),
    })),
  },
  {
    id: "plugin-select-runtime",
    slots: ["radixSelect"],
    load: createRetryingModuleLoader(async () => ({
      radixSelect: await import("@radix-ui/react-select"),
    })),
  },
  {
    id: "plugin-vaul-runtime",
    slots: ["vaul"],
    load: createRetryingModuleLoader(async () => ({
      vaul: await import("vaul"),
    })),
  },
  {
    id: "plugin-pierre-runtime",
    slots: ["pierreDiffs", "pierreDiffsReact"],
    load: createRetryingModuleLoader(async () => {
      const { pierreRuntimeSlots } = await import("./plugin-pierre-runtime");
      return pierreRuntimeSlots;
    }),
  },
] satisfies {
  id: string;
  slots: (keyof BbPluginRuntime)[];
  load: () => Promise<Partial<BbPluginRuntime>>;
}[];

export function prefetchPluginRuntimeSlots(slots: readonly string[]): void {
  for (const group of lazyRuntimeGroups) {
    if (group.slots.some((slot) => slots.includes(slot)))
      void group.load().catch(() => {});
  }
}
