import { describe, expect, it, vi } from "vitest";
import {
  formatTerminalFileDrop,
  getNewTerminalSelection,
  handleStagedTerminalFileDrop,
  quoteTerminalPath,
  resolveTerminalFileDropPaths,
} from "./terminal-file-drop";

describe("terminal file drop", () => {
  it("shell-quotes paths with spaces, quotes, and shell metacharacters", () => {
    expect(quoteTerminalPath("/Users/alex/Notes & 'draft'.txt")).toBe(
      "'/Users/alex/Notes & '\\''draft'\\''.txt'",
    );
  });

  it("inserts multiple local absolute paths as separate shell arguments", () => {
    expect(
      formatTerminalFileDrop([
        "/Users/alex/first file.txt",
        "/Users/alex/second.txt",
      ]),
    ).toBe("'/Users/alex/first file.txt' '/Users/alex/second.txt'");
  });

  it("does nothing when the browser supplies no local paths", () => {
    expect(formatTerminalFileDrop([])).toBe("");
    expect(formatTerminalFileDrop([""])).toBe("");
  });

  it("resolves desktop File objects and ignores browser files without a path bridge", () => {
    const files = [{ name: "one" }, { name: "two" }];
    const getPathForFile = (file: (typeof files)[number]) =>
      `/Users/alex/${file.name}`;

    expect(resolveTerminalFileDropPaths(files, getPathForFile)).toEqual([
      "/Users/alex/one",
      "/Users/alex/two",
    ]);
    expect(resolveTerminalFileDropPaths(files, undefined)).toEqual([]);
  });

  it("copies each new non-empty xterm selection once", () => {
    expect(getNewTerminalSelection("  code\nnext\n", "")).toBe(
      "  code\nnext\n",
    );
    expect(getNewTerminalSelection("word", "word")).toBeNull();
    expect(getNewTerminalSelection("  ", "word")).toBeNull();
  });

  it("deduplicates on raw selection text", () => {
    expect(getNewTerminalSelection(" word ", "word")).toBe(" word ");
    expect(getNewTerminalSelection("word", "word")).toBeNull();
    expect(getNewTerminalSelection("  ", "word")).toBeNull();
  });
});

describe("staged terminal file drop", () => {
  const screenshot = {
    name: "Screenshot 2026-11-25 at 1.35.15 AM.png",
  };
  const stagedPath = `/Users/alex/Library/Application Support/bb/dropped-files/abc/${screenshot.name}`;

  it("inserts the staged copy instead of the protected original path", async () => {
    const sendInput = vi.fn();
    const handled = await handleStagedTerminalFileDrop({
      files: [screenshot],
      stageFile: async () => stagedPath,
      onStageFailure: vi.fn(),
      isRunning: () => true,
      sendInput,
    });
    expect(handled).toBe(true);
    expect(sendInput).toHaveBeenCalledWith(`'${stagedPath}'`);
    expect(sendInput.mock.calls[0]?.[0]).not.toContain("TemporaryItems");
  });

  it("inserts no path and reports the file when staging fails", async () => {
    const sendInput = vi.fn();
    const onStageFailure = vi.fn();
    const handled = await handleStagedTerminalFileDrop({
      files: [screenshot],
      stageFile: async () => {
        throw new Error("disk full");
      },
      onStageFailure,
      isRunning: () => true,
      sendInput,
    });
    expect(handled).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
    expect(onStageFailure).toHaveBeenCalledWith(screenshot);
  });

  it("inserts the good file and reports only the failed one in a mixed drop", async () => {
    const sendInput = vi.fn();
    const onStageFailure = vi.fn();
    const bad = new File(["x"], "bad.png", { type: "image/png" });
    await handleStagedTerminalFileDrop({
      files: [screenshot, bad],
      stageFile: async (file) => {
        if (file === bad) throw new Error("nope");
        return stagedPath;
      },
      onStageFailure,
      isRunning: () => true,
      sendInput,
    });
    expect(sendInput).toHaveBeenCalledWith(`'${stagedPath}'`);
    expect(onStageFailure).toHaveBeenCalledTimes(1);
    expect(onStageFailure).toHaveBeenCalledWith(bad);
  });

  it("sends nothing once the session is no longer running", async () => {
    const sendInput = vi.fn();
    let running = true;
    const handled = await handleStagedTerminalFileDrop({
      files: [screenshot],
      onStageFailure: vi.fn(),
      stageFile: async () => {
        running = false;
        return stagedPath;
      },
      isRunning: () => running,
      sendInput,
    });
    expect(handled).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
  });
});
