import { useMemo } from "react";
import type { ThreadResponse } from "@bb/server-contract";
import type { ThreadTimelineConsumerMessageAction } from "@/components/thread/timeline/types";
import { useCreateThreadQueuedMessage } from "@/hooks/mutations/thread-runtime-mutations";
import { SIDE_CHAT_PLUGIN_ID } from "@/lib/side-chat-plugin";

export function useSideChatConsumerMessageActions(
  thread: Pick<
    ThreadResponse,
    "id" | "originKind" | "originPluginId" | "parentThreadId" | "sourceThreadId"
  >,
): ThreadTimelineConsumerMessageAction[] {
  const sendToSourceThread = useCreateThreadQueuedMessage();
  const isSideChatThread =
    thread.originKind === "fork" && thread.originPluginId === SIDE_CHAT_PLUGIN_ID;
  const sourceThreadId =
    thread.sourceThreadId ??
    (thread.originKind ? thread.parentThreadId : null);
  const { id: threadId } = thread;
  const { isPending, mutate } = sendToSourceThread;
  return useMemo(
    () =>
      isSideChatThread && sourceThreadId !== null
        ? [
            {
              id: "send-to-main",
              pluginId: null,
              icon: "ArrowTurnBackward",
              label: "Send to main thread",
              roles: ["assistant"],
              run: (message) => {
                if (isPending) return;
                mutate({
                  id: sourceThreadId,
                  input: [{ type: "text", text: message.text, mentions: [] }],
                  senderThreadId: threadId,
                });
              },
            },
          ]
        : [],
    [isPending, isSideChatThread, mutate, sourceThreadId, threadId],
  );
}
