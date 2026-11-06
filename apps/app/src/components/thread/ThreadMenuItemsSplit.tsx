import { defineSplit } from "@/lib/define-split";
export const ThreadActionsMenuItems = defineSplit({
  id: "thread-action-menu-items",
  tier: "intent",
  load: () =>
    import("./ThreadMenuItems").then((module) => module.ThreadActionsMenuItems),
  loading: () => null,
});
export const ThreadBulkMenuItems = defineSplit({
  id: "thread-bulk-menu-items",
  tier: "intent",
  load: () =>
    import("./ThreadMenuItems").then((module) => module.ThreadBulkMenuItems),
  loading: () => null,
});
