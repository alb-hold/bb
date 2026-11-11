import type { ProviderInfo } from "@bb/domain";
import { ThreadLeadingMark, ThreadModeGlyph } from "@bb/shared-ui/thread-mode-glyph";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { cn } from "@bb/shared-ui/lib/utils";

export function ThreadIdentityLeadingMark({
  providerId,
  provider,
  nativeTerminal,
  isWorktree,
  className,
}: {
  providerId: string | null;
  provider: ProviderInfo | null;
  nativeTerminal: boolean;
  isWorktree: boolean;
  className?: string;
}) {
  const providerIcon = getProviderIconInfo(
    "agent",
    providerId ?? "",
    provider,
  );
  const ProviderMark = providerIcon?.icon;
  const hasModeGlyph = nativeTerminal || isWorktree;
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground",
        className,
      )}
    >
      {ProviderMark ? (
        hasModeGlyph ? (
          <ThreadLeadingMark
            nativeTerminal={nativeTerminal}
            isWorktree={isWorktree}
            providerName={provider?.displayName ?? null}
          >
            <ProviderMark className="size-4" />
          </ThreadLeadingMark>
        ) : (
          <ProviderMark className="size-4" />
        )
      ) : (
        <ThreadModeGlyph nativeTerminal={nativeTerminal} isWorktree={isWorktree} />
      )}
    </span>
  );
}
