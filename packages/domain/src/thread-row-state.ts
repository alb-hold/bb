import { z } from "zod";

export const threadRowStatusSchema = z
  .object({
    value: z.string().min(1).max(120),
    icon: z.string().min(1).max(32).optional(),
    color: z.string().min(1).max(32).optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
  })
  .strict();

export const threadRowProgressSchema = z
  .object({
    value: z.number().finite().min(0).max(1),
    label: z.string().max(120).optional(),
  })
  .strict();

export const threadRowStateSchema = z
  .object({
    statuses: z.record(z.string().min(1).max(40), threadRowStatusSchema).refine(
      (statuses) => Object.keys(statuses).length <= 8,
    ),
    progress: threadRowProgressSchema.nullable(),
  })
  .strict();

export type ThreadRowStatus = z.infer<typeof threadRowStatusSchema>;
export type ThreadRowProgress = z.infer<typeof threadRowProgressSchema>;
export type ThreadRowState = z.infer<typeof threadRowStateSchema>;
