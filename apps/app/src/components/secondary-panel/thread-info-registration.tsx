import { createContext, useContext, type ReactNode } from "react";
import { createThreadSlotCollector } from "@get-bb/plugin-sdk/internal/plugin-app-collector";

export const ThreadInfoContentContext = createContext<ReactNode>(null);

export function ThreadInfoFixedTabContent() {
  return useContext(ThreadInfoContentContext);
}

const app = createThreadSlotCollector();
app.slots.experimental_tab({
  context: { kind: "thread" },
  availability: "fixed",
  id: "info",
  title: "Info",
  tooltip: "Thread info",
  icon: "Info",
  layout: "flush",
  component: ThreadInfoFixedTabContent,
});

export const coreTabs = app.tabs.map((slot) => ({
  ...slot,
  pluginId: "core",
  generation: 0,
}));
