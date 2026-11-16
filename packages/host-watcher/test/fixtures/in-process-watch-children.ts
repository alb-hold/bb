import { readdir, readFile } from "node:fs/promises";
import { getParcelWatcherBackend } from "../../src/parcel-watcher-backend.js";

const dir = process.argv[2];
if (dir === undefined)
  throw new Error("usage: in-process-watch-children <dir>");

async function children(): Promise<string[]> {
  const listed: string[] = [];
  for (const task of await readdir("/proc/self/task")) {
    const text = await readFile(`/proc/self/task/${task}/children`, "utf8");
    listed.push(...text.split(/\s+/u).filter((entry) => entry !== ""));
  }
  return listed;
}

const before = new Set(await children());
const subscription = await getParcelWatcherBackend().subscribe(dir, () => {});
const started = (await children()).filter((pid) => !before.has(pid));
await subscription.unsubscribe();
process.stdout.write(`${JSON.stringify(started)}\n`);
