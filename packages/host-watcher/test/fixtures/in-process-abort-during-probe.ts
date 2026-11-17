import parcelWatcher from "@parcel/watcher";
import { getParcelWatcherBackend } from "../../src/parcel-watcher-backend.js";
import {
  liveMembers,
  probeGroup,
  processGroupMembers,
  until,
} from "./hung-probe.js";

const [dir, started] = process.argv.slice(2);
if (dir === undefined || started === undefined)
  throw new Error("usage: in-process-abort-during-probe <dir> <started>");

const late: Array<{ backend: string | undefined; unsubscribed: boolean }> = [];
const subscribe = parcelWatcher.subscribe.bind(parcelWatcher);
Object.defineProperty(parcelWatcher, "subscribe", {
  value: async (...args: Parameters<typeof subscribe>) => {
    const subscription = await subscribe(...args);
    const record = { backend: args[2]?.backend, unsubscribed: false };
    late.push(record);
    return {
      async unsubscribe() {
        record.unsubscribed = true;
        await subscription.unsubscribe();
      },
    };
  },
});

const controller = new AbortController();
const outcome = getParcelWatcherBackend()
  .subscribe(dir, () => {}, {}, controller.signal)
  .then(
    () => "subscribed",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
const pgid = await probeGroup(started);
const liveAtAbort = await liveMembers(pgid);
const abortedAt = performance.now();
controller.abort();
const settled = await outcome;
const rejectMs = performance.now() - abortedAt;
await until(
  async () =>
    late.length > 0 &&
    late.every((record) => record.unsubscribed) &&
    (await processGroupMembers(pgid)).length === 0,
  20_000,
);
process.stdout.write(
  `${JSON.stringify({
    outcome: settled,
    rejectMs,
    liveAtAbort,
    membersAfter: await processGroupMembers(pgid),
    late,
  })}\n`,
);
process.exit(0);
