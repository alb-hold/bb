import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function readUserAutoCompactWindow(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const configDir =
    env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = (parsed as { autoCompactWindow?: unknown }).autoCompactWindow;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
