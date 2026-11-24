import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import type {
  TerminalSession,
  TerminalCreateTarget,
} from "@bb/server-contract";
import { ThreadTerminalContent } from "./ThreadTerminalContent";
import { ThreadTerminalView } from "./ThreadTerminalView";
import { useThreadTerminalController } from "./useThreadTerminalController";

interface ThreadTerminalPanelProps {
  autoFocus?: boolean;
  initialSession?: TerminalSession;
  retainNativeOutput?: boolean;
  attentionShownAsBanner?: boolean;
  starting?: boolean;
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
  onAutoFocusHandled?: () => void;
  onCloseStart: () => void;
  onOpenLink?: MarkdownPreviewLinkHandler;
  onRetryStart: () => void;
  onSelectionAddToChat?: (text: string) => void;
  terminalId: string;
  target: TerminalCreateTarget;
}

export function ThreadTerminalPanel(props: ThreadTerminalPanelProps) {
  const session = props.initialSession;
  if (props.retainNativeOutput && session?.status === "exited" && session.id === props.terminalId) {
    return (
      <section aria-label="Terminal" data-app-terminal="" className="flex h-full min-h-0 flex-col bg-sidebar">
        <ThreadTerminalView
          key={session.id}
          session={session}
          retainNativeOutput
          autoFocus={false}
          isPanelOpen={props.isPanelOpen}
          onOpenLink={props.onOpenLink}
        />
      </section>
    );
  }
  return <InteractiveTerminalPanel {...props} />;
}

function InteractiveTerminalPanel({
  autoFocus = false,
  initialSession,
  retainNativeOutput = false,
  attentionShownAsBanner = false,
  starting = false,
  isPanelOpen,
  isPanelPersistedOpen,
  onAutoFocusHandled,
  onCloseStart,
  onOpenLink,
  onRetryStart,
  onSelectionAddToChat,
  terminalId,
  target,
}: ThreadTerminalPanelProps) {
  const terminalController = useThreadTerminalController({
    initialSession,
    isPanelOpen,
    isPanelPersistedOpen,
    terminalId,
    target,
  });

  return (
    <section
      aria-label="Terminal"
      data-app-terminal=""
      className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
    >
      <div className="min-h-0 flex-1 overflow-hidden bg-sidebar">
        <ThreadTerminalContent
          retainNativeOutput={retainNativeOutput}
          attentionShownAsBanner={attentionShownAsBanner}
          starting={starting}
          autoFocus={autoFocus}
          controller={terminalController}
          onAutoFocusHandled={onAutoFocusHandled}
          onCloseStart={onCloseStart}
          onOpenLink={onOpenLink}
          onRetryStart={onRetryStart}
          onSelectionAddToChat={onSelectionAddToChat}
        />
      </div>
    </section>
  );
}
