import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GEMINI_HOME_KEY } from "./host-contract.js";

const STALE_TOKEN_FILE = "acp_token.json";

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

async function gatewaySettings(file: string): Promise<string> {
  let settings: Record<string, unknown> = {};
  const stat = await fs.lstat(file).catch(() => null);
  if (stat?.isFile() === true) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        settings = parsed as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const auth = settings.auth;
  settings.auth = {
    ...(typeof auth === "object" && auth !== null && !Array.isArray(auth)
      ? auth
      : {}),
    type: "gateway",
  };
  return `${JSON.stringify(settings)}\n`;
}

export async function writeGeminiHome(options: {
  dataDir: string;
  key: string;
}): Promise<string> {
  if (!GEMINI_HOME_KEY.test(options.key))
    throw new Error("Refusing a Gemini home for an invalid thread id.");
  const root = homesRoot(options.dataDir);
  const home = path.join(root, options.key);
  const runtimeDir = path.join(home, "antigravity-acp");
  await fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  for (const dir of [root, home, runtimeDir]) await ensurePrivateDir(dir);
  await fs.rm(path.join(runtimeDir, STALE_TOKEN_FILE), { force: true });
  const settings = path.join(runtimeDir, "settings.json");
  await writePrivateFile(settings, await gatewaySettings(settings));
  return home;
}

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
