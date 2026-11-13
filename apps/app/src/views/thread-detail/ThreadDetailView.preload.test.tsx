// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const chat = vi.hoisted(() => ({ downloads: vi.fn(), timeline: vi.fn() }));

vi.mock("./ThreadScreen", () => {
  chat.downloads();
  return { ThreadScreen: () => null, useThreadComposerAddToChat: () => () => {} };
});

vi.mock("@/components/thread/timeline/ThreadTimelineSurface", () => {
  chat.timeline();
  return { ThreadTimelineSurface: () => null };
});

it("preloads the native thread route without downloading its unused chat screen", async () => {
  await import("./ThreadDetailView");
  expect(chat.downloads).not.toHaveBeenCalled();
  expect(chat.timeline).not.toHaveBeenCalled();
});
