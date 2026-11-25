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
    size: 1024,
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
    expect(onStageFailure).toHaveBeenCalledWith(
      screenshot,
      `Couldn't attach ${screenshot.name}. Try saving it first.`,
    );
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
    expect(onStageFailure).toHaveBeenCalledWith(
      bad,
      expect.stringContaining("bad.png"),
    );
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
  it("reports an oversized file without reading it and still stages the others", async () => {
    const sendInput = vi.fn();
    const onStageFailure = vi.fn();
    const huge = new File(["x"], "huge.mov");
    Object.defineProperty(huge, "size", { value: 100 * 1024 * 1024 + 1 });
    const arrayBuffer = vi.spyOn(huge, "arrayBuffer");
    const stageFile = vi.fn(async (file: { name: string; size: number }) => {
      if (file instanceof File) await file.arrayBuffer();
      return stagedPath;
    });
    await handleStagedTerminalFileDrop({
      files: [huge, screenshot],
      stageFile,
      onStageFailure,
      isRunning: () => true,
      sendInput,
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(stageFile).toHaveBeenCalledTimes(1);
    expect(stageFile).toHaveBeenCalledWith(screenshot);
    expect(onStageFailure).toHaveBeenCalledWith(
      huge,
      "huge.mov is too large to attach (over 100 MB).",
    );
    expect(sendInput).toHaveBeenCalledWith(`'${stagedPath}'`);
  });

  it("stages files one at a time", async () => {
    const events: string[] = [];
    const second = new File(["y"], "second.png", { type: "image/png" });
    await handleStagedTerminalFileDrop({
      files: [screenshot, second],
      stageFile: async (file) => {
        events.push(`start ${file.name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`end ${file.name}`);
        return stagedPath;
      },
      onStageFailure: vi.fn(),
      isRunning: () => true,
      sendInput: vi.fn(),
    });
    expect(events).toEqual([
      `start ${screenshot.name}`,
      `end ${screenshot.name}`,
      "start second.png",
      "end second.png",
    ]);
  });
  it("keeps at most one stage in flight across overlapping drop events", async () => {
    const first = new File(["a"], "a.png");
    const second = new File(["b"], "b.png");
    const pending = new Map<string, (path: string | Error) => void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const stageFile = (file: File) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<string>((resolve, reject) => {
        pending.set(file.name, (result) => {
          inFlight -= 1;
          if (result instanceof Error) reject(result);
          else resolve(result);
        });
      });
    };
    const sendA = vi.fn();
    const sendB = vi.fn();
    const failA = vi.fn();
    const eventA = handleStagedTerminalFileDrop({
      files: [first],
      stageFile,
      onStageFailure: failA,
      isRunning: () => true,
      sendInput: sendA,
    });
    const eventB = handleStagedTerminalFileDrop({
      files: [second],
      stageFile,
      onStageFailure: vi.fn(),
      isRunning: () => true,
      sendInput: sendB,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([...pending.keys()]).toEqual(["a.png"]);
    pending.get("a.png")?.(new Error("boom"));
    await eventA;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([...pending.keys()]).toEqual(["a.png", "b.png"]);
    pending.get("b.png")?.("/tmp/bb-drop-x/b.png");
    await eventB;
    expect(maxInFlight).toBe(1);
    expect(failA).toHaveBeenCalledTimes(1);
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledWith("'/tmp/bb-drop-x/b.png'");
  });
});
