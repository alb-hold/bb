import { useMutation } from "@tanstack/react-query";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { registerLocalAttachmentPreview } from "@/lib/attachment-local-previews";
import { uploadWithinPromptAttachmentLimit } from "@/lib/prompt-attachment-size";

interface UploadPromptAttachmentRequest {
  projectId: string;
  file: File;
}

export function useUploadPromptAttachment() {
  return useMutation({
    meta: {
      errorMessage: "Failed to upload attachment.",
      showErrorToast: false,
    },
    mutationFn: async ({
      projectId,
      file,
    }: UploadPromptAttachmentRequest): Promise<UploadedPromptAttachment> => {
      const uploaded = await uploadWithinPromptAttachmentLimit(file, () =>
        sdk.projects.attachments.upload({ projectId, clientFile: file }),
      );
      registerLocalAttachmentPreview(uploaded.path, file);
      return uploaded;
    },
    retry: false,
  });
}
