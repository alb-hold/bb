import type { ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk";
import { defineSplit } from "@/lib/define-split";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
const InlineMessageTime = defineSplit<ExperimentalMessageMetadataProps>({
  id: "inline-message-time",
  load: () =>
    import("./message-time.js").then((module) => module.InlineMessageTime),
  loading: () => null,
  tier: "intent",
});

export const coreMessageMetadata = collectPluginAppRegistrations(
  definePluginApp((app) => {
    app.slots.experimental_messageMetadata({
      id: "time",
      placement: "actionRow",
      component: InlineMessageTime,
    });
  }),
).messageMetadata.map((slot) => ({ ...slot, pluginId: "core", generation: 0 }));
