import { describe, expect, it } from "vitest";
import {
  DesktopSignInWindowController,
  resolveSignInUrl,
  type DesktopSignInNavigationEvent,
  type DesktopSignInWindow,
} from "../src/desktop-sign-in-window.js";

class FakeWindow implements DesktopSignInWindow {
  loaded: string[] = [];
  closeCalls = 0;
  destroyed = false;
  navigate: (event: DesktopSignInNavigationEvent, url: string) => void =
    () => {};
  openWindow: (url: string) => void = () => {};
  closed: () => void = () => {};

  constructor(readonly partition: string) {}

  loadURL(url: string): void {
    this.loaded.push(url);
  }
  close(): void {
    this.closeCalls += 1;
    this.destroyed = true;
    this.closed();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  onNavigate(listener: typeof this.navigate): void {
    this.navigate = listener;
  }
  onOpenWindow(listener: (url: string) => void): void {
    this.openWindow = listener;
  }
  onClosed(listener: () => void): void {
    this.closed = listener;
  }
  attempt(url: string): { prevented: boolean } {
    let prevented = false;
    this.navigate({ preventDefault: () => (prevented = true) }, url);
    return { prevented };
  }
}

function setup() {
  const windows: FakeWindow[] = [];
  const controller = new DesktopSignInWindowController<null>({
    createWindow: (partition) => {
      const created = new FakeWindow(partition);
      windows.push(created);
      return created;
    },
  });
  return { controller, windows };
}

const REQUEST = {
  id: "attempt-1",
  url: "https://claude.ai/oauth/authorize?state=s",
  redirectUrlPrefix: "https://console.anthropic.com/oauth/code/callback",
};

describe("DesktopSignInWindowController", () => {
  it("opens each attempt in its own fresh non-persistent partition", async () => {
    const { controller, windows } = setup();
    void controller.open({ owner: 1, parent: null, request: REQUEST });
    void controller.open({
      owner: 1,
      parent: null,
      request: { ...REQUEST, id: "attempt-2" },
    });
    expect(windows).toHaveLength(2);
    expect(windows[0]?.partition).not.toBe(windows[1]?.partition);
    for (const created of windows) {
      expect(created.partition.startsWith("persist:")).toBe(false);
      expect(created.partition).toMatch(/^bb-sign-in-/);
    }
    expect(windows[0]?.loaded).toEqual([REQUEST.url]);
  });

  it("rejects non-http sign-in URLs and never creates a window", async () => {
    const { controller, windows } = setup();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "nope"]) {
      await expect(
        controller.open({
          owner: 1,
          parent: null,
          request: { id: "x", url },
        }),
      ).rejects.toThrow();
    }
    expect(windows).toHaveLength(0);
  });

  it("hands over the callback URL, blocks the navigation and closes", async () => {
    const { controller, windows } = setup();
    const result = controller.open({
      owner: 1,
      parent: null,
      request: REQUEST,
    });
    const callback = `${REQUEST.redirectUrlPrefix}?code=abc&state=s`;
    expect(windows[0]?.attempt(callback).prevented).toBe(true);
    await expect(result).resolves.toEqual({
      reason: "redirect",
      redirectUrl: callback,
    });
    expect(windows[0]?.closeCalls).toBe(1);
  });

  it("resolves closed when the user closes the window", async () => {
    const { controller, windows } = setup();
    const result = controller.open({
      owner: 1,
      parent: null,
      request: REQUEST,
    });
    windows[0]?.closed();
    await expect(result).resolves.toEqual({ reason: "closed" });
  });

  it("closes on request, only for the owner that opened it", async () => {
    const { controller, windows } = setup();
    const result = controller.open({
      owner: 1,
      parent: null,
      request: REQUEST,
    });
    controller.close(REQUEST.id, 2);
    expect(windows[0]?.closeCalls).toBe(0);
    controller.close(REQUEST.id, 1);
    await expect(result).resolves.toEqual({ reason: "closed" });
    expect(windows[0]?.closeCalls).toBe(1);
  });

  it("closes every window of an owner that goes away", async () => {
    const { controller, windows } = setup();
    const first = controller.open({ owner: 1, parent: null, request: REQUEST });
    const second = controller.open({
      owner: 1,
      parent: null,
      request: { ...REQUEST, id: "b" },
    });
    controller.closeOwnedBy(1);
    await expect(first).resolves.toEqual({ reason: "closed" });
    await expect(second).resolves.toEqual({ reason: "closed" });
    expect(windows.every((created) => created.destroyed)).toBe(true);
  });

  it("keeps navigation inside http(s) and follows popups in the same window", () => {
    const { controller, windows } = setup();
    void controller.open({ owner: 1, parent: null, request: REQUEST });
    expect(windows[0]?.attempt("https://claude.ai/login").prevented).toBe(
      false,
    );
    expect(windows[0]?.attempt("file:///etc/passwd").prevented).toBe(true);
    windows[0]?.openWindow("https://accounts.google.com/o/oauth2");
    windows[0]?.openWindow("javascript:alert(1)");
    expect(windows[0]?.loaded).toEqual([
      REQUEST.url,
      "https://accounts.google.com/o/oauth2",
    ]);
  });

  it("resolveSignInUrl accepts only http and https", () => {
    expect(resolveSignInUrl("https://a.test/x")).toBe("https://a.test/x");
    expect(resolveSignInUrl("mailto:a@b.c")).toBeNull();
    expect(resolveSignInUrl(5)).toBeNull();
  });
});
