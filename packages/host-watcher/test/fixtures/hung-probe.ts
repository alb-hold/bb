import { readdir, readFile } from "node:fs/promises";

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function processGroupMembers(pgid: string): Promise<string[]> {
  const members: string[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[2] === pgid) members.push(`${entry} ${fields[0]}`);
  }
  return members;
}

export async function liveMembers(pgid: string): Promise<number> {
  return (await processGroupMembers(pgid)).filter(
    (member) => !member.endsWith(" Z"),
  ).length;
}

export async function probeGroup(started: string): Promise<string> {
  for (let wait = 0; wait < 100; wait += 1) {
    const pgid = (await readFile(started, "utf8").catch(() => "")).trim();
    if (pgid !== "") return pgid;
    await pause(50);
  }
  throw new Error("the watchman probe never started");
}

export async function until(
  done: () => Promise<boolean>,
  deadlineMs: number,
): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline && !(await done())) await pause(100);
}
