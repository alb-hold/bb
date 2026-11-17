import type { ChildToParentMessage } from "../../src/parcel-subprocess/messages.js";
import { createParcelChildHandler } from "../../src/parcel-subprocess/parcel-child-handler.js";
import {
  liveMembers,
  pause,
  probeGroup,
  processGroupMembers,
  TEARDOWN_MS,
  until,
} from "./hung-probe.js";

const [dir, started] = process.argv.slice(2);
if (dir === undefined || started === undefined)
  throw new Error("usage: child-handler-cancel-during-probe <dir> <started>");

const sent: Array<{ message: ChildToParentMessage; atMs: number }> = [];
const late: Array<{ backend: string | undefined; unsubscribed: boolean }> = [];
const settles: Array<Promise<void>> = [];
let unsubscribesInFlight = 0;
const handler = createParcelChildHandler({
  parcel: {
    async subscribe(_dir, _callback, opts) {
      const record = { backend: opts?.backend, unsubscribed: false };
      late.push(record);
      return {
        unsubscribe() {
          const settle = (async () => {
            unsubscribesInFlight += 1;
            await pause(TEARDOWN_MS);
            unsubscribesInFlight -= 1;
            record.unsubscribed = true;
          })();
          settles.push(settle);
          return settle;
        },
      };
    },
  },
  send: (message) => {
    sent.push({ message, atMs: performance.now() });
  },
  listEntries: async () => [],
});

handler.handleMessage({ kind: "subscribe", id: "row", dir, opts: {} });
const pgid = await probeGroup(started);
const liveAtCancel = await liveMembers(pgid);
const cancelledAt = performance.now();
handler.handleMessage({ kind: "unsubscribe", id: "row" });
await until(async () => sent.length > 0, 5_000);
const answerMs = (sent[0]?.atMs ?? Number.POSITIVE_INFINITY) - cancelledAt;
await until(
  async () =>
    late.length > 0 &&
    late.every((record) => record.unsubscribed) &&
    (await processGroupMembers(pgid)).length === 0,
  20_000,
);
const inFlightWhenDone = unsubscribesInFlight;
await Promise.allSettled(settles);
process.stdout.write(
  `${JSON.stringify({
    messages: sent.map((entry) => entry.message),
    answerMs,
    liveAtCancel,
    membersAfter: await processGroupMembers(pgid),
    late,
    inFlightWhenDone,
  })}\n`,
);
process.exit(0);
