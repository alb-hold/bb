import {
  arePromptDraftStatesEqual,
  type PromptDraftState,
} from "@bb/client-core";

interface RestoredDraftRetry {
  draft: PromptDraftState;
  requestId: string;
}

const restoredDraftRetryByThreadId = new Map<string, RestoredDraftRetry>();

export function registerRestoredDraftRetry(
  threadId: string,
  draft: PromptDraftState,
  requestId: string | null,
): void {
  if (requestId === null) {
    restoredDraftRetryByThreadId.delete(threadId);
    return;
  }
  restoredDraftRetryByThreadId.set(threadId, { draft, requestId });
}

export function clearRestoredDraftRetry(threadId: string): void {
  restoredDraftRetryByThreadId.delete(threadId);
}

export function peekRetryOfClientRequestId(
  threadId: string,
  submittedDraft: PromptDraftState,
): string | null {
  const registered = restoredDraftRetryByThreadId.get(threadId);
  if (
    registered === undefined ||
    !arePromptDraftStatesEqual(registered.draft, submittedDraft)
  ) {
    return null;
  }
  return registered.requestId;
}
