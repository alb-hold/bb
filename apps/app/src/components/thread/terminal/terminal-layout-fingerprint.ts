import { z } from "zod";

const panelGeometrySchema = z.object({
  secondary: z.object({
    isOpen: z.boolean(),
    activeTabId: z.string().nullable(),
    tabs: z.array(z.object({ id: z.string(), kind: z.string() })),
  }),
});

function panelGeometry(value: string | null) {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = panelGeometrySchema.safeParse(parsed);
    return result.success ? result.data.secondary : null;
  } catch {
    return null;
  }
}

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function terminalLayoutFingerprint(): string {
  try {
    const local = window.localStorage;
    const tabValue = (key: string) => {
      try {
        return read(window.sessionStorage, key) ?? read(local, key);
      } catch {
        return read(local, key);
      }
    };
    const width = Number(tabValue("bb.sidebar.width") ?? 320);
    const keys = Array.from({ length: local.length }, (_, index) =>
      local.key(index),
    )
      .filter(
        (key): key is string =>
          key !== null &&
          (key.startsWith("bb.thread.secondaryPanel.widthPercent") ||
            key.startsWith("bb.thread.conversation.collapsed-") ||
            key.startsWith("bb.thread.secondaryPanelSplitLayout.") ||
            key.startsWith("bb.thread.fixedPanelTabsState-")),
      )
      .sort();
    return JSON.stringify([
      Number.isFinite(width) ? Math.min(460, Math.max(240, width)) : 320,
      tabValue("bb.sidebar.open") !== "false",
      tabValue("bb.splitLayout") || null,
      tabValue("bb.splitLayout.maximizedPaneId") || null,
      keys.map((key) => {
        const value = read(local, key);
        if (!key.startsWith("bb.thread.fixedPanelTabsState-"))
          return [key, value];
        return [key, panelGeometry(value)];
      }),
    ]);
  } catch {
    return "[]";
  }
}
