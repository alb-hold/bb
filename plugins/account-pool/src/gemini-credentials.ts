import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export interface ImportedGeminiCredentials {
  refreshToken: string;
  client: { clientId: string; clientSecret: string };
  projectId: string | null;
}

export type KeychainRead =
  | { kind: "found"; secret: string }
  | { kind: "missing" }
  | { kind: "needs-allow" }
  | { kind: "denied" }
  | { kind: "timeout" }
  | { kind: "failed" };

export type KeychainReader = (
  service: string,
  account: string,
) => Promise<KeychainRead>;

export interface GeminiImportDeps {
  platform?: NodeJS.Platform;
  readKeychain?: KeychainReader;
}

export const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
export const ANTIGRAVITY_KEYCHAIN_ACCOUNTS = [
  "antigravity-acp",
  "antigravity",
] as const;

const SECURITY_CLI = "/usr/bin/security";
const KEYCHAIN_TIMEOUT_MS = 90_000;
const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";

const NOT_FOUND_MESSAGE =
  "Antigravity sign-in was not found or usable. Sign in through bb's Antigravity (antigravity-acp) agent, then retry without --home to import it from the macOS keychain; or sign in with GEMINI_HOME=<dir> and AGY_ACP_FORCE_FILE_STORAGE=1, then retry with --home <dir>.";

const HOME_NOT_FOUND_MESSAGE =
  "Antigravity sign-in was not found or usable in that folder. Sign in through bb's Antigravity (antigravity-acp) agent with GEMINI_HOME=<dir> and AGY_ACP_FORCE_FILE_STORAGE=1, then retry with --home <dir>; or omit --home to import the Antigravity sign-in saved in the macOS keychain.";

const ALLOW_HINT =
  'macOS shows a dialog that says "security wants to use your confidential information stored in "gemini" in your keychain". Click Allow. Always Allow is not needed, and it would let any program read this sign-in without asking.';

const KEYCHAIN_MESSAGES: Record<
  "needs-allow" | "denied" | "timeout" | "failed" | "unusable",
  string
> = {
  "needs-allow": `macOS did not let bb read the Antigravity sign-in from the keychain without asking, and no one could answer here. Run the import again from the Mac's logged-in desktop session. ${ALLOW_HINT}`,
  denied: `The request to read the Antigravity sign-in from the macOS keychain was declined. Run the import again. ${ALLOW_HINT}`,
  timeout: `macOS asked whether bb may read the Antigravity sign-in from the keychain, and no one answered within 90 seconds. Run the import again. ${ALLOW_HINT}`,
  failed:
    "bb could not read the Antigravity sign-in from the macOS keychain. Unlock the login keychain and retry.",
  unusable:
    "The Antigravity sign-in in the macOS keychain has no refresh token or OAuth client that bb can use. Sign in through bb's Antigravity (antigravity-acp) agent, then retry.",
};

const acpTokenSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    refresh_token: z.string().min(1),
    project_id: z.string().nullish(),
  })
  .passthrough();

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

function parseKeychainSecret(secret: string): ImportedGeminiCredentials | null {
  try {
    const trimmed = secret.trim();
    const raw = trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)
      ? Buffer.from(
          trimmed.slice(GO_KEYRING_BASE64_PREFIX.length),
          "base64",
        ).toString("utf8")
      : trimmed;
    return parseGeminiCredentials(raw);
  } catch {
    return null;
  }
}

export function keychainReadOutcome(
  error: { code?: unknown; killed?: unknown; signal?: unknown } | null,
  stdout: string,
  stderr: string,
): KeychainRead {
  if (error === null) return { kind: "found", secret: stdout };
  if (error.killed === true || error.signal != null) return { kind: "timeout" };
  const text = stderr.toLowerCase();
  if (error.code === 44 || text.includes("could not be found"))
    return { kind: "missing" };
  if (error.code === 36 || text.includes("interaction is not allowed"))
    return { kind: "needs-allow" };
  if (
    error.code === 128 ||
    error.code === 51 ||
    text.includes("canceled") ||
    text.includes("cancelled")
  )
    return { kind: "denied" };
  return { kind: "failed" };
}

export const readMacKeychain: KeychainReader = (service, account) =>
  new Promise((resolve) => {
    execFile(
      SECURITY_CLI,
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        encoding: "utf8",
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve(
          keychainReadOutcome(
            error === null
              ? null
              : {
                  code: error.code,
                  killed: error.killed,
                  signal: error.signal,
                },
            String(stdout),
            String(stderr),
          ),
        );
      },
    );
  });

export async function importGeminiFileCredentials(
  home?: string,
): Promise<ImportedGeminiCredentials> {
  try {
    return parseGeminiCredentials(
      await fs.readFile(geminiCredentialsPath(resolveGeminiHome(home)), "utf8"),
    );
  } catch {
    throw new Error(
      home === undefined ? NOT_FOUND_MESSAGE : HOME_NOT_FOUND_MESSAGE,
    );
  }
}

async function importKeychainCredentials(
  readKeychain: KeychainReader,
): Promise<ImportedGeminiCredentials> {
  let unusable = false;
  for (const account of ANTIGRAVITY_KEYCHAIN_ACCOUNTS) {
    const read = await readKeychain(ANTIGRAVITY_KEYCHAIN_SERVICE, account);
    if (read.kind === "missing") continue;
    if (read.kind !== "found") throw new Error(KEYCHAIN_MESSAGES[read.kind]);
    const credentials = parseKeychainSecret(read.secret);
    if (credentials !== null) return credentials;
    unusable = true;
  }
  throw new Error(unusable ? KEYCHAIN_MESSAGES.unusable : NOT_FOUND_MESSAGE);
}

export async function importGeminiCredentials(
  home?: string,
  deps: GeminiImportDeps = {},
): Promise<ImportedGeminiCredentials> {
  if (home !== undefined) return importGeminiFileCredentials(home);
  try {
    return await importGeminiFileCredentials();
  } catch (fileError) {
    if ((deps.platform ?? process.platform) !== "darwin") throw fileError;
  }
  return importKeychainCredentials(deps.readKeychain ?? readMacKeychain);
}
