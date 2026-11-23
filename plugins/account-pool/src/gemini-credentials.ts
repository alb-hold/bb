import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export type GeminiCredentialSource =
  | { kind: "file"; path: string }
  | { kind: "keychain"; service: string; account: string };

export interface ImportedGeminiCredentials {
  refreshToken: string;
  client: { clientId: string; clientSecret: string };
  projectId: string | null;
  clientSource?: "antigravity-installed-app";
  source: GeminiCredentialSource;
  storedExpiresAt: number | null;
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
  readInstalledAppClient?: InstalledAppClientReader;
}

export interface GeminiSignIn {
  refreshToken: string;
  client: { clientId: string; clientSecret: string } | null;
  installedAppClient: InstalledAppClientKind;
  projectId: string | null;
  storedExpiresAt: number | null;
}

export const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
export const ANTIGRAVITY_KEYCHAIN_ACCOUNTS = [
  "antigravity-acp",
  "antigravity",
  "antigravity-acp-business",
] as const;

export type InstalledAppClientKind = "consumer" | "business";

export type InstalledAppClientReader = (
  kind: InstalledAppClientKind,
) => Promise<{ clientId: string; clientSecret: string }>;

const ANTIGRAVITY_RUNTIME_FILE = "agy_acp_server.par";

const INSTALLED_APP_CLIENT_MARKERS: Record<
  InstalledAppClientKind,
  { id: string; secret: string }
> = {
  consumer: { id: "_DEFAULT_CLIENT_ID", secret: "_DEFAULT_CLIENT_SECRET" },
  business: { id: "_BUSINESS_CLIENT_ID", secret: "_BUSINESS_CLIENT_SECRET" },
};

const CLIENT_ID_VALUE = /^\s*=\s*\(?\s*"([0-9]{6,20}-[0-9a-z]{16,64}\.apps\.googleusercontent\.com)"/u;
const CLIENT_SECRET_VALUE = /^\s*=\s*\(?\s*"([A-Za-z0-9_-]{16,128})"/u;

export function antigravityRuntimeRoot(): string {
  return path.join(os.homedir(), ".local", "share", "antigravity-acp");
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function newestAntigravityRuntime(
  runtimeRoot: string,
): Promise<{ file: string; version: string } | null> {
  const entries = await fs.readdir(runtimeRoot).catch(() => [] as string[]);
  const versions = entries
    .filter((entry) => /^[0-9]+(\.[0-9]+){0,3}$/u.test(entry))
    .sort(compareVersions)
    .reverse();
  for (const version of versions) {
    const file = path.join(runtimeRoot, version, ANTIGRAVITY_RUNTIME_FILE);
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) return { file, version };
  }
  return null;
}

function assignedValues(
  runtime: Buffer,
  marker: string,
  value: RegExp,
): Set<string> {
  const found = new Set<string>();
  const needle = Buffer.from(marker, "latin1");
  let at = runtime.indexOf(needle);
  while (at !== -1) {
    const after = at + needle.length;
    const window = runtime.toString("latin1", after, after + 256);
    const match = value.exec(window);
    if (match?.[1] !== undefined) found.add(match[1]);
    at = runtime.indexOf(needle, after);
  }
  return found;
}

export async function readAntigravityInstalledAppClient(
  kind: InstalledAppClientKind,
  options: { runtimeRoot?: string } = {},
): Promise<{ clientId: string; clientSecret: string }> {
  const runtimeRoot = options.runtimeRoot ?? antigravityRuntimeRoot();
  const runtime = await newestAntigravityRuntime(runtimeRoot);
  if (runtime === null)
    throw new Error(
      `The Antigravity sign-in has no OAuth client of its own, and no Antigravity runtime (${ANTIGRAVITY_RUNTIME_FILE}) was found in ${runtimeRoot} to take Antigravity's installed-app client from. Update or reinstall Antigravity, then retry.`,
    );
  const notFound = new Error(
    `The Antigravity sign-in has no OAuth client of its own, and Antigravity's ${kind} installed-app client was not found in ${runtime.file} (version ${runtime.version}). Update or reinstall Antigravity, then retry.`,
  );
  const contents = await fs.readFile(runtime.file).catch(() => null);
  if (contents === null) throw notFound;
  const markers = INSTALLED_APP_CLIENT_MARKERS[kind];
  const ids = assignedValues(contents, markers.id, CLIENT_ID_VALUE);
  const secrets = assignedValues(contents, markers.secret, CLIENT_SECRET_VALUE);
  const [clientId] = ids;
  const [clientSecret] = secrets;
  if (
    ids.size !== 1 ||
    secrets.size !== 1 ||
    clientId === undefined ||
    clientSecret === undefined
  )
    throw notFound;
  return { clientId, clientSecret };
}

export const ANTIGRAVITY_TOKEN_FIELDS = [
  "refresh_token",
  "access_token",
  "expiry",
  "client_id",
  "client_secret",
  "token_uri",
] as const;

type AntigravityTokenField = (typeof ANTIGRAVITY_TOKEN_FIELDS)[number];

const TOKEN_FIELD_ALIASES: Record<AntigravityTokenField, readonly string[]> = {
  refresh_token: ["refresh_token", "refreshToken"],
  access_token: ["access_token", "accessToken"],
  expiry: ["expiry", "expiry_date", "expires_at", "expiresAt", "expiry_time"],
  client_id: ["client_id", "clientId"],
  client_secret: ["client_secret", "clientSecret"],
  token_uri: ["token_uri", "tokenUri", "token_url"],
};

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
    "The Antigravity sign-in in the macOS keychain has no refresh token that bb can read, so bb cannot renew it. Sign in through bb's Antigravity (antigravity-acp) agent, then retry.",
};

const tokenObjectSchema = z.record(z.string(), z.unknown());

type KeychainAccount = (typeof ANTIGRAVITY_KEYCHAIN_ACCOUNTS)[number];

interface ParsedTokenBlob {
  credentials: GeminiSignIn | null;
  fields: Record<AntigravityTokenField, boolean>;
}

function tokenLayers(blob: Record<string, unknown>): Record<string, unknown>[] {
  const nested = tokenObjectSchema.safeParse(blob["token"]);
  return nested.success ? [blob, nested.data] : [blob];
}

function fieldValue(
  layers: Record<string, unknown>[],
  field: AntigravityTokenField,
): unknown {
  for (const layer of layers) {
    for (const alias of TOKEN_FIELD_ALIASES[field]) {
      const value = layer[alias];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseStoredExpiry(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0
      ? Math.round(value < 1e12 ? value * 1_000 : value)
      : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/u.test(text)) return parseStoredExpiry(Number(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseTokenBlob(raw: string, account: KeychainAccount): ParsedTokenBlob {
  const blob = tokenObjectSchema.parse(JSON.parse(raw));
  const layers = tokenLayers(blob);
  const fields = Object.fromEntries(
    ANTIGRAVITY_TOKEN_FIELDS.map((field) => {
      const value = fieldValue(layers, field);
      return [
        field,
        field === "expiry"
          ? value !== undefined
          : nonEmptyString(value) !== null,
      ];
    }),
  ) as Record<AntigravityTokenField, boolean>;
  const refreshToken = nonEmptyString(fieldValue(layers, "refresh_token"));
  if (refreshToken === null) return { credentials: null, fields };
  const clientId = nonEmptyString(fieldValue(layers, "client_id"));
  const clientSecret = nonEmptyString(fieldValue(layers, "client_secret"));
  const projectId = nonEmptyString(blob["project_id"]);
  const ownClient =
    clientId !== null && clientSecret !== null
      ? { clientId, clientSecret }
      : null;
  return {
    fields,
    credentials: {
      refreshToken,
      client: ownClient,
      installedAppClient:
        account === "antigravity-acp-business" ? "business" : "consumer",
      projectId,
      storedExpiresAt: parseStoredExpiry(fieldValue(layers, "expiry")),
    },
  };
}

export function describeTokenFields(
  fields: Record<AntigravityTokenField, boolean>,
): string {
  const present = ANTIGRAVITY_TOKEN_FIELDS.filter((field) => fields[field]);
  const missing = ANTIGRAVITY_TOKEN_FIELDS.filter((field) => !fields[field]);
  return `present: ${present.length === 0 ? "none" : present.join(", ")}; missing: ${missing.length === 0 ? "none" : missing.join(", ")}`;
}

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

export function parseGeminiCredentials(raw: string): GeminiSignIn {
  const parsed = parseTokenBlob(raw, "antigravity-acp");
  if (parsed.credentials === null) throw new Error("no refresh token");
  return parsed.credentials;
}

function parseKeychainSecret(
  secret: string,
  account: KeychainAccount,
): ParsedTokenBlob | null {
  try {
    const trimmed = secret.trim();
    const raw = trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)
      ? Buffer.from(
          trimmed.slice(GO_KEYRING_BASE64_PREFIX.length),
          "base64",
        ).toString("utf8")
      : trimmed;
    return parseTokenBlob(raw, account);
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
): Promise<GeminiSignIn> {
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
): Promise<FoundSignIn> {
  const unusable: string[] = [];
  for (const account of ANTIGRAVITY_KEYCHAIN_ACCOUNTS) {
    const read = await readKeychain(ANTIGRAVITY_KEYCHAIN_SERVICE, account);
    if (read.kind === "missing") continue;
    if (read.kind !== "found") throw new Error(KEYCHAIN_MESSAGES[read.kind]);
    const parsed = parseKeychainSecret(read.secret, account);
    if (parsed?.credentials)
      return {
        signIn: parsed.credentials,
        source: {
          kind: "keychain",
          service: ANTIGRAVITY_KEYCHAIN_SERVICE,
          account,
        },
      };
    unusable.push(
      parsed === null
        ? `"${account}": not readable as JSON`
        : `"${account}": ${describeTokenFields(parsed.fields)}`,
    );
  }
  if (unusable.length === 0) throw new Error(NOT_FOUND_MESSAGE);
  throw new Error(
    `${KEYCHAIN_MESSAGES.unusable} Fields in the keychain items (service "${ANTIGRAVITY_KEYCHAIN_SERVICE}"): ${unusable.join("; ")}.`,
  );
}

interface FoundSignIn {
  signIn: GeminiSignIn;
  source: GeminiCredentialSource;
}

async function fileSignIn(home: string | undefined): Promise<FoundSignIn> {
  return {
    signIn: await importGeminiFileCredentials(home),
    source: {
      kind: "file",
      path: geminiCredentialsPath(resolveGeminiHome(home)),
    },
  };
}

async function findGeminiSignIn(
  home: string | undefined,
  deps: GeminiImportDeps,
): Promise<FoundSignIn> {
  if (home !== undefined) return fileSignIn(home);
  try {
    return await fileSignIn(undefined);
  } catch (fileError) {
    if ((deps.platform ?? process.platform) !== "darwin") throw fileError;
  }
  return importKeychainCredentials(deps.readKeychain ?? readMacKeychain);
}

export async function importGeminiCredentials(
  home?: string,
  deps: GeminiImportDeps = {},
): Promise<ImportedGeminiCredentials> {
  const { signIn, source } = await findGeminiSignIn(home, deps);
  const found = { source, storedExpiresAt: signIn.storedExpiresAt };
  if (signIn.client !== null)
    return {
      refreshToken: signIn.refreshToken,
      client: signIn.client,
      projectId: signIn.projectId,
      ...found,
    };
  const readClient =
    deps.readInstalledAppClient ?? readAntigravityInstalledAppClient;
  return {
    refreshToken: signIn.refreshToken,
    client: await readClient(signIn.installedAppClient),
    projectId: signIn.projectId,
    clientSource: "antigravity-installed-app",
    ...found,
  };
}
