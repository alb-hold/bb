import { pluginIdSchema } from "@bb/domain";
import { z } from "zod";

const stockWaitHostNameSchema = z.string().min(1).max(200);
const stockWaitReasonSchema = z.string().min(1).max(200);

export const stockQueuedMessageWaitingOnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time") }),
  z.object({ kind: z.literal("thread-busy") }),
  z.object({ kind: z.literal("stopping") }),
  z.object({ kind: z.literal("turn-starting") }),
  z.object({ kind: z.literal("provisioning") }),
  z.object({
    kind: z.literal("host-offline"),
    hostName: stockWaitHostNameSchema,
  }),
  z.object({ kind: z.literal("interaction") }),
  z.object({
    kind: z.literal("workspace-busy"),
    holderThreadId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("plugin"),
    pluginId: pluginIdSchema,
    reason: stockWaitReasonSchema,
  }),
]);

type StockQueuedMessageWaitingOn = z.infer<
  typeof stockQueuedMessageWaitingOnSchema
>;

export function parseStockStoredWaitingOn(
  rawWaitingOn: string,
): StockQueuedMessageWaitingOn {
  return stockQueuedMessageWaitingOnSchema.parse(JSON.parse(rawWaitingOn));
}

export function stockTimeWaitIsDue(args: {
  waitingOn: StockQueuedMessageWaitingOn;
  sendAt: number | null;
  now: number;
}): boolean {
  return (
    args.waitingOn.kind === "time" &&
    args.sendAt !== null &&
    args.sendAt <= args.now
  );
}
