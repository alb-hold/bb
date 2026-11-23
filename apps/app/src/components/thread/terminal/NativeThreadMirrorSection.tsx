import type { NativeTerminalThreadReply } from "@bb/server-contract";
import { MarkdownPreview } from "@/components/ui/markdown-preview";

interface NativeThreadMirrorSectionProps {
  prompt: string | null;
  reply: NativeTerminalThreadReply | null;
  starting: boolean;
}

export function NativeThreadMirrorSection({
  prompt,
  reply,
  starting,
}: NativeThreadMirrorSectionProps) {
  const promptText = prompt?.trim() ?? "";
  const replyText = reply?.text.trim() ?? "";
  const hasPrompt = promptText.length > 0;
  const hasReply = replyText.length > 0;

  if (!hasPrompt && !starting && !hasReply) return null;

  return (
    <div
      className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border-seam bg-background/60"
      data-native-terminal-mirror=""
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-3">
        {hasPrompt ? (
          <div className="w-full" data-native-terminal-prompt-mirror="">
            <div className="ml-auto flex w-fit max-w-[88%] flex-col items-end md:max-w-[70%]">
              <div className="max-w-full whitespace-pre-wrap break-words rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground">
                {promptText}
              </div>
            </div>
          </div>
        ) : null}
        {starting ? (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-native-terminal-starting=""
            role="status"
          >
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground"
            />
            <span>Starting terminal…</span>
          </div>
        ) : null}
        {hasReply ? (
          <div
            className="w-full text-sm font-normal leading-relaxed text-foreground"
            data-native-terminal-reply-mirror=""
          >
            <MarkdownPreview allowHtml content={replyText} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
