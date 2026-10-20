import { describe, expect, it, vi } from "vitest";
import { resolveUrlOpenTarget } from "@/lib/in-app-browser-link-preference";
import {
  isTerminalLinkForThreadBrowser,
  openTerminalLinkInThreadBrowser,
} from "./terminal-link-routing";

describe("isTerminalLinkForThreadBrowser", () => {
  it.each([
    "http://localhost:8765",
    "https://dev.localhost:8765",
    "http://127.0.0.1:8765",
    "https://[::1]:8765",
  ])("routes loopback URL %s into the thread browser", (url) => {
    expect(isTerminalLinkForThreadBrowser(url, [], true)).toBe(true);
  });

  it("routes a URL on the supplied environment host into the thread browser", () => {
    expect(
      isTerminalLinkForThreadBrowser(
        "https://worker.example.test:8765",
        ["worker.example.test"],
        true,
      ),
    ).toBe(true);
  });

  it("keeps loopback URLs external when the browser is unavailable", () => {
    expect(
      isTerminalLinkForThreadBrowser("http://localhost:8765", [], false),
    ).toBe(false);
    expect(
      resolveUrlOpenTarget({
        desktopBrowserAvailable: false,
        openLinksInAppBrowser: true,
        url: "http://localhost:8765",
      }),
    ).toBe("external-browser");
  });

  it.each([
    "https://example.com",
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "not a URL",
  ])("does not claim unrelated URL %s", (url) => {
    expect(isTerminalLinkForThreadBrowser(url, [], true)).toBe(false);
  });
});

describe("openTerminalLinkInThreadBrowser", () => {
  it("opens beside the terminal in desktop layout", () => {
    const openDrawer = vi.fn();
    const requestSplit = vi.fn();
    const openTab = vi.fn(() => ({ id: "browser-tab", kind: "browser" as const }));

    expect(
      openTerminalLinkInThreadBrowser({
        isCompact: false,
        openDrawer,
        openTab,
        requestSplit,
        url: "http://localhost:8765",
      }),
    ).toBe(true);
    expect(openTab).toHaveBeenCalledWith({
      kind: "browser",
      url: "http://localhost:8765",
    });
    expect(requestSplit).toHaveBeenCalledWith("browser-tab");
    expect(openDrawer).not.toHaveBeenCalled();
  });

  it("opens the drawer in compact layout", () => {
    const openDrawer = vi.fn();
    const requestSplit = vi.fn();

    expect(
      openTerminalLinkInThreadBrowser({
        isCompact: true,
        openDrawer,
        openTab: () => ({ id: "browser-tab", kind: "browser" }),
        requestSplit,
        url: "http://localhost:8765",
      }),
    ).toBe(true);
    expect(openDrawer).toHaveBeenCalledOnce();
    expect(requestSplit).not.toHaveBeenCalled();
  });
});
