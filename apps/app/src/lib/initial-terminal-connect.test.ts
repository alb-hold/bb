// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";

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
    if (route === "native")
      expect(prefetchTerminalSocket).toHaveBeenCalledWith(
        expect.stringMatching(/early-terminal.*handoffOwnerToken=local-device/),
      );
    else expect(prefetchTerminalSocket).not.toHaveBeenCalled();
  },
);
