import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UserAutoCompactWindow =
  | { status: "value"; value: number }
  | { status: "absent" }
  | { status: "unreadable" };

export function readUserAutoCompactWindow(
  env: NodeJS.ProcessEnv = process.env,
): UserAutoCompactWindow {
  const configDir =
    env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude");
  let raw: string;
  try {
    raw = readFileSync(join(configDir, "settings.json"), "utf8");
  } catch {
    return { status: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null) return { status: "unreadable" };
  const value = (parsed as { autoCompactWindow?: unknown }).autoCompactWindow;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { status: "value", value }
    : { status: "absent" };
}
