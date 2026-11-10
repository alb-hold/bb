import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import type {
  TerminalSession,
  TerminalCreateTarget,
} from "@bb/server-contract";
import { ThreadTerminalContent } from "./ThreadTerminalContent";
import { useThreadTerminalController } from "./useThreadTerminalController";

interface ThreadTerminalPanelProps {
  autoFocus?: boolean;
  initialSession?: TerminalSession;
  retainNativeOutput?: boolean;
  attentionShownAsBanner?: boolean;
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

export function ThreadTerminalPanel({
  autoFocus = false,
  initialSession,
  retainNativeOutput = false,
  attentionShownAsBanner = false,
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
