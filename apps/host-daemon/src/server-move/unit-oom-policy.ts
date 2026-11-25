import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  findServiceDefinition,
  type FindServiceDefinitionArgs,
} from "./service-definition.js";
import { isFileNotFoundError, writeFileAtomically } from "./fs.js";
import type { ServerMoveCommandRunner } from "./service-manager.js";

const execFileAsync = promisify(execFile);
const SERVICE_COMMAND_TIMEOUT_MS = 30_000;

export const OOM_POLICY_DROP_IN_NAME = "50-bb-oom-policy.conf";
export const OOM_POLICY_DROP_IN_CONTENT = "[Service]\nOOMPolicy=continue\n";

const OOM_POLICY_DIRECTIVE = /^OOMPolicy\s*=/u;
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

export type CommandOutputReader = (
  command: string,
  args: readonly string[],
) => Promise<string>;

export const defaultCommandOutputReader: CommandOutputReader = async (
  command,
  args,
) => {
  const { stdout } = await execFileAsync(command, [...args], {
    env: process.env,
    timeout: SERVICE_COMMAND_TIMEOUT_MS,
  });
  return stdout;
};

export interface EnsureUnitOomPolicyArgs extends FindServiceDefinitionArgs {
  runCommand: ServerMoveCommandRunner;
  readCommandOutput: CommandOutputReader;
}

async function otherDropInSetsOomPolicy(dropInDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dropInDir);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".conf") || name === OOM_POLICY_DROP_IN_NAME) {
      continue;
    }
    try {
      if (setsServiceOomPolicy(await readFile(join(dropInDir, name), "utf8"))) {
        return true;
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }
  }
  return false;
}

async function readOwnDropIn(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function ensureUnitOomPolicy(
  args: EnsureUnitOomPolicyArgs,
): Promise<UnitOomPolicyOutcome> {
  const definition = await findServiceDefinition(args);
  if (definition === null || definition.manager !== "systemd-user") {
    return "not-applicable";
  }
  const dropInDir = `${definition.path}.d`;
  if (
    setsServiceOomPolicy(definition.content) ||
    (await otherDropInSetsOomPolicy(dropInDir))
  ) {
    return "already-current";
  }
  const dropInPath = join(dropInDir, OOM_POLICY_DROP_IN_NAME);
  if ((await readOwnDropIn(dropInPath)) !== OOM_POLICY_DROP_IN_CONTENT) {
    await writeFileAtomically({
      path: dropInPath,
      content: OOM_POLICY_DROP_IN_CONTENT,
      mode: 0o644,
    });
  }
  const shown = await args.readCommandOutput("systemctl", [
    "--user",
    "show",
    "-p",
    "OOMPolicy",
    definition.unitName,
  ]);
  if (shown.trim() === "OOMPolicy=continue") {
    return "already-current";
  }
  await args.runCommand("systemctl", ["--user", "daemon-reload"]);
  return "migrated";
}
