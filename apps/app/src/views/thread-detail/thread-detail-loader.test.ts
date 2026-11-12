import { afterEach, expect, it, vi } from "vitest";

vi.mock("./ThreadDetailView", () => ({ ThreadDetailView: () => null }));

afterEach(() => {
  vi.doUnmock("./ThreadDetailView");
  vi.resetModules();
});

it("shares the early request with the route and retains the loaded component", async () => {
  vi.resetModules();
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const View = () => null;
  vi.doMock("./ThreadDetailView", async () => {
    await ready;
    return { ThreadDetailView: View };
  });
  const { loadThreadDetailView } = await import("./thread-detail-loader");
  const early = loadThreadDetailView();
  expect(loadThreadDetailView()).toBe(early);
  release();
  await expect(early).resolves.toBe(View);
  expect(loadThreadDetailView()).toBe(early);
});

it("allows the route to retry a rejected preload", async () => {
  vi.resetModules();
  vi.doMock("./ThreadDetailView", () => {
    throw new Error("route unavailable");
  });
  const { loadThreadDetailView } = await import("./thread-detail-loader");
  const early = loadThreadDetailView();
  await expect(early).rejects.toThrow("route unavailable");
  const View = () => null;
  vi.doMock("./ThreadDetailView", () => ({ ThreadDetailView: View }));
  const retry = loadThreadDetailView();
  expect(retry).not.toBe(early);
  await expect(retry).resolves.toBe(View);
});
