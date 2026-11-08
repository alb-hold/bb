// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { internal_DO_NOT_USE_loadGitDiffParser } from "@get-bb/plugin-sdk/app";
vi.mock("@get-bb/plugin-sdk/app", () => ({
  internal_DO_NOT_USE_loadGitDiffParser: vi.fn(),
}));
beforeEach(() => {
  vi.resetModules();
  vi.mocked(internal_DO_NOT_USE_loadGitDiffParser).mockReset();
});

it("shares the pending parser request and keeps the host parser function", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>((done) => {
    resolve = done;
  });
  vi.mocked(internal_DO_NOT_USE_loadGitDiffParser).mockReturnValue(pending);
  const { loadGitDiffParser } = await import("./git-diff-lazy-parser");
  expect(internal_DO_NOT_USE_loadGitDiffParser).not.toHaveBeenCalled();
  const first = loadGitDiffParser();
  const second = loadGitDiffParser();
  const parseGitDiffFiles = vi.fn(() => []);
  resolve({ parseGitDiffFiles });
  expect((await first).parseGitDiffFiles).toBe(parseGitDiffFiles);
  expect(await second).toBe(await first);
  expect(internal_DO_NOT_USE_loadGitDiffParser).toHaveBeenCalledOnce();
});

it.each([null, {}, { parseGitDiffFiles: "invalid" }])(
  "rejects an invalid parser and retries on the next request (%j)",
  async (value) => {
    const parseGitDiffFiles = vi.fn(() => []);
    vi.mocked(internal_DO_NOT_USE_loadGitDiffParser)
      .mockResolvedValueOnce(value)
      .mockResolvedValueOnce({ parseGitDiffFiles });
    const { loadGitDiffParser } = await import("./git-diff-lazy-parser");
    await expect(loadGitDiffParser()).rejects.toThrow(
      "Git diff parser is unavailable",
    );
    expect((await loadGitDiffParser()).parseGitDiffFiles).toBe(
      parseGitDiffFiles,
    );
    expect(internal_DO_NOT_USE_loadGitDiffParser).toHaveBeenCalledTimes(2);
  },
);

it("retries a failed module request", async () => {
  vi.mocked(internal_DO_NOT_USE_loadGitDiffParser)
    .mockRejectedValueOnce(new Error("network failed"))
    .mockResolvedValueOnce({ parseGitDiffFiles: () => [] });
  const { loadGitDiffParser } = await import("./git-diff-lazy-parser");
  await expect(loadGitDiffParser()).rejects.toThrow("network failed");
  expect((await loadGitDiffParser()).parseGitDiffFiles("patch")).toEqual([]);
});
