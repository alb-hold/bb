// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const chat = vi.hoisted(() => ({ downloads: vi.fn() }));

vi.mock("./ThreadScreen", () => {
  chat.downloads();
  return { ThreadScreen: () => null, useThreadComposerAddToChat: () => () => {} };
});

it("preloads the native thread route without downloading its unused chat screen", async () => {
  await import("./ThreadDetailView");
  expect(chat.downloads).not.toHaveBeenCalled();
});
