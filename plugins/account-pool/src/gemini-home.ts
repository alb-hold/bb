import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GEMINI_HOME_KEY } from "./host-contract.js";

// The runtime accepts any client for an authorized_user file; the hub ignores
// it. A placeholder keeps every real client secret out of thread homes.
const PLACEHOLDER_CLIENT = "bb-account-pool";
const SETTINGS = `${JSON.stringify({ auth: { type: "oauth-personal" } })}\n`;

function homesRoot(dataDir: string): string {
  return path.join(dataDir, "gemini-homes");
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Refusing a Gemini home path that is not a directory: ${dir}`);
  await fs.chmod(dir, 0o700);
}

async function writePrivateFile(file: string, contents: string): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temp, contents, { mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * Writes the GEMINI_HOME an antigravity-acp thread runs under. Its token file
 * holds only the thread's hub token and the hub's token endpoint, so the
 * runtime's own refresh lands on the hub; no Google credential is written.
 */
export async function writeGeminiHome(options: {
  dataDir: string;
  key: string;
  refreshToken: string;
  tokenUri: string;
}): Promise<string> {
  if (!GEMINI_HOME_KEY.test(options.key))
    throw new Error("Refusing a Gemini home for an invalid thread id.");
  const root = homesRoot(options.dataDir);
  const home = path.join(root, options.key);
  const runtimeDir = path.join(home, "antigravity-acp");
  await fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  for (const dir of [root, home, runtimeDir]) await ensurePrivateDir(dir);
  await writePrivateFile(
    path.join(runtimeDir, "acp_token.json"),
    `${JSON.stringify({
      type: "authorized_user",
      client_id: PLACEHOLDER_CLIENT,
      client_secret: PLACEHOLDER_CLIENT,
      refresh_token: options.refreshToken,
      token_uri: options.tokenUri,
    })}\n`,
  );
  const settings = path.join(runtimeDir, "settings.json");
  const existing = await fs.lstat(settings).catch(() => null);
  if (existing === null) await writePrivateFile(settings, SETTINGS);
  return home;
}

/** Removes the homes of threads that no longer hold a Gemini route. */
export async function pruneGeminiHomes(options: {
  dataDir: string;
  keep: readonly string[];
}): Promise<number> {
  const keep = new Set([...options.keep, "catalog"]);
  const root = homesRoot(options.dataDir);
  const names = await fs.readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!GEMINI_HOME_KEY.test(name) || keep.has(name)) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
