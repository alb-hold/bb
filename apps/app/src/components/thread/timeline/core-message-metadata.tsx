import type { ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk";
import { defineSplit } from "@/lib/define-split";
import { createThreadSlotCollector } from "@get-bb/plugin-sdk/internal/plugin-app-collector";

const InlineMessageTime = defineSplit<ExperimentalMessageMetadataProps>({
  id: "inline-message-time",
  load: () =>
    import("./message-time.js").then((module) => module.InlineMessageTime),
  loading: () => null,
  tier: "intent",
});

const app = createThreadSlotCollector();
app.slots.experimental_messageMetadata({
  id: "time",
  placement: "actionRow",
  component: InlineMessageTime,
});

export const coreMessageMetadata = app.messageMetadata.map((slot) => ({
  ...slot,
  pluginId: "core",
  generation: 0,
}));
