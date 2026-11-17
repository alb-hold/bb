import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export interface ImportedGeminiCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  email: string | null;
  expiresAt: number | null;
}

const oauthCredsSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expiry_date: z.number().positive().nullish(),
    id_token: z.string().min(1).nullish(),
  })
  .passthrough();

const googleAccountsSchema = z
  .object({ active: z.string().email().nullish() })
  .passthrough();

function emailFromIdToken(idToken: string | null): string | null {
  const payload = idToken?.split(".")[1];
  if (payload === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const email =
      typeof parsed === "object" && parsed !== null && "email" in parsed
        ? parsed.email
        : null;
    return typeof email === "string" && email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

/**
 * gemini-cli keeps one login per `GEMINI_CLI_HOME`. An account is added by
 * pointing at the directory a `gemini` login wrote into, so each of several
 * Google accounts stays in its own isolated home.
 */
export function geminiCredentialsPath(home: string): string {
  return path.join(home, ".gemini", "oauth_creds.json");
}

export function resolveGeminiHome(home: string | undefined): string {
  return home ?? process.env.GEMINI_CLI_HOME ?? os.homedir();
}

export function parseGeminiCredentials(
  rawCreds: string,
  rawAccounts: string | null,
): ImportedGeminiCredentials {
  const creds = oauthCredsSchema.parse(JSON.parse(rawCreds));
  const idToken = creds.id_token ?? null;
  let active: string | null = null;
  if (rawAccounts !== null) {
    try {
      active =
        googleAccountsSchema.parse(JSON.parse(rawAccounts)).active ?? null;
    } catch {}
  }
  return {
    accessToken: creds.access_token,
    refreshToken: creds.refresh_token,
    idToken,
    email: active ?? emailFromIdToken(idToken),
    expiresAt: creds.expiry_date ?? null,
  };
}

export async function importGeminiCredentials(
  home?: string,
): Promise<ImportedGeminiCredentials> {
  const root = resolveGeminiHome(home);
  try {
    const rawCreds = await fs.readFile(geminiCredentialsPath(root), "utf8");
    const rawAccounts = await fs
      .readFile(path.join(root, ".gemini", "google_accounts.json"), "utf8")
      .catch(() => null);
    return parseGeminiCredentials(rawCreds, rawAccounts);
  } catch {
    throw new Error(
      "Gemini OAuth credentials were not found or usable. Sign in with `GEMINI_CLI_HOME=<dir> gemini` (choose Sign in with Google) and retry with --home <dir>.",
    );
  }
}
