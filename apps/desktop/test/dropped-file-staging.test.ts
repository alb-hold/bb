import { makeTempDir } from "@bb/test-helpers";
import { randomBytes } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { basename, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import {
  registerDroppedFileStagingIpc,
  stageDroppedFile,
} from "../src/dropped-file-staging.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(actual.rm),
    rmdir: vi.fn(actual.rmdir),
    unlink: vi.fn(actual.unlink),
  };
});
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

const CAP = 100 * 1024 * 1024;

function expectNoDeletes() {
  expect(fsPromises.rm).not.toHaveBeenCalled();
  expect(fsPromises.rmdir).not.toHaveBeenCalled();
  expect(fsPromises.unlink).not.toHaveBeenCalled();
}

describe("stageDroppedFile", () => {
  it("writes the bytes under the same name into a fresh private bb-drop-* directory in the temp dir", async () => {
    const tempDir = await makeTempDir("bb-temp-");
    const name = "Screenshot 2026-11-25 at 1.35.15 AM.png";
    const bytes = randomBytes(4096);

    const path = await stageDroppedFile({ tempDir, name, bytes });

    expect(basename(path)).toBe(name);
    expect(dirname(dirname(path))).toBe(tempDir);
    expect(basename(dirname(path)).startsWith("bb-drop-")).toBe(true);
    expect(await fsPromises.readFile(path)).toEqual(bytes);
    expect((await fsPromises.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fsPromises.stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  it("keeps a hostile file name inside the staging directory", async () => {
    const tempDir = await makeTempDir("bb-temp-");
    const path = await stageDroppedFile({
      tempDir,
      name: "../../escape.png",
      bytes: new Uint8Array([1]),
    });
    expect(basename(path)).toBe("escape.png");
    expect(dirname(dirname(path))).toBe(tempDir);
    await expect(
      stageDroppedFile({ tempDir, name: "..", bytes: new Uint8Array([1]) }),
    ).rejects.toThrow("no usable name");
  });

  it("gives repeated stages of the same name separate directories", async () => {
    const tempDir = await makeTempDir("bb-temp-");
    const first = await stageDroppedFile({
      tempDir,
      name: "a.png",
      bytes: new Uint8Array([1]),
    });
    const second = await stageDroppedFile({
      tempDir,
      name: "a.png",
      bytes: new Uint8Array([2]),
    });
    expect(first).not.toBe(second);
    expect(await fsPromises.readFile(first)).toEqual(Buffer.from([1]));
    expect(await fsPromises.readFile(second)).toEqual(Buffer.from([2]));
  });

  it("never deletes anything on the stage, error and repeat paths", async () => {
    const tempDir = await makeTempDir("bb-temp-");
    vi.mocked(fsPromises.rm).mockClear();
    vi.mocked(fsPromises.rmdir).mockClear();
    vi.mocked(fsPromises.unlink).mockClear();

    await stageDroppedFile({
      tempDir,
      name: "a.png",
      bytes: new Uint8Array([1]),
    });
    await stageDroppedFile({
      tempDir,
      name: "a.png",
      bytes: new Uint8Array([1]),
    });
    await expect(
      stageDroppedFile({ tempDir, name: "", bytes: new Uint8Array([1]) }),
    ).rejects.toThrow();
    await expect(
      stageDroppedFile({
        tempDir: `${tempDir}/missing`,
        name: "a.png",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow();

    expectNoDeletes();
  });
  it("rejects an over-cap payload in the main handler and stages one at the cap", async () => {
    const tempDir = await makeTempDir("bb-temp-");
    registerDroppedFileStagingIpc(new Set([1]), () => tempDir);
    const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)?.[1] as (
      event: { sender: { id: number } },
      payload: unknown,
    ) => Promise<string>;
    await expect(
      handler(
        { sender: { id: 1 } },
        { name: "big.bin", bytes: new Uint8Array(CAP + 1) },
      ),
    ).rejects.toThrow("too large");
    expect(await fsPromises.readdir(tempDir)).toEqual([]);
    const path = await handler(
      { sender: { id: 1 } },
      { name: "ok.bin", bytes: new Uint8Array(8) },
    );
    expect(basename(path)).toBe("ok.bin");
  });
});
