import { isNativeTerminalQuestion } from "@bb/domain";
import type { AppDeps } from "../../types.js";

export const NATIVE_QUESTION_ANSWERED_REASON = "native-terminal-question-answered";

export function interruptNativeTerminalQuestions(
  deps: Pick<AppDeps, "pendingInteractions">,
  threadId: string,
  keep: ReadonlySet<string> = new Set(),
): number {
  let interrupted = 0;
  for (const interaction of deps.pendingInteractions.listPendingThreadInteractions(
    threadId,
  )) {
    if (
      !isNativeTerminalQuestion(interaction) ||
      keep.has(interaction.providerRequestId)
    ) {
      continue;
    }
    deps.pendingInteractions.interruptPendingInteraction({
      interactionId: interaction.id,
      reason: NATIVE_QUESTION_ANSWERED_REASON,
    });
    interrupted += 1;
  }
  return interrupted;
}

const closedNativeQuestions = new WeakMap<
  AppDeps["hub"],
  Map<string, Set<string>>
>();
export const MAX_CLOSED_NATIVE_QUESTIONS = 256;

function closedQuestionsOf(deps: Pick<AppDeps, "hub">, threadId: string) {
  let byThread = closedNativeQuestions.get(deps.hub);
  if (byThread === undefined) {
    byThread = new Map();
    closedNativeQuestions.set(deps.hub, byThread);
  }
  let questions = byThread.get(threadId);
  if (questions === undefined) {
    questions = new Set();
    byThread.set(threadId, questions);
  }
  return questions;
}

export function rememberClosedNativeQuestions(
  deps: Pick<AppDeps, "hub">,
  threadId: string,
  providerRequestIds: Iterable<string>,
): void {
  const questions = closedQuestionsOf(deps, threadId);
  for (const id of providerRequestIds) {
    questions.delete(id);
    questions.add(id);
  }
  while (questions.size > MAX_CLOSED_NATIVE_QUESTIONS) {
    const oldest = questions.values().next().value;
    if (oldest === undefined) break;
    questions.delete(oldest);
  }
}

export function isClosedNativeQuestion(
  deps: Pick<AppDeps, "hub">,
  threadId: string,
  providerRequestId: string,
): boolean {
  return closedQuestionsOf(deps, threadId).has(providerRequestId);
}

export function forgetClosedNativeQuestions(
  deps: Pick<AppDeps, "hub">,
  threadId: string,
): void {
  closedQuestionsOf(deps, threadId).clear();
}
