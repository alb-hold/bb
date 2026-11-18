import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PluginProcessDataKind = "host-data" | "bridge-data";

export const PLUGIN_PROCESS_DATA_KINDS: readonly PluginProcessDataKind[] = [
  "host-data",
  "bridge-data",
];

export function safePluginSegment(pluginId: string): string {
  return encodeURIComponent(pluginId);
}

export function pluginProcessDataDir(args: {
  daemonDataDir: string;
  pluginId: string;
  kind: PluginProcessDataKind;
}): string {
  return join(
    args.daemonDataDir,
    "plugins",
    safePluginSegment(args.pluginId),
    args.kind,
  );
}

export async function ensurePluginProcessDataDir(args: {
  daemonDataDir: string;
  pluginId: string;
  kind: PluginProcessDataKind;
}): Promise<string> {
  const directory = pluginProcessDataDir(args);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function createPluginProcessTempDir(args: {
  pluginId: string;
  prefix: string;
}): Promise<string> {
  return mkdtemp(
    join(tmpdir(), `${args.prefix}-${safePluginSegment(args.pluginId)}-`),
  );
}
