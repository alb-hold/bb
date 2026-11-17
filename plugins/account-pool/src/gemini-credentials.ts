import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export interface ImportedGeminiCredentials {
  refreshToken: string;
  client: { clientId: string; clientSecret: string };
  projectId: string | null;
}

// google-auth "authorized_user" JSON, as the antigravity-acp runtime writes it
// with AGY_ACP_FORCE_FILE_STORAGE=1. It holds no access token; the runtime
// refreshes on every start.
const acpTokenSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    refresh_token: z.string().min(1),
    project_id: z.string().nullish(),
  })
  .passthrough();

/**
 * The antigravity-acp runtime keeps one login per `GEMINI_HOME`, at
 * `<home>/antigravity-acp/acp_token.json` (`~/.gemini` when GEMINI_HOME is
 * unset). An account is added by pointing at the home its sign-in wrote into,
 * so each Google account stays in its own directory.
 */
export function geminiCredentialsPath(home: string): string {
  return path.join(home, "antigravity-acp", "acp_token.json");
}

export function resolveGeminiHome(home: string | undefined): string {
  const fromEnv = process.env.GEMINI_HOME;
  return (
    home ??
    (fromEnv === undefined || fromEnv === ""
      ? path.join(os.homedir(), ".gemini")
      : fromEnv)
  );
}

export function parseGeminiCredentials(raw: string): ImportedGeminiCredentials {
  const parsed = acpTokenSchema.parse(JSON.parse(raw));
  const projectId = parsed.project_id ?? null;
  return {
    refreshToken: parsed.refresh_token,
    client: { clientId: parsed.client_id, clientSecret: parsed.client_secret },
    projectId: projectId === "" ? null : projectId,
  };
}

export async function importGeminiCredentials(
  home?: string,
): Promise<ImportedGeminiCredentials> {
  const root = resolveGeminiHome(home);
  try {
    return parseGeminiCredentials(
      await fs.readFile(geminiCredentialsPath(root), "utf8"),
    );
  } catch {
    throw new Error(
      "Antigravity sign-in was not found or usable. Sign in through bb's Antigravity (antigravity-acp) agent with GEMINI_HOME=<dir> and AGY_ACP_FORCE_FILE_STORAGE=1, then retry with --home <dir>.",
    );
  }
}
