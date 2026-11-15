import { describe, expect, it } from "vitest";
import {
  createRefusalLogOnce,
  refusalKeyIdentity,
} from "../src/refusal-log-once.js";

describe("createRefusalLogOnce", () => {
  it("reports the same key as new only the first of N times", () => {
    const log = createRefusalLogOnce();
    const seen = Array.from({ length: 6 }, () =>
      log.isNewRefusal("64769:131|holders:799:1234"),
    );
    expect(seen).toEqual([true, false, false, false, false, false]);
  });

  it("reports a changed key for the same directory as new, and a return to the old key too", () => {
    const log = createRefusalLogOnce();
    expect(log.isNewRefusal("64769:131|holders:799:1234")).toBe(true);
    expect(log.isNewRefusal("64769:131|holders:799:1234,801:1300")).toBe(true);
    expect(log.isNewRefusal("64769:131|holders:799:1234,801:1300")).toBe(false);
    expect(log.isNewRefusal("64769:131|holders:799:1234")).toBe(true);
  });

  it("keeps each directory's last key apart", () => {
    const log = createRefusalLogOnce();
    expect(log.isNewRefusal("64769:131|changed-data")).toBe(true);
    expect(log.isNewRefusal("64769:132|changed-data")).toBe(true);
    expect(log.isNewRefusal("64769:131|changed-data")).toBe(false);
    expect(log.isNewRefusal("64769:132|changed-data")).toBe(false);
  });

  it("forgets the least recently refused directory beyond its capacity", () => {
    const log = createRefusalLogOnce(2);
    log.isNewRefusal("1:1|changed-data");
    log.isNewRefusal("1:2|changed-data");
    log.isNewRefusal("1:1|changed-data");
    log.isNewRefusal("1:3|changed-data");
    expect(log.isNewRefusal("1:1|changed-data")).toBe(false);
    expect(log.isNewRefusal("1:2|changed-data")).toBe(true);
  });

  it("takes the directory identity from the part before the bar", () => {
    expect(refusalKeyIdentity("64769:131|holders:799:1234")).toBe("64769:131");
    expect(refusalKeyIdentity("64769:131")).toBe("64769:131");
  });
});
