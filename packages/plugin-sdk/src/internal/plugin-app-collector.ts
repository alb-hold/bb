export {
  type ExperimentalSidebarFooterCommandKind,
  type ExperimentalSidebarFooterRuntimeSnapshot,
  type ExperimentalSidebarFooterItemRuntime,
  type CollectedExperimentalSidebarFooterItem,
  type CollectedManagedSidebarFooterItem,
  type CollectedCompatibilitySidebarFooterItem,
  type CollectedSidebarFooterItem,
  adaptSidebarFooterAction,
  getCollectedSidebarFooterItems,
} from "./sidebar-footer-runtime.js";
export {
  type CollectedPluginProviderIconRegistration,
  type CollectedPluginCommandRegistration,
  type CollectedPluginAppRegistrations,
  type LegacyThreadPanelActionRegistration,
  type LegacyThreadHeaderActionRegistration,
  type LegacyNavPanelRegistration,
  type CollectedSidebarNavigationRegistration,
  collectPluginAppRegistrations,
} from "./plugin-app-registration-collector.js";
export { createThreadSlotCollector } from "./thread-slot-collector.js";
export { createThreadContextSegmentCollector } from "./thread-context-segment-collector.js";
