import { StrictMode } from "react";
import {
  traceStartupReactUpdates,
  traceStartupRoot,
} from "./lib/diagnostic-react-hooks";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ApplicationUrlDialog } from "./components/ApplicationUrlDialog";
import { AppToaster } from "./components/AppToaster";
import { registerProviderCliInstallQueryClient } from "./components/provider-cli/provider-cli-install-store";
import { initializePreferredTheme } from "./hooks/useTheme";
import { applyCachedAppThemeCss } from "./lib/app-theme-css";
import { initializeContentMeasure } from "./lib/content-measure";
import { initializeFavicon } from "./lib/favicon-color-preference";
import { installForeignDomMutationGuard } from "./lib/foreign-dom-mutation-guard";
import { installAppQueryClientBrowserEvents } from "./lib/query-client";
import { appQueryClient } from "./lib/app-query-client";
import { applyAppFrameGeometry, getBbDesktopInfo } from "./lib/bb-desktop";
import { installStaleChunkRecovery } from "./lib/stale-chunk-recovery";
import { moveStylesheetPropertiesToRegistry } from "./lib/stylesheet-property-registry";
import "./app.css";

performance.mark("app-boot-started");
traceStartupReactUpdates();
appQueryClient.getQueryCache().subscribe((event) => {
  performance.mark(`p41-query:${event.type}:${event.query.queryHash}`);
});

installStaleChunkRecovery();
installForeignDomMutationGuard();

Error.stackTraceLimit = 80;

installAppQueryClientBrowserEvents(appQueryClient);
registerProviderCliInstallQueryClient(appQueryClient);

initializePreferredTheme();
initializeContentMeasure();
applyCachedAppThemeCss();
initializeFavicon();
applyAppFrameGeometry(document.documentElement, getBbDesktopInfo());
if (typeof CSS.registerProperty === "function") {
  moveStylesheetPropertiesToRegistry(document.styleSheets, CSS);
}

const container = document.getElementById("root")!;
const root = createRoot(container, {
  onUncaughtError: (error, errorInfo) => {
    console.error(
      "[bb] uncaught render error — the app root was torn down",
      error,
      errorInfo.componentStack,
    );
  },
});
traceStartupRoot(root, container);
root.render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={appQueryClient}>
        <BrowserRouter>
          <App />
          <AppToaster />
          <ApplicationUrlDialog />
        </BrowserRouter>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
