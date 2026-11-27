import { getEventTurnId } from "./event-decode.js";
import type { ThreadEventWithMeta } from "./group-event-projection-turns.js";

export function buildUndeliveredClientRequestIds(
  events: readonly ThreadEventWithMeta[],
): ReadonlySet<string> {
  const interruptedTurnIds = new Set<string>();
  const lastItemSeqByTurn = new Map<string, number>();
  for (const { event, meta } of events) {
    if (event.type === "turn/completed" && event.status === "interrupted") {
      const turnId = getEventTurnId(event);
      if (typeof turnId === "string") interruptedTurnIds.add(turnId);
      continue;
    }
    if (event.type.startsWith("item/")) {
      const turnId = getEventTurnId(event);
      if (typeof turnId === "string") {
        lastItemSeqByTurn.set(
          turnId,
          Math.max(lastItemSeqByTurn.get(turnId) ?? meta.seq, meta.seq),
        );
      }
    }
  }
  const undelivered = new Set<string>();
  for (const { event, meta } of events) {
    if (event.type !== "turn/input/accepted") continue;
    const turnId = getEventTurnId(event);
    if (typeof turnId !== "string" || !interruptedTurnIds.has(turnId)) continue;
    if ((lastItemSeqByTurn.get(turnId) ?? -1) > meta.seq) continue;
    undelivered.add(event.clientRequestId);
  }
  return undelivered;
}
