// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";
const warm = vi.hoisted(() => ({
  panel: vi.fn(() => Promise.resolve(null)),
  xterm: vi.fn(),
  route: vi.fn(),
  frame: vi.fn(),
}));
vi.mock("@/components/thread/terminal/native-terminal-panel-loader", () => ({
  loadNativeTerminalPanel: warm.panel,
}));
vi.mock("@/components/thread/terminal/terminal-modules", () => ({
  preloadTerminalModules: warm.xterm,
}));
vi.mock("@/views/thread-detail/LazyThreadDetailView", () => ({
  LazyThreadDetailView: { preload: warm.route },
  preloadNativeThreadFrame: warm.frame,
}));

vi.mock("@/components/thread/terminal/terminal-socket-prefetch", () => ({
  prefetchTerminalSocket: vi.fn(),
}));
vi.mock("./device-handoff-identity", () => ({
  ensureDeviceHandoffId: () => "local-device",
}));

afterEach(() => {
  delete globalThis.__bbInitialNativeTerminalRequest;
  history.replaceState({}, "", "/");
  vi.clearAllMocks();
});

it.each(["native", "other"])(
  "connects only the current route (%s) from the HTML response without React or the general socket",
  async (route) => {
    vi.resetModules();
    const readyState = vi
      .spyOn(document, "readyState", "get")
      .mockReturnValue("loading");
    let preloadedAtSocket = false;
    vi.mocked(prefetchTerminalSocket).mockImplementation(() => {
      preloadedAtSocket = warm.xterm.mock.calls.length === 1;
    });
    history.replaceState({}, "", `/threads/${route}`);
    globalThis.__bbInitialNativeTerminalRequest = {
      path: "/api/v1/threads/native/native-terminal",
      response: Promise.resolve(
        new Response(
          JSON.stringify({
            threadId: "native",
            providerId: "codex",
            displayName: "Codex",
            model: null,
            nativeSessionId: null,
            canReturnToChat: false,
            terminal: makeTerminalSession({
              id: "early-terminal",
              status: "running",
            }),
          }),
        ),
      ),
    };
    await import("./initial-terminal-connect");
    await globalThis.__bbInitialNativeTerminalRequest.response;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (route === "native") {
      expect(prefetchTerminalSocket).toHaveBeenCalledWith(
        expect.stringMatching(/early-terminal.*handoffOwnerToken=local-device/),
      );
      expect(warm.panel).toHaveBeenCalledOnce();
      expect(warm.xterm).toHaveBeenCalledOnce();
      expect(preloadedAtSocket).toBe(true);
      expect(warm.route).toHaveBeenCalledOnce();
      expect(warm.frame).toHaveBeenCalledOnce();
    } else {
      expect(prefetchTerminalSocket).not.toHaveBeenCalled();
      expect(warm.panel).not.toHaveBeenCalled();
      expect(warm.xterm).not.toHaveBeenCalled();
      expect(warm.route).not.toHaveBeenCalled();
      expect(warm.frame).not.toHaveBeenCalled();
    }
    readyState.mockRestore();
  },
);
