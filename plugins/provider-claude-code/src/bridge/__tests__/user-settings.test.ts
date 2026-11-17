import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUserAutoCompactWindow } from "../user-settings.js";

describe("readUserAutoCompactWindow", () => {
  let dir: string;
  const env = () => ({ CLAUDE_CONFIG_DIR: dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "user-settings-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the value when the key is a positive integer", () => {
    writeFileSync(join(dir, "settings.json"), '{"autoCompactWindow":200000}');
    expect(readUserAutoCompactWindow(env())).toEqual({
      status: "value",
      value: 200000,
    });
  });

  it("reports absent when the file is read and the key is missing or the value is invalid", () => {
    writeFileSync(join(dir, "settings.json"), "{}");
    expect(readUserAutoCompactWindow(env())).toEqual({ status: "absent" });
    writeFileSync(join(dir, "settings.json"), '{"autoCompactWindow":-1}');
    expect(readUserAutoCompactWindow(env())).toEqual({ status: "absent" });
  });

  it("reports unreadable for a missing file, partial JSON, an empty file, or a read error", () => {
    expect(readUserAutoCompactWindow(env())).toEqual({ status: "unreadable" });
    writeFileSync(join(dir, "settings.json"), '{"autoCompactWindow": 2000');
    expect(readUserAutoCompactWindow(env())).toEqual({ status: "unreadable" });
    writeFileSync(join(dir, "settings.json"), "");
    expect(readUserAutoCompactWindow(env())).toEqual({ status: "unreadable" });
    rmSync(join(dir, "settings.json"));
    mkdirSync(join(dir, "settings.json"));
    expect(readUserAutoCompactWindow(env())).toEqual({ status: "unreadable" });
  });
});
