import { describe, expect, it } from "vitest";
import {
  formatTerminalFileDrop,
  getNewTerminalSelection,
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
