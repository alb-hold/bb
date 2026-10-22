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
