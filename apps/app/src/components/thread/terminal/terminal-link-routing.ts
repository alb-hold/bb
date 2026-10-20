import { isLoopbackHostname } from "@/lib/loopback-hostname";

interface OpenTerminalLinkInThreadBrowserArgs {
  isCompact: boolean;
  openDrawer: () => void;
  openTab: (request: { kind: "browser"; url: string }) =>
    | { kind: string; id: string }
    | null;
  requestSplit: (tabId: string) => void;
  url: string;
}

interface OpenTerminalBrowserActionArgs {
  canOpenInAppBrowser: boolean;
  openInAppBrowser: (url: string) => void;
  showExternalOpenAction: (url: string) => void;
  url: string;
}

export function terminalBrowserExternalOpenToastOptions(
  url: string,
  openExternalBrowser: (url: string) => void,
) {
  return {
    action: {
      label: "Open",
      onClick: () => openExternalBrowser(url),
    },
    description: url,
  };
}

export function isTerminalLinkForThreadBrowser(
  url: string,
  environmentHostnames: readonly string[] = [],
  canOpenInAppBrowser: boolean,
): boolean {
  if (!canOpenInAppBrowser) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    return (
      isLoopbackHostname(hostname) ||
      environmentHostnames.some(
        (environmentHostname) =>
          environmentHostname.toLowerCase().replace(/\.$/u, "") === hostname,
      )
    );
  } catch {
    return false;
  }
}

export function openTerminalLinkInThreadBrowser({
  isCompact,
  openDrawer,
  openTab,
  requestSplit,
  url,
}: OpenTerminalLinkInThreadBrowserArgs): boolean {
  const tab = openTab({ kind: "browser", url });
  if (tab?.kind !== "browser") return false;
  if (isCompact) openDrawer();
  else requestSplit(tab.id);
  return true;
}

export function openTerminalBrowserAction({
  canOpenInAppBrowser,
  openInAppBrowser,
  showExternalOpenAction,
  url,
}: OpenTerminalBrowserActionArgs): void {
  if (!canOpenInAppBrowser) {
    showExternalOpenAction(url);
    return;
  }
  openInAppBrowser(url);
}
