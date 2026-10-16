import { z } from "zod";
import {
  threadRowProgressSchema,
  threadRowStatusSchema,
} from "@bb/domain";
export { threadRowStateSchema } from "@bb/domain";
export type { ThreadRowState } from "@bb/domain";

export const updateThreadRowStateRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status-set"),
    key: z.string().min(1).max(40),
    status: threadRowStatusSchema,
  }).strict(),
  z.object({
    action: z.literal("status-clear"),
    key: z.string().min(1).max(40).optional(),
  }).strict(),
  z.object({
    action: z.literal("progress-set"),
    progress: threadRowProgressSchema,
  }).strict(),
  z.object({ action: z.literal("progress-clear") }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
]);

export type UpdateThreadRowStateRequest = z.infer<
  typeof updateThreadRowStateRequestSchema
>;

