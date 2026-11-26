export type BackgroundScopedItemKind = "backgroundTask" | "delegation";

export const FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS = {
  "provider-acp": [],
  "provider-claude-code": ["backgroundTask", "delegation"],
  "provider-codex": [],
  "provider-pi": [],
} as const satisfies Record<string, readonly BackgroundScopedItemKind[]>;

export function legacyWorkerAssumesZeroOpenBackgroundWork(
  pluginId: string,
): boolean {
  if (!(pluginId in FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS)) {
    return false;
  }
  const items =
    FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS[
      pluginId as keyof typeof FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS
    ];
  return items.length === 0;
}
