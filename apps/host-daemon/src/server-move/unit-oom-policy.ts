import { readFile } from "node:fs/promises";
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

async function readIfPresent(path: string): Promise<string | null> {
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
  if (OOM_POLICY_DIRECTIVE.test(definition.content)) {
    return "already-current";
  }
  const dropInPath = join(`${definition.path}.d`, OOM_POLICY_DROP_IN_NAME);
  if ((await readIfPresent(dropInPath)) !== null) {
    return "already-current";
  }
  await writeFileAtomically({
    path: dropInPath,
    content: OOM_POLICY_DROP_IN_CONTENT,
    mode: 0o644,
  });
  await args.runCommand("systemctl", ["--user", "daemon-reload"]);
  return "migrated";
}
