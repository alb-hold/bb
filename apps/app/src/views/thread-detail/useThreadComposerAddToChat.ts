import { useCallback, useMemo } from "react";
import {
  appendQuoteAndAttachmentsToDraft,
  type PromptDraftAttachment,
} from "@bb/client-core";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import type { ThreadTimelineAddToChatHandler } from "@/components/thread/timeline/types";
import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import { requestComposerFocus } from "@/lib/composer-focus-requests";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";

export function useThreadComposerAddToChat(thread: {
  id: string;
  projectId: string;
}): ThreadTimelineAddToChatHandler {
  const isCompactViewport = useIsCompactViewport();
  const promptDraft = useMemo(
    () =>
      getPromptDraftAccessor({
        kind: "thread",
        projectId: thread.projectId,
        threadId: thread.id,
      }),
    [thread.id, thread.projectId],
  );
  return useCallback(
    (text: string, attachments?: readonly PromptDraftAttachment[]) => {
      if (isCompactViewport && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      const composerActions = createCoreComposerActions({
        ...promptDraft,
        focus: () => requestComposerFocus(promptDraft.storageKey),
      });
      composerActions.replace((current) =>
        appendQuoteAndAttachmentsToDraft(current, text, attachments ?? []),
      );
      composerActions.focus();
    },
    [isCompactViewport, promptDraft],
  );
}
