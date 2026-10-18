// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbDesktopApi } from "@bb/desktop-contract";
import { openSignInWindow } from "@/lib/sign-in-window";

function installDesktop(overrides: Partial<BbDesktopApi>): void {
  Object.defineProperty(window, "bbDesktop", {
    configurable: true,
    value: overrides,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "bbDesktop");
});

describe("openSignInWindow", () => {
  it("returns null outside the desktop shell so callers fall back to the browser", () => {
    expect(openSignInWindow({ url: "https://claude.ai/oauth/authorize" })).toBe(
      null,
    );
  });

  it("returns null on a desktop build without sign-in windows", () => {
    installDesktop({});
    expect(openSignInWindow({ url: "https://claude.ai/oauth/authorize" })).toBe(
      null,
    );
  });

  it("opens one uniquely identified window per call and relays the redirect", async () => {
    const open = vi.fn(async () => ({
      reason: "redirect" as const,
      redirectUrl: "https://console.anthropic.com/oauth/code/callback?code=c",
    }));
    const close = vi.fn();
    installDesktop({ openSignInWindow: open, closeSignInWindow: close });
    const first = openSignInWindow({
      url: "https://claude.ai/oauth/authorize",
      redirectUrlPrefix: "https://console.anthropic.com/oauth/code/callback",
    });
    const second = openSignInWindow({ url: "https://auth.openai.com/device" });
    const [firstRequest] = open.mock.calls[0] as unknown as [
      { id: string; redirectUrlPrefix?: string },
    ];
    const [secondRequest] = open.mock.calls[1] as unknown as [
      { id: string; redirectUrlPrefix?: string },
    ];
    expect(firstRequest.id).not.toBe(secondRequest.id);
    expect(firstRequest.redirectUrlPrefix).toBe(
      "https://console.anthropic.com/oauth/code/callback",
    );
    expect(secondRequest).not.toHaveProperty("redirectUrlPrefix");
    await expect(first?.result).resolves.toEqual({
      reason: "redirect",
      redirectUrl: "https://console.anthropic.com/oauth/code/callback?code=c",
    });
    second?.close();
    expect(close).toHaveBeenCalledWith(secondRequest.id);
  });

  it("settles closed when the shell rejects the request", async () => {
    installDesktop({
      openSignInWindow: async () => {
        throw new Error("Sign-in URL must be http or https.");
      },
      closeSignInWindow: () => {},
    });
    await expect(
      openSignInWindow({ url: "file:///x" })?.result,
    ).resolves.toEqual({ reason: "closed" });
  });
});
