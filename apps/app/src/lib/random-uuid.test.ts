import { describe, expect, it } from "vitest";
import { randomUuid } from "@/lib/random-uuid";

describe("randomUuid", () => {
  it("returns unique RFC 4122 version 4 UUIDs without crypto.randomUUID", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      const values = Array.from({ length: 2_000 }, randomUuid);
      expect(values.every((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: original,
      });
    }
  });
});
