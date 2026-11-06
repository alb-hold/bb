import { type RefObject, useLayoutEffect, useState } from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  usePluginSlots,
  type PluginSidebarFooterItemSlot,
} from "@/lib/plugin-slots";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";
import { arrangeByStoredOrder, reorderStoredOrder } from "@/lib/stored-order";
import { useSidebarNavigationPlacement } from "./sidebarNavigationProvider";

export const sidebarFooterOrderAtom = createSyncedPreferenceAtom(
  "sidebar.footerOrder",
);
export const sidebarFooterHiddenAtom = createSyncedPreferenceAtom(
  "sidebar.hiddenFooterItems",
);
export const SIDEBAR_FOOTER_MORE_ID = "sidebar-footer-more";
export const sidebarFooterCapacityAtom = atom<number | null>(null);

export function useMeasureSidebarFooterCapacity(
  rowRef: RefObject<HTMLElement | null>,
  moreRef: RefObject<HTMLElement | null>,
) {
  const setCapacity = useSetAtom(sidebarFooterCapacityAtom);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const more = moreRef.current;
    if (!row || !more) return;
    const measure = () => {
      const width = row.getBoundingClientRect().width;
      const controlWidth = more.getBoundingClientRect().width;
      if (width === 0 || controlWidth === 0) return;
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      setCapacity(
        Math.max(0, Math.floor((width + gap) / (controlWidth + gap)) - 1),
      );
    };
    if (typeof ResizeObserver === "undefined") {
      const frame = requestAnimationFrame(measure);
      return () => cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(more);
    return () => observer.disconnect();
  }, [rowRef, moreRef, setCapacity]);
}

export type BuiltinFooterId = "settings" | "mobile" | "report-bug";
export type FooterItem = { key: string; label: string; icon: string } & (
  | { kind: "builtin"; id: BuiltinFooterId }
  | { kind: "plugin"; slot: PluginSidebarFooterItemSlot }
);
const SETTINGS_FOOTER_ITEM: FooterItem = {
  kind: "builtin",
  id: "settings",
  key: "builtin:settings",
  label: "Settings",
  icon: "Settings",
};

export function footerPreferenceKey(item: {
  pluginId: string;
  id: string;
}): string {
  return `plugin:${encodeURIComponent(item.pluginId)}/${encodeURIComponent(item.id)}`;
}

export function useSidebarFooterPreferences() {
  const { sidebarFooterItems } = usePluginSlots();
  const [order, setOrder] = useAtom(sidebarFooterOrderAtom);
  const [hidden, setHidden] = useAtom(sidebarFooterHiddenAtom);
  const capacity = useAtomValue(sidebarFooterCapacityAtom);
  const hasRail = useSidebarNavigationPlacement() === "rail";
  const items: FooterItem[] = [
    ...(hasRail ? [] : [SETTINGS_FOOTER_ITEM]),
    {
      kind: "builtin",
      id: "mobile",
      key: "builtin:mobile",
      label: "Mobile apps",
      icon: "Smartphone",
    },
    ...sidebarFooterItems.map((slot): FooterItem => ({
      kind: "plugin",
      key: footerPreferenceKey(slot),
      label: slot.label,
      icon: slot.icon,
      slot,
    })),
    {
      kind: "builtin",
      id: "report-bug",
      key: "builtin:report-bug",
      label: "Report a bug",
      icon: "Bug",
    },
  ];
  const { ordered, normalizedOrder } = arrangeByStoredOrder({
    items,
    storedOrder: order,
    getId: (item) => item.key,
  });
  const [pluginOrder, setPluginOrder] = useState(() => ({
    order,
    keys: order.filter((key) => key.startsWith("plugin:")),
  }));
  const knownPluginKeys =
    pluginOrder.order === order
      ? pluginOrder.keys
      : order.filter((key) => key.startsWith("plugin:"));
  const allPluginKeys = [
    ...new Set([
      ...knownPluginKeys,
      ...ordered
        .filter((item) => item.kind === "plugin")
        .map((item) => item.key),
    ]),
  ];
  if (
    pluginOrder.order !== order ||
    allPluginKeys.length !== pluginOrder.keys.length
  ) {
    setPluginOrder({ order, keys: allPluginKeys });
  }
  const pluginKeys = allPluginKeys.filter((key) => !hidden.includes(key));
  const isPrefixItem = (item: FooterItem) => item.kind === "builtin";
  const prioritized = [
    ...ordered.filter(isPrefixItem),
    ...ordered
      .filter((item) => !isPrefixItem(item))
      .sort((a, b) => pluginKeys.indexOf(a.key) - pluginKeys.indexOf(b.key)),
  ];
  const eligible = prioritized.filter(
    (item) =>
      !hidden.includes(item.key) &&
      (item.kind === "plugin" ||
        item.key === "builtin:settings" ||
        item.key === "builtin:report-bug" ||
        order.length > 0 ||
        hidden.length > 0),
  );
  const prefix = eligible.filter(isPrefixItem).slice(0, capacity ?? undefined);
  const reservedPluginKeys = pluginKeys.slice(
    0,
    capacity === null ? undefined : Math.max(0, capacity - prefix.length),
  );
  const footer = [
    ...prefix,
    ...eligible.filter(
      (item) => item.kind === "plugin" && reservedPluginKeys.includes(item.key),
    ),
  ];
  const more = ordered.filter((item) => !footer.includes(item));
  const isFull =
    capacity !== null && prefix.length + reservedPluginKeys.length >= capacity;
  return {
    items: ordered,
    hidden,
    footer,
    footerPrefix: footer.filter(isPrefixItem),
    footerSuffix: footer.filter((item) => !isPrefixItem(item)),
    pluginKeys: reservedPluginKeys,
    more,
    capacity,
    isFull,
    hideFromFooter(key: string) {
      setHidden((previous) => [...new Set([...previous, key])]);
    },
    removeFromFooter(key: string) {
      setHidden((previous) => [
        ...new Set([...previous, ...more.map((item) => item.key), key]),
      ]);
    },
    addToFooter(key: string) {
      if (isFull) return;
      const last = footer.at(-1)?.key;
      const rest = normalizedOrder.filter((id) => id !== key);
      const index = last === undefined ? 0 : rest.indexOf(last) + 1;
      setOrder([...rest.slice(0, index), key, ...rest.slice(index)]);
      setHidden((previous) =>
        [...new Set([...previous, ...more.map((item) => item.key)])].filter(
          (id) => id !== key,
        ),
      );
    },
    setFooterShown(shown: boolean) {
      setHidden((previous) => {
        const keys = ordered.map((item) => item.key);
        const others = previous.filter((id) => !keys.includes(id));
        return shown ? others : [...others, ...keys];
      });
    },
    move(activeId: string, overId: string) {
      const zone =
        [footer, more].find((items) =>
          [activeId, overId].every((id) =>
            items.some((item) => item.key === id),
          ),
        ) ?? ordered;
      const next = reorderStoredOrder({
        activeId,
        overId,
        order: normalizedOrder,
        visibleIds: zone.map((item) => item.key),
      });
      if (next) setOrder(next);
    },
  };
}
