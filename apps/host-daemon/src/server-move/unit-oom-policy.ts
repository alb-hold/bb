import { readdir, readFile, rm } from "node:fs/promises";
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

interface DropInScan {
  names: ReadonlySet<string>;
  setsOomPolicy: boolean;
}

async function scanDropIns(dropInDir: string): Promise<DropInScan> {
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
    if (!name.endsWith(".conf")) {
      continue;
    }
    try {
      const text = await readFile(join(dropInDir, name), "utf8");
      if (OOM_POLICY_DIRECTIVE.test(text)) {
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
  if (OOM_POLICY_DIRECTIVE.test(definition.content)) {
    return "already-current";
  }
  const dropInDir = `${definition.path}.d`;
  const scan = await scanDropIns(dropInDir);
  if (scan.setsOomPolicy) {
    return "already-current";
  }
  const dropInPath = join(dropInDir, freeDropInName(scan.names));
  await writeFileAtomically({
    path: dropInPath,
    content: OOM_POLICY_DROP_IN_CONTENT,
    mode: 0o644,
  });
  try {
    await args.runCommand("systemctl", ["--user", "daemon-reload"]);
  } catch (error) {
    await rm(dropInPath, { force: true });
    throw error;
  }
  return "migrated";
}
