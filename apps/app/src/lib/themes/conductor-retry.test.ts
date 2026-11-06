import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppThemeCss } from "./index";

const themeImport = vi.hoisted(() => ({
  active: null as {
    themeId: string;
    css: string;
    attempts: number;
    failed: () => void;
  } | null,
}));

vi.mock("../retryable-chunk-import", async (importOriginal) => {
  const retryable =
    await importOriginal<typeof import("../retryable-chunk-import")>();
  return {
    ...retryable,
    createRetryableChunkImport: <T>(load: () => Promise<T>) =>
      retryable.createRetryableChunkImport(() =>
        load().catch((error: unknown) => {
          themeImport.active?.failed();
          if (error instanceof Error && error.cause instanceof Error) {
            throw error.cause;
          }
          throw error;
        }),
      ),
  };
});

vi.mock("./conductor", async (importOriginal) => {
  const original = await importOriginal<typeof import("./conductor")>();
  const active = themeImport.active;
  if (!active || active.themeId !== "conductor") return original;
  active.attempts += 1;
  if (active.attempts === 1) {
    throw new Error("Failed to fetch dynamically imported module");
  }
  return { ...original, conductorThemeCss: active.css };
});

vi.mock("./conductor-black", async (importOriginal) => {
  const original = await importOriginal<typeof import("./conductor-black")>();
  const active = themeImport.active;
  if (!active || active.themeId !== "conductor-black") return original;
  active.attempts += 1;
  if (active.attempts === 1) {
    throw new Error("Failed to fetch dynamically imported module");
  }
  return { ...original, conductorBlackThemeCss: active.css };
});

const conductorThemes = [
  {
    themeId: "conductor",
    css: ":root { --canvas: #151110; }",
  },
  {
    themeId: "conductor-black",
    css: ":root { --canvas: #000000; }",
  },
] as const;

afterEach(() => {
  vi.useRealTimers();
  themeImport.active = null;
  vi.resetModules();
});

describe("Conductor theme loading", () => {
  it.each(conductorThemes)(
    "applies $themeId after its chunk import rejects once",
    async ({ themeId, css }) => {
      let failed = () => {};
      const rejected = new Promise<void>((resolve) => {
        failed = resolve;
      });
      const attempt = { themeId, css, attempts: 0, failed };
      themeImport.active = attempt;
      vi.useFakeTimers();
      const pendingCss = resolveAppThemeCss({
        themeId,
        customCss: null,
      });
      await rejected;
      expect(attempt.attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      const resolvedCss = await pendingCss;

      expect(attempt.attempts).toBe(2);
      expect(resolvedCss).toBe(css);
    },
  );
});
