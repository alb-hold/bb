import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWritingUsage,
  getWritingUsage,
  reserveWritingUsage,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../../src/testing.js";

function storedUsageKeys(db: DbConnection): string[] {
  return db.$client
    .prepare(
      "SELECT key FROM app_settings_values WHERE key LIKE 'writingAssistanceUsage%' ORDER BY key",
    )
    .all()
    .map((row) => (row as { key: string }).key);
}

describe("writing assistance usage", () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createMigratedConnection();
  });

  afterEach(() => {
    db.$client.close();
  });

  it("keeps the next day's totals when a request reserved before midnight finishes after it", () => {
    reserveWritingUsage(db, "2026-10-17", { corrections: 1 }, () => true);
    reserveWritingUsage(db, "2026-10-18", { corrections: 5 }, () => true);
    addWritingUsage(db, "2026-10-17", { corrections: -1 });
    addWritingUsage(db, "2026-10-17", { inputChars: 40, outputChars: 12 });
    expect(getWritingUsage(db, "2026-10-18")).toMatchObject({
      day: "2026-10-18",
      corrections: 5,
      inputChars: 0,
    });
    expect(
      reserveWritingUsage(
        db,
        "2026-10-18",
        { corrections: 1 },
        (current) => current.corrections < 5,
      ),
    ).toBeNull();
    expect(getWritingUsage(db, "2026-10-18").corrections).toBe(5);
    expect(getWritingUsage(db, "2026-10-17")).toMatchObject({
      corrections: 0,
      inputChars: 40,
    });
  });

  it("carries today's usage stored under the old single key and then removes that key", () => {
    db.$client
      .prepare(
        "INSERT INTO app_settings_values (key, value, updated_at) VALUES (?, ?, ?)",
      )
      .run(
        "writingAssistanceUsage",
        JSON.stringify({
          day: "2026-10-17",
          corrections: 3,
          formattings: 0,
          dictationSegments: 0,
          audioSeconds: 0,
          inputChars: 0,
          outputChars: 0,
          estimatedCostMicros: 0,
        }),
        Date.now(),
      );
    expect(getWritingUsage(db, "2026-10-17").corrections).toBe(3);
    reserveWritingUsage(db, "2026-10-17", { corrections: 1 }, () => true);
    expect(getWritingUsage(db, "2026-10-17").corrections).toBe(4);
    expect(storedUsageKeys(db)).toEqual(["writingAssistanceUsage:2026-10-17"]);
  });

  it("keeps the previous day and drops older days when usage is recorded", () => {
    for (const day of ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]) {
      addWritingUsage(db, day, { corrections: 1 });
    }
    expect(storedUsageKeys(db)).toEqual([
      "writingAssistanceUsage:2026-10-16",
      "writingAssistanceUsage:2026-10-17",
    ]);
  });
});
