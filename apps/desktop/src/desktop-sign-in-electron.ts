import { BrowserWindow } from "electron";
import type { DesktopSignInWindow } from "./desktop-sign-in-window.js";

interface CreateElectronSignInWindowOptions {
  show?: boolean;
}

export function createElectronSignInWindow(
  partition: string,
  parent: BrowserWindow | null,
  options: CreateElectronSignInWindowOptions = {},
): DesktopSignInWindow {
  const browserWindow = new BrowserWindow({
    height: 760,
    parent: parent ?? undefined,
    show: options.show ?? true,
    title: "Sign in",
    width: 520,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      sandbox: true,
    },
  });
  const contents = browserWindow.webContents;
  const windowSession = contents.session;
  browserWindow.once("closed", () => {
    void windowSession.clearStorageData();
  });
  return {
    partition,
    loadURL(url) {
      void browserWindow.loadURL(url);
    },
    close() {
      browserWindow.close();
    },
    isDestroyed() {
      return browserWindow.isDestroyed();
    },
    onNavigate(listener) {
      contents.on("will-navigate", (event) => listener(event, event.url));
      contents.on("will-redirect", (event) => listener(event, event.url));
    },
    onOpenWindow(listener) {
      contents.setWindowOpenHandler(({ url }) => {
        listener(url);
        return { action: "deny" };
      });
    },
    onClosed(listener) {
      browserWindow.on("closed", listener);
    },
  };
}
