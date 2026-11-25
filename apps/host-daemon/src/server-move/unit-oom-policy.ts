import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findServiceDefinition,
  type FindServiceDefinitionArgs,
} from "./service-definition.js";
import { isFileNotFoundError, writeFileAtomically } from "./fs.js";
import type { ServerMoveCommandRunner } from "./service-manager.js";

export const OOM_POLICY_DROP_IN_NAME = "50-oom-policy.conf";
export const OOM_POLICY_DROP_IN_CONTENT = "[Service]\nOOMPolicy=continue\n";

const OOM_POLICY_DIRECTIVE = /^\s*OOMPolicy\s*=/mu;

export type UnitOomPolicyOutcome =
  "not-applicable" | "already-current" | "migrated";

export interface EnsureUnitOomPolicyArgs extends FindServiceDefinitionArgs {
  runCommand: ServerMoveCommandRunner;
}

async function dropInSetsOomPolicy(dropInDir: string): Promise<boolean> {
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
    if (!name.endsWith(".conf")) {
      continue;
    }
    try {
      if (
        OOM_POLICY_DIRECTIVE.test(await readFile(join(dropInDir, name), "utf8"))
      ) {
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

export async function ensureUnitOomPolicy(
  args: EnsureUnitOomPolicyArgs,
): Promise<UnitOomPolicyOutcome> {
  const definition = await findServiceDefinition(args);
  if (definition === null || definition.manager !== "systemd-user") {
    return "not-applicable";
  }
  if (OOM_POLICY_DIRECTIVE.test(definition.content)) {
    return "already-current";
  }
  const dropInDir = `${definition.path}.d`;
  if (await dropInSetsOomPolicy(dropInDir)) {
    return "already-current";
  }
  await writeFileAtomically({
    path: join(dropInDir, OOM_POLICY_DROP_IN_NAME),
    content: OOM_POLICY_DROP_IN_CONTENT,
    mode: 0o644,
  });
  await args.runCommand("systemctl", ["--user", "daemon-reload"]);
  return "migrated";
}
