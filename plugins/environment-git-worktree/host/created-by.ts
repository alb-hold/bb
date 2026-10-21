import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "bb-environment-provider-host/git";
import {
  findStructuralReasons,
  gitEnvironment,
  signalOptions,
  type WorktreeIdentity,
} from "./worktree-preservation.js";

export type CopyRecord =
  | { state: "pending" }
  | { state: "recorded"; sha256: string; size: number; mode: number };

export interface CreatedBy {
  head: string;
  copies: Map<string, CopyRecord>;
}

export interface CreatedByInspection {
  reasons: string[];
  deletable: string[];
}

export function beginCopy(createdBy: CreatedBy, relativePath: string): void {
  createdBy.copies.set(relativePath, { state: "pending" });
}

async function fingerprint(
  file: string,
): Promise<{ sha256: string; size: number; mode: number } | null> {
  const before = await fs.lstat(file);
  if (!before.isFile()) return null;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  const after = await fs.lstat(file);
  if (!after.isFile() || after.size !== before.size) return null;
  return { sha256: hash.digest("hex"), size: after.size, mode: after.mode };
}

export async function recordCopy(
  createdBy: CreatedBy,
  relativePath: string,
  file: string,
): Promise<void> {
  try {
    const print = await fingerprint(file);
    if (print !== null) {
      createdBy.copies.set(relativePath, { state: "recorded", ...print });
    }
  } catch {
    return;
  }
}

type VerifyOutcome = "unchanged" | "missing" | "changed";

function isInsideWorktree(worktreePath: string, parentReal: string): boolean {
  const relative = path.relative(worktreePath, parentReal);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function verifyCopy(
  worktreePath: string,
  relativePath: string,
  record: CopyRecord,
): Promise<VerifyOutcome> {
  if (record.state !== "recorded") return "changed";
  const file = path.join(worktreePath, relativePath);
  try {
    const parentReal = await fs.realpath(path.dirname(file));
    if (!isInsideWorktree(worktreePath, parentReal)) return "changed";
    const print = await fingerprint(path.join(parentReal, path.basename(file)));
    if (print === null) return "changed";
    return print.sha256 === record.sha256 &&
      print.size === record.size &&
      print.mode === record.mode
      ? "unchanged"
      : "changed";
  } catch (error) {
    return error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "changed";
  }
}

export async function unlinkContainedCopy(
  worktreePath: string,
  relativePath: string,
): Promise<"removed" | "missing" | "refused"> {
  const file = path.join(worktreePath, relativePath);
  try {
    const parentReal = await fs.realpath(path.dirname(file));
    if (!isInsideWorktree(worktreePath, parentReal)) return "refused";
    const target = path.join(parentReal, path.basename(file));
    const info = await fs.lstat(target);
    if (!info.isFile()) return "refused";
    await fs.unlink(target);
    return "removed";
  } catch (error) {
    return error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "refused";
  }
}

function parseStatusEntries(stdout: string): {
  tracked: boolean;
  paths: string[];
} {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  let tracked = false;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === "") continue;
    const code = field.slice(0, 2);
    if (code === "??" || code === "!!") {
      paths.push(field.slice(3));
      continue;
    }
    tracked = true;
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
  }
  return { tracked, paths };
}

export async function inspectCreatedBy(
  identity: WorktreeIdentity,
  createdBy: CreatedBy,
  signal: AbortSignal | undefined,
): Promise<CreatedByInspection> {
  const reasons = await findStructuralReasons(identity);
  const gitOptions = {
    cwd: identity.path,
    env: gitEnvironment(identity.path),
    allowFailure: true,
    ...signalOptions(signal),
  };

  const head = await runGit(
    ["--no-optional-locks", "rev-parse", "HEAD"],
    gitOptions,
  );
  if (head.exitCode !== 0) {
    reasons.push("could not read HEAD");
  } else if (head.stdout.trim() !== createdBy.head) {
    reasons.push("has a HEAD that changed since this attempt created it");
  }

  const unresolved = [...createdBy.copies.values()].some(
    (record) => record.state !== "recorded",
  );
  if (unresolved) {
    reasons.push("holds a copy whose contents bb could not record");
  }

  const status = await runGit(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=traditional",
      "--ignore-submodules=none",
    ],
    gitOptions,
  );
  const deletable: string[] = [];
  if (status.exitCode !== 0) {
    reasons.push("could not read its Git status");
  } else {
    const entries = parseStatusEntries(status.stdout);
    if (entries.tracked) {
      reasons.push("has changes to tracked files");
    }
    let foreign = 0;
    for (const entry of entries.paths) {
      const record = entry.endsWith("/")
        ? undefined
        : createdBy.copies.get(entry);
      if (record === undefined) {
        foreign += 1;
      }
    }
    if (foreign > 0) {
      reasons.push(
        `has ${foreign} file(s) or folder(s) that bb did not create`,
      );
    }
  }

  for (const [relativePath, record] of createdBy.copies) {
    const outcome = await verifyCopy(identity.path, relativePath, record);
    if (outcome === "changed") {
      if (record.state === "recorded") {
        reasons.push("holds a copy that changed after bb made it");
      }
    } else if (outcome === "unchanged") {
      deletable.push(relativePath);
    }
  }
  return { reasons, deletable };
}

export async function removeVerifiedCopies(
  identity: WorktreeIdentity,
  createdBy: CreatedBy,
): Promise<string[]> {
  const reasons: string[] = [];
  for (const [relativePath, record] of createdBy.copies) {
    const outcome = await verifyCopy(identity.path, relativePath, record);
    if (outcome === "changed") {
      reasons.push("holds a copy that changed after bb made it");
      continue;
    }
    if (outcome === "missing") continue;
    if (
      (await unlinkContainedCopy(identity.path, relativePath)) === "refused"
    ) {
      reasons.push("could not remove a copy it made");
    }
  }
  return reasons;
}
