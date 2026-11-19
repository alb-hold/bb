import fs from "node:fs/promises";
import path from "node:path";
import { setupMigratedConnectionTemplate } from "@bb/db/testing";
import { readProcessIdentity } from "@bb/process-utils";
import { readPositivePidFile } from "@bb/test-helpers";
import { removePathWithRetry } from "./helpers/remove-path.js";
import {
  HARNESS_TMP_ROOT_PREFIX,
  integrationTmpBase,
} from "./helpers/tmp-base.js";
import {
  killProcessesHoldingFilesUnder,
} from "./helpers/tmp-root-processes.js";
import { setupBuiltinHostBuildRecords } from "./helpers/builtin-plugin-fixture.js";

import { setupTestGitRepoTemplate } from "./helpers/seed.js";

const STALE_TMP_ROOT_AGE_MS = 60 * 60_000;
const PS_START_TIME_RESOLUTION_MS = 1_000;

async function cleanupTmpRoot(tmpRoot: string): Promise<void> {
  await killProcessesHoldingFilesUnder(tmpRoot, { exclude: [] });
  await removePathWithRetry(tmpRoot);
}

async function hasLiveOwner(tmpRoot: string): Promise<boolean> {
  const pidFilePath = path.join(tmpRoot, "parent.pid");
  const writer = await readPositivePidFile(pidFilePath);
  if (writer === null) return false;
  const recordedAt = (await fs.stat(pidFilePath)).mtimeMs;
  const identity = await readProcessIdentity(writer);
  if (identity === null) return false;
  return (
    identity.startedAt === null ||
    identity.startedAt <= recordedAt + PS_START_TIME_RESOLUTION_MS
  );
}

async function listIntegrationTmpRoots(): Promise<string[]> {
  const entries = await fs.readdir(integrationTmpBase(), {
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(HARNESS_TMP_ROOT_PREFIX),
    )
    .map((entry) => path.join(integrationTmpBase(), entry.name));
}

async function sweepIntegrationTmpRoots(minAgeMs: number): Promise<void> {
  const now = Date.now();
  for (const tmpRoot of await listIntegrationTmpRoots()) {
    const metadata = await fs.stat(tmpRoot).catch(() => null);
    if (!metadata || now - metadata.mtimeMs < minAgeMs) {
      continue;
    }

    if (await hasLiveOwner(tmpRoot)) {
      continue;
    }

    await cleanupTmpRoot(tmpRoot).catch(() => undefined);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await sweepIntegrationTmpRoots(STALE_TMP_ROOT_AGE_MS);
  const cleanupDatabaseTemplate = setupMigratedConnectionTemplate();
  let cleanupRepoTemplate: (() => Promise<void>) | undefined;
  try {
    cleanupRepoTemplate = await setupTestGitRepoTemplate();
    const cleanupBuiltinRecords = await setupBuiltinHostBuildRecords();
    return async () => {
      try {
        await sweepIntegrationTmpRoots(0);
      } finally {
        try {
          cleanupDatabaseTemplate();
          await cleanupBuiltinRecords();
        } finally {
          await cleanupRepoTemplate?.();
        }
      }
    };
  } catch (error) {
    cleanupDatabaseTemplate();
    await cleanupRepoTemplate?.();
    throw error;
  }
}
