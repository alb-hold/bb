import { useNavigate } from "react-router-dom";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import { getRootComposeRoutePath, getThreadRoutePath } from "@/lib/route-paths";

export function TerminalAttentionCommandHandler() {
  const navigate = useNavigate();

  useAppCommandHandler("terminal.attention.next", () => {
    void sdk.terminals.experimental_attention
      .next()
      .then((session) => {
        if (session === null) {
          appToast.message("Nothing needs attention.");
          return;
        }
        if (session.threadId === null) {
          void navigate(getRootComposeRoutePath(), {
            state: { terminalAttentionSession: session },
          });
          return;
        }
        const threadId = session.threadId;
        return sdk.threads
          .get({ threadId })
          .then((thread) =>
            navigate(
              getThreadRoutePath({ projectId: thread.projectId, threadId }),
              { state: { terminalAttentionId: session.id } },
            ),
          );
      })
      .catch(() => appToast.error("Couldn't open the next terminal."));
    return true;
  });

  return null;
}
