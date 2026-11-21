import { z } from "zod";

export const uploadedPromptAttachmentSchema = z.object({
  sourceProjectId: z.string().min(1).optional(),
  type: z.enum(["localImage", "localFile"]),
  path: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number(),
});
export type UploadedPromptAttachment = z.infer<
  typeof uploadedPromptAttachmentSchema
>;
