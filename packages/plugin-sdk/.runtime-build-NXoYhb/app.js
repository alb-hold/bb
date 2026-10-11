// src/thread-action-groups.ts
var experimental_THREAD_ACTION_GROUPS = {
  open: "1_open",
  organize: "2_organize",
  settings: "3_settings",
  lifecycle: "4_lifecycle"
};

// src/app.ts
function runtimeHost() {
  return globalThis.__bbPluginRuntime;
}
function installedApp() {
  return runtimeHost()?.pluginSdkApp;
}
function runtimeMember(name) {
  const member = installedApp()?.[name];
  if (member === void 0) {
    throw new Error(
      `@get-bb/plugin-sdk/app: ${name} needs the bb app's plugin runtime. In tests, call installTestPluginRuntime() from @get-bb/plugin-sdk/testing/app first.`
    );
  }
  return member;
}
function runtimeFunction(name) {
  const forward = (...args) => runtimeMember(name)(...args);
  return forward;
}
function runtimeComponent(name) {
  function RuntimeComponent(props) {
    const react = runtimeHost()?.react;
    if (react === void 0) {
      throw new Error(
        `@get-bb/plugin-sdk/app: ${name} needs React on the bb plugin runtime. In tests, call installTestPluginRuntime() from @get-bb/plugin-sdk/testing/app first.`
      );
    }
    return react.createElement(runtimeMember(name), props);
  }
  RuntimeComponent.displayName = name;
  return RuntimeComponent;
}
var experimental_Icon = runtimeComponent("experimental_Icon");
var experimental_ProviderIcon = runtimeComponent(
  "experimental_ProviderIcon"
);
var definePluginApp = (setup) => {
  const app = installedApp();
  if (app?.definePluginApp !== void 0) return app.definePluginApp(setup);
  if (typeof setup !== "function") {
    throw new Error("definePluginApp expects a setup function");
  }
  return Object.freeze({ __bbPluginApp: true, setup });
};
var ThreadChat = runtimeComponent("ThreadChat");
var Markdown = runtimeComponent("Markdown");
var experimental_FileLink = runtimeComponent("experimental_FileLink");
var UrlLink = runtimeComponent("UrlLink");
var experimental_NewThreadComposer = runtimeComponent(
  "experimental_NewThreadComposer"
);
var experimental_VoiceInputTextarea = runtimeComponent(
  "experimental_VoiceInputTextarea"
);
var experimental_ProviderModelPicker = runtimeComponent(
  "experimental_ProviderModelPicker"
);
var experimental_PermissionModePicker = runtimeComponent(
  "experimental_PermissionModePicker"
);
var experimental_BranchPicker = runtimeComponent(
  "experimental_BranchPicker"
);
var experimental_useBranches = runtimeFunction(
  "experimental_useBranches"
);
var experimental_useCheckoutState = runtimeFunction(
  "experimental_useCheckoutState"
);
var experimental_SourceCode = runtimeComponent(
  "experimental_SourceCode"
);
var experimental_Diff = runtimeComponent("experimental_Diff");
var useRpc = runtimeFunction("useRpc");
var useRealtime = runtimeFunction("useRealtime");
var useRealtimeConnectionState = runtimeFunction(
  "useRealtimeConnectionState"
);
var useSettings = runtimeFunction("useSettings");
var useBbContext = runtimeFunction("useBbContext");
var experimental_usePluginId = runtimeFunction(
  "experimental_usePluginId"
);
var experimental_useQuestionFormHost = runtimeFunction(
  "experimental_useQuestionFormHost"
);
var useBbNavigate = runtimeFunction("useBbNavigate");
var experimental_useAppPanel = runtimeFunction(
  "experimental_useAppPanel"
);
var experimental_useFixedTabTarget = runtimeFunction(
  "experimental_useFixedTabTarget"
);
var useComposer = runtimeFunction("useComposer");
var useComposers = runtimeFunction("useComposers");
var useComposerView = runtimeFunction("useComposerView");
var experimental_useSidebarThreads = runtimeFunction(
  "experimental_useSidebarThreads"
);
var experimental_useSidebarThreadActions = runtimeFunction(
  "experimental_useSidebarThreadActions"
);
var experimental_useSidebarProjectActions = runtimeFunction(
  "experimental_useSidebarProjectActions"
);
var experimental_useThreadActions = runtimeFunction(
  "experimental_useThreadActions"
);
var experimental_useArchiveEnvironmentThreads = runtimeFunction(
  "experimental_useArchiveEnvironmentThreads"
);
var experimental_useThreadActionRegistrations = runtimeFunction(
  "experimental_useThreadActionRegistrations"
);
var experimental_ThreadActionsMenu = runtimeComponent(
  "experimental_ThreadActionsMenu"
);
var experimental_ThreadActionsContextMenu = runtimeComponent(
  "experimental_ThreadActionsContextMenu"
);
var experimental_useSidebarThreadPullRequest = runtimeFunction(
  "experimental_useSidebarThreadPullRequest"
);
var experimental_useSidebarThreadSplit = runtimeFunction(
  "experimental_useSidebarThreadSplit"
);
var useSidebarThreadDraft = runtimeFunction("useSidebarThreadDraft");
var useSidebarThreadDraftIds = runtimeFunction(
  "useSidebarThreadDraftIds"
);
var useSidebarThreadRowStatus = runtimeFunction(
  "useSidebarThreadRowStatus"
);
var useSidebarThreadRowStatuses = runtimeFunction(
  "useSidebarThreadRowStatuses"
);
var useSidebarSplitLayout = runtimeFunction("useSidebarSplitLayout");
var useSidebarThreadShortcut = runtimeFunction(
  "useSidebarThreadShortcut"
);
var ThreadTitle = runtimeComponent("ThreadTitle");
var experimental_ThreadStatusGlyph = runtimeComponent(
  "experimental_ThreadStatusGlyph"
);
var useEnvironmentProviders = runtimeFunction(
  "useEnvironmentProviders"
);
var useSdk = runtimeFunction("useSdk");
var experimental_useProviders = runtimeFunction(
  "experimental_useProviders"
);
var experimental_useCodeTheme = runtimeFunction(
  "experimental_useCodeTheme"
);
var experimental_copyToClipboard = runtimeFunction(
  "experimental_copyToClipboard"
);
export {
  Markdown,
  ThreadChat,
  ThreadTitle,
  UrlLink,
  definePluginApp,
  experimental_BranchPicker,
  experimental_Diff,
  experimental_FileLink,
  experimental_Icon,
  experimental_NewThreadComposer,
  experimental_PermissionModePicker,
  experimental_ProviderIcon,
  experimental_ProviderModelPicker,
  experimental_SourceCode,
  experimental_THREAD_ACTION_GROUPS,
  experimental_ThreadActionsContextMenu,
  experimental_ThreadActionsMenu,
  experimental_ThreadStatusGlyph,
  experimental_VoiceInputTextarea,
  experimental_copyToClipboard,
  experimental_useAppPanel,
  experimental_useArchiveEnvironmentThreads,
  experimental_useBranches,
  experimental_useCheckoutState,
  experimental_useCodeTheme,
  experimental_useFixedTabTarget,
  experimental_usePluginId,
  experimental_useProviders,
  experimental_useQuestionFormHost,
  experimental_useSidebarProjectActions,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  experimental_useThreadActionRegistrations,
  experimental_useThreadActions,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useComposers,
  useEnvironmentProviders,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  useSettings,
  useSidebarSplitLayout,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarThreadShortcut
};
