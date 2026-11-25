import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  findServiceDefinition,
  type FindServiceDefinitionArgs,
} from "./service-definition.js";
import { isFileNotFoundError } from "./fs.js";
import type { ServerMoveCommandRunner } from "./service-manager.js";

export const OOM_POLICY_DROP_IN_NAME = "50-oom-policy.conf";
export const OOM_POLICY_DROP_IN_CONTENT = "[Service]\nOOMPolicy=continue\n";

const MAX_CREATE_ATTEMPTS = 5;
const OOM_POLICY_DIRECTIVE = /^OOMPolicy\s*=/u;

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
const SECTION_HEADER = /^\[([^\]]*)\]\s*$/u;

function setsServiceOomPolicy(text: string): boolean {
  let section = "";
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const header = SECTION_HEADER.exec(line);
    if (header !== null) {
      section = header[1] ?? "";
      continue;
    }
    if (section === "Service" && OOM_POLICY_DIRECTIVE.test(line)) {
      return true;
    }
  }
  return false;
}

export type UnitOomPolicyOutcome =
  "not-applicable" | "already-current" | "migrated";

export interface EnsureUnitOomPolicyArgs extends FindServiceDefinitionArgs {
  runCommand: ServerMoveCommandRunner;
}

interface DropInScan {
  names: ReadonlySet<string>;
  setsOomPolicy: boolean;
}

async function scanDropIns(
  dropInDir: string,
  ignoredName: string | null = null,
): Promise<DropInScan> {
  let names: string[];
  try {
    names = await readdir(dropInDir);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return { names: new Set(), setsOomPolicy: false };
    }
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".conf") || name === ignoredName) {
      continue;
    }
    try {
      const text = await readFile(join(dropInDir, name), "utf8");
      if (setsServiceOomPolicy(text)) {
        return { names: new Set(names), setsOomPolicy: true };
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }
  }
  return { names: new Set(names), setsOomPolicy: false };
}

interface CreatedDropIn {
  path: string;
  dev: number;
  ino: number;
}

async function createDropInExclusively(path: string): Promise<CreatedDropIn> {
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(OOM_POLICY_DROP_IN_CONTENT, "utf8");
    const stats = await handle.stat();
    return { path, dev: stats.dev, ino: stats.ino };
  } finally {
    await handle.close();
  }
}

async function removeIfUnchanged(created: CreatedDropIn): Promise<void> {
  try {
    const stats = await stat(created.path);
    if (stats.dev !== created.dev || stats.ino !== created.ino) {
      return;
    }
    const text = await readFile(created.path, "utf8");
    if (text !== OOM_POLICY_DROP_IN_CONTENT) {
      return;
    }
    await rm(created.path, { force: true });
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

function freeDropInName(names: ReadonlySet<string>): string {
  if (!names.has(OOM_POLICY_DROP_IN_NAME)) {
    return OOM_POLICY_DROP_IN_NAME;
  }
  let suffix = 2;
  while (names.has(`50-oom-policy-${suffix}.conf`)) {
    suffix += 1;
  }
  return `50-oom-policy-${suffix}.conf`;
}

export async function ensureUnitOomPolicy(
  args: EnsureUnitOomPolicyArgs,
): Promise<UnitOomPolicyOutcome> {
  const definition = await findServiceDefinition(args);
  if (definition === null || definition.manager !== "systemd-user") {
    return "not-applicable";
  }
  if (setsServiceOomPolicy(definition.content)) {
    return "already-current";
  }
  const dropInDir = `${definition.path}.d`;
  await mkdir(dropInDir, { recursive: true });
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const scan = await scanDropIns(dropInDir);
    if (scan.setsOomPolicy) {
      return "already-current";
    }
    const dropInName = freeDropInName(scan.names);
    const dropInPath = join(dropInDir, dropInName);
    let created: CreatedDropIn;
    try {
      created = await createDropInExclusively(dropInPath);
    } catch (error) {
      if (isFileExistsError(error)) {
        continue;
      }
      throw error;
    }
    const recheck = await scanDropIns(dropInDir, dropInName).catch(
      async (error: unknown) => {
        await removeIfUnchanged(created);
        throw error;
      },
    );
    if (recheck.setsOomPolicy) {
      await removeIfUnchanged(created);
      return "already-current";
    }
    try {
      await args.runCommand("systemctl", ["--user", "daemon-reload"]);
    } catch (error) {
      await removeIfUnchanged(created);
      throw error;
    }
    return "migrated";
  }
  throw new Error("Could not create a free OOM policy drop-in name");
}
