import { createContext, useContext } from "react";
import type { ThreadTimelineTurnSummaryDetailsQueryIdentity } from "@/hooks/queries/query-keys";

export interface TimelineDetailSource {
  sourceSeqEnd: number;
  sourceSeqStart: number;
  threadId: string;
  turnId: string | null;
}

export const TimelineDetailSourceContext =
  createContext<TimelineDetailSource | null>(null);

export function timelineDetailIdentity(
  row: TimelineDetailSource,
  threadId: string | undefined,
  itemId: string | null,
): ThreadTimelineTurnSummaryDetailsQueryIdentity {
  return {
    itemId,
    sourceSeqEnd: row.sourceSeqEnd,
    sourceSeqStart: row.sourceSeqStart,
    threadId: threadId ?? row.threadId,
    turnId: row.turnId ?? "",
  };
}

export function useTimelineDetailIdentity(
  row: TimelineDetailSource,
  threadId: string | undefined,
  itemId: string | null,
): ThreadTimelineTurnSummaryDetailsQueryIdentity {
  const enclosing = useContext(TimelineDetailSourceContext);
  const source = enclosing?.threadId === row.threadId ? enclosing : row;
  return {
    itemId,
    sourceSeqEnd: source.sourceSeqEnd,
    sourceSeqStart: source.sourceSeqStart,
    threadId: threadId ?? source.threadId,
    turnId: source.turnId ?? "",
  };
}
