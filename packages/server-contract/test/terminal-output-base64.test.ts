import { terminalDataBase64Schema, TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  terminalOutputChunkSchema,
  terminalServerMessageSchema,
} from "../src/index.js";

describe("terminal output base64 boundary", () => {
  it("accepts exactly the legacy alphabet, padding and byte limits", () => {
    const values = new Set([
      "",
      "A",
      "AA",
      "AAA",
      "AAAA",
      "AA==",
      "AAA=",
      "AB==",
      "AAB=",
    ]);
    for (const size of [
      1,
      2,
      3,
      1023,
      1024,
      TERMINAL_DATA_MAX_BYTES - 1,
      TERMINAL_DATA_MAX_BYTES,
      TERMINAL_DATA_MAX_BYTES + 1,
    ]) {
      const value = Buffer.alloc(size, 255).toString("base64");
      values.add(value);
      values.add(`${value}\n`);
      values.add(value.slice(1));
      values.add(`=${value.slice(1)}`);
    }
    let seed = 38;
    const alphabet = "AZaz09+/= _-\n\r\t\0é";
    for (let iteration = 0; iteration < 4096; iteration++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      let value = "";
      const length = seed % 32;
      for (let offset = 0; offset < length; offset++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        value += alphabet[seed % alphabet.length];
      }
      values.add(value);
    }
    for (let length = 0; length < 12; length++) {
      for (let padding = 0; padding <= length; padding++) {
        values.add(`${"A".repeat(padding)}=${"A".repeat(length - padding)}`);
        values.add(`${"A".repeat(padding)}==${"A".repeat(length - padding)}`);
      }
    }
    for (const dataBase64 of values) {
      expect(
        terminalOutputChunkSchema.safeParse({ seq: 0, dataBase64 }).success,
        JSON.stringify(dataBase64.slice(0, 100)),
      ).toBe(
        dataBase64 === "" ||
          terminalDataBase64Schema.safeParse(dataBase64).success,
      );
    }
  });

  it.each([
    "AA=A",
    "AA==AA==",
    "!!!!",
    "AAAA\n",
    "AAAA=",
    "=AAA",
    "éAAA",
    "A===",
  ])(
    "rejects malformed bytes in both legacy and batched frames: %j",
    (dataBase64) => {
      const chunk = { seq: 0, dataBase64 };
      expect(
        terminalServerMessageSchema.safeParse({ type: "output", chunk })
          .success,
      ).toBe(false);
      expect(
        terminalServerMessageSchema.safeParse({
          type: "output-batch",
          chunks: [chunk],
        }).success,
      ).toBe(false);
    },
  );
});
