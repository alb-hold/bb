import { getEventTurnId } from "./event-decode.js";
import type { ThreadEventWithMeta } from "./group-event-projection-turns.js";

export function buildUndeliveredClientRequestIds(
  events: readonly ThreadEventWithMeta[],
): ReadonlySet<string> {
  const interruptedTurnIds = new Set<string>();
  const lastItemSeqByTurn = new Map<string, number>();
  const consumedRequestIds = new Set<string>();
  const turnsWithConsumptionSignals = new Set<string>();
  for (const { event, meta } of events) {
    if (event.type === "turn/completed" && event.status === "interrupted") {
      const turnId = getEventTurnId(event);
      if (typeof turnId === "string") interruptedTurnIds.add(turnId);
      continue;
    }
    if (!event.type.startsWith("item/")) continue;
    const turnId = getEventTurnId(event);
    if (typeof turnId !== "string") continue;
    const item = "item" in event ? event.item : undefined;
    if (
      item?.type === "userMessage" &&
      item.clientRequestId !== undefined &&
      event.type === "item/completed"
    ) {
      consumedRequestIds.add(item.clientRequestId);
      turnsWithConsumptionSignals.add(turnId);
      continue;
    }
    lastItemSeqByTurn.set(
      turnId,
      Math.max(lastItemSeqByTurn.get(turnId) ?? meta.seq, meta.seq),
    );
  }
  const undelivered = new Set<string>();
  const firstAcceptedSeqByTurn = new Map<string, number>();
  for (const { event, meta } of events) {
    if (event.type !== "turn/input/accepted") continue;
    const turnId = getEventTurnId(event);
    if (typeof turnId !== "string" || !interruptedTurnIds.has(turnId)) continue;
    const firstAcceptedSeq = firstAcceptedSeqByTurn.get(turnId) ?? meta.seq;
    firstAcceptedSeqByTurn.set(turnId, firstAcceptedSeq);
    if (consumedRequestIds.has(event.clientRequestId)) continue;
    const isFirstInput = firstAcceptedSeq === meta.seq;
    const providerReportsConsumption = turnsWithConsumptionSignals.has(turnId);
    const sawItemAfterInput = (lastItemSeqByTurn.get(turnId) ?? -1) > meta.seq;
    if (isFirstInput && !providerReportsConsumption && sawItemAfterInput) {
      continue;
    }
    undelivered.add(event.clientRequestId);
  }
  return undelivered;
}
