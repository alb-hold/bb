import { z } from "zod";

export const terminalCreateTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("thread"),
      threadId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("environment"),
      environmentId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("host_path"),
      hostId: z.string().min(1),
      cwd: z.string().trim().min(1).nullable(),
    })
    .strict(),
]);
export type TerminalCreateTarget = z.infer<typeof terminalCreateTargetSchema>;
