import { eq } from "drizzle-orm";
import {
  defaultWritingAssistanceSettings,
  writingAssistanceSettingsSchema,
  writingUsageSchema,
  type WritingAssistanceSettings,
  type WritingAssistanceSettingsUpdate,
  type WritingUsage,
} from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { appSettingsValues } from "../schema.js";

const WRITING_SETTINGS_KEY = "writingAssistanceSettings";
const WRITING_USAGE_KEY = "writingAssistanceUsage";

function readValue(db: DbQueryConnection, key: string): unknown {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, key))
    .get();
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

function writeValue(db: DbQueryConnection, key: string, value: unknown): void {
  const text = JSON.stringify(value);
  const updatedAt = Date.now();
  db.insert(appSettingsValues)
    .values({ key, value: text, updatedAt })
    .onConflictDoUpdate({
      target: appSettingsValues.key,
      set: { value: text, updatedAt },
    })
    .run();
}

export function getWritingAssistanceSettings(
  db: DbConnection,
): WritingAssistanceSettings {
  const stored = readValue(db, WRITING_SETTINGS_KEY);
  const settings: WritingAssistanceSettings = {
    ...defaultWritingAssistanceSettings,
  };
  if (typeof stored !== "object" || stored === null) return settings;
  const shape = writingAssistanceSettingsSchema.shape;
  for (const key of Object.keys(shape) as (keyof WritingAssistanceSettings)[]) {
    const parsed = shape[key].safeParse(Reflect.get(stored, key));
    if (parsed.success) Reflect.set(settings, key, parsed.data);
  }
  return settings;
}

export function updateWritingAssistanceSettings(
  db: DbConnection,
  update: WritingAssistanceSettingsUpdate,
): WritingAssistanceSettings {
  const next = writingAssistanceSettingsSchema.parse({
    ...getWritingAssistanceSettings(db),
    ...update,
  });
  writeValue(db, WRITING_SETTINGS_KEY, next);
  return next;
}

export function emptyWritingUsage(day: string): WritingUsage {
  return {
    day,
    corrections: 0,
    formattings: 0,
    dictationSegments: 0,
    audioSeconds: 0,
    inputChars: 0,
    outputChars: 0,
    estimatedCostMicros: 0,
  };
}

export function getWritingUsage(db: DbQueryConnection, day: string): WritingUsage {
  const parsed = writingUsageSchema.safeParse(readValue(db, WRITING_USAGE_KEY));
  return parsed.success && parsed.data.day === day
    ? parsed.data
    : emptyWritingUsage(day);
}

export function addWritingUsage(
  db: DbConnection,
  day: string,
  delta: Partial<Omit<WritingUsage, "day">>,
): WritingUsage {
  return db.transaction((tx) => {
    const current = getWritingUsage(tx, day);
    const next: WritingUsage = {
      day,
      corrections: current.corrections + (delta.corrections ?? 0),
      formattings: current.formattings + (delta.formattings ?? 0),
      dictationSegments:
        current.dictationSegments + (delta.dictationSegments ?? 0),
      audioSeconds:
        Math.round((current.audioSeconds + (delta.audioSeconds ?? 0)) * 10) /
        10,
      inputChars: current.inputChars + (delta.inputChars ?? 0),
      outputChars: current.outputChars + (delta.outputChars ?? 0),
      estimatedCostMicros:
        current.estimatedCostMicros + (delta.estimatedCostMicros ?? 0),
    };
    writeValue(tx, WRITING_USAGE_KEY, next);
    return next;
  });
}
