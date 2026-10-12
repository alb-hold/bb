import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvictedRecordIndex } from "../native-activity-index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function transcript(ids: string[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-native-index-"));
  roots.push(root);
  mkdirSync(path.join(root, "session"));
  const file = path.join(root, "session", "transcript.jsonl");
  let offset = 0;
  const lines = ids.map((id) => {
    const line = JSON.stringify({ uuid: id, message: "Unicode: \u{1f642}" });
    const location = { offset, length: Buffer.byteLength(line) };
    offset += location.length + 1;
    return { line, location };
  });
  writeFileSync(file, lines.map(({ line }) => `${line}\n`).join(""));
  return { file, lines };
}

describe("evicted native transcript identity index", () => {
  it("confirms hash collisions at their original offsets without rejecting fresh UUIDs", () => {
    const { file, lines } = transcript(["first", "second"]);
    const index = new EvictedRecordIndex("uuid");
    Reflect.set(index, "hash", () => 7n);
    index.add("first", lines[0].location);
    index.add("second", lines[1].location);
    expect(index.has("first", file)).toBe(true);
    expect(index.has("second", file)).toBe(true);
    expect(index.has("fresh", file)).toBe(false);
  });

  it("grows without saturation and keeps fresh identities free of confirmation reads", () => {
    const count = 50000;
    const ids = Array.from({ length: count }, (_, index) => `evicted-${index}`);
    const { file, lines } = transcript(ids);
    const index = new EvictedRecordIndex("uuid");
    for (let offset = 0; offset < count; offset += 1) {
      index.add(ids[offset], lines[offset].location);
    }
    expect(index.byteLength).toBeLessThanOrEqual(count * 54);
    let confirmations = 0;
    const matches: unknown = Reflect.get(index, "matches");
    if (typeof matches !== "function")
      throw new Error("Index confirmation unavailable");
    Reflect.set(index, "matches", (...args: unknown[]) => {
      confirmations += 1;
      return matches.apply(index, args);
    });
    for (let offset = 0; offset < 10000; offset += 1) {
      expect(index.has(`fresh-${offset}`, file)).toBe(false);
    }
    expect(confirmations).toBe(0);
    expect(index.has(ids[0], file)).toBe(true);
    expect(index.has(ids[count - 1], file)).toBe(true);
    expect(confirmations).toBe(2);
  });

  describe.each([
    ["unreadable", true, (file: string) => rmSync(file)],
    ["short", true, (file: string) => truncateSync(file, 5)],
    [
      "unparseable",
      true,
      (file: string) => writeFileSync(file, "x".repeat(200)),
    ],
    [
      "changed",
      false,
      (file: string) => {
        const length = Buffer.byteLength(
          JSON.stringify({ uuid: "stored", message: "Unicode: \u{1f642}" }),
        );
        const line = JSON.stringify({ uuid: "other", pad: "" });
        writeFileSync(
          file,
          `${JSON.stringify({ uuid: "other", pad: "p".repeat(length - Buffer.byteLength(line)) })}\n`,
        );
      },
    ],
  ])("with a colliding stored line that is %s", (_, counted, damage) => {
    it("keeps the fresh UUID eligible and reports unconfirmed reads at each power of ten", () => {
      const { file, lines } = transcript(["stored"]);
      const logged: number[] = [];
      const index = new EvictedRecordIndex("uuid", (total) =>
        logged.push(total),
      );
      Reflect.set(index, "hash", () => 7n);
      index.add("stored", lines[0].location);
      expect(index.has("stored", file)).toBe(true);
      damage(file);
      expect(index.has("fresh", file)).toBe(false);
      expect(index.has("stored", file)).toBe(false);
      expect(index.unconfirmedReads).toBe(counted ? 2 : 0);
      for (let call = 0; call < 20; call += 1) index.has("fresh", file);
      expect(logged).toEqual(counted ? [1, 10] : []);
    });
  });
});
