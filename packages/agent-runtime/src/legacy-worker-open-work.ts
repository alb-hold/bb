import { execHostFile, readProcessStartIdentity } from "@bb/process-utils";
import { listDescendantPids } from "@bb/provider-bridge-protocol/bridge-kit";

export type BackgroundScopedItemKind = "backgroundTask" | "delegation";

export const LEGACY_CLAUDE_CODE_BRIDGE_PLUGIN_ID = "provider-claude-code";

export type LegacyProviderChildDescendantState =
  | "none"
  | "has_descendants"
  | "unknown";

export const FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS = {
  "provider-acp": [],
  "provider-claude-code": ["backgroundTask", "delegation"],
  "provider-codex": [],
  "provider-pi": [],
} as const satisfies Record<string, readonly BackgroundScopedItemKind[]>;

export function legacyWorkerAssumesZeroOpenBackgroundWork(
  pluginId: string,
): boolean {
  if (
    !Object.hasOwn(FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS, pluginId)
  ) {
    return false;
  }
  const items =
    FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS[
      pluginId as keyof typeof FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS
    ];
  return items.length === 0;
}

const PS_ROW_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u;

export function hasLiveProviderChildDescendants(
  psOutput: string,
  workerPid: number,
): LegacyProviderChildDescendantState {
  if (!Number.isSafeInteger(workerPid) || workerPid <= 0) {
    return "unknown";
  }
  let sawLiveWorker = false;
  const providerChildPids: number[] = [];
  const liveRows: string[] = [];

  for (const row of psOutput.split("\n")) {
    if (row.trim() === "") continue;
    const match = PS_ROW_PATTERN.exec(row);
    if (match === null) {
      return "unknown";
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const stat = match[3] ?? "";
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      stat === ""
    ) {
      return "unknown";
    }
    if (pid === workerPid) {
      if (stat.startsWith("Z")) {
        return "unknown";
      }
      sawLiveWorker = true;
    }
    if (stat.startsWith("Z")) {
      continue;
    }
    liveRows.push(`${pid} ${ppid}`);
    if (ppid === workerPid) {
      providerChildPids.push(pid);
    }
  }

  if (!sawLiveWorker) {
    return "unknown";
  }
  if (providerChildPids.length === 0) {
    return "none";
  }
  const liveTable = liveRows.join("\n");
  for (const providerChildPid of providerChildPids) {
    if (listDescendantPids(liveTable, providerChildPid).length > 0) {
      return "has_descendants";
    }
  }
  return "none";
}

export interface InspectLegacyWorkerDescendantsArgs {
  workerPid: number | null | undefined;
  expectedWorkerIdentity: string | null | undefined;
}

export async function inspectLegacyWorkerProviderChildDescendants(
  args: InspectLegacyWorkerDescendantsArgs,
): Promise<LegacyProviderChildDescendantState> {
  if (process.platform === "win32") {
    return "unknown";
  }
  if (
    typeof args.workerPid !== "number" ||
    !Number.isSafeInteger(args.workerPid) ||
    args.workerPid <= 0 ||
    typeof args.expectedWorkerIdentity !== "string" ||
    args.expectedWorkerIdentity.length === 0
  ) {
    return "unknown";
  }
  try {
    const { stdout } = await execHostFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,stat="],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5_000,
      },
    );
    const currentIdentity = await readProcessStartIdentity(args.workerPid);
    if (currentIdentity !== args.expectedWorkerIdentity) {
      return "unknown";
    }
    return hasLiveProviderChildDescendants(stdout, args.workerPid);
  } catch {
    return "unknown";
  }
}
