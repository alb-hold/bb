import type { ReactNode } from "react";
import { Icon } from "./icon";

export function threadModeLabel({
  nativeTerminal,
  isWorktree,
}: {
  nativeTerminal: boolean;
  isWorktree: boolean;
}): string | null {
  return nativeTerminal ? "Native terminal" : isWorktree ? "Worktree" : null;
}

export function ThreadModeGlyph({
  nativeTerminal,
  isWorktree,
}: {
  nativeTerminal: boolean;
  isWorktree: boolean;
}) {
  const name = nativeTerminal ? "Terminal" : isWorktree ? "FolderGit" : null;
  const label = threadModeLabel({ nativeTerminal, isWorktree });
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center"
      role={name === null ? undefined : "img"}
      aria-label={name === null ? undefined : (label ?? undefined)}
      aria-hidden={name === null ? true : undefined}
    >
      {name === null ? null : (
        <Icon name={name} className="size-4 shrink-0" aria-hidden />
      )}
    </span>
  );
}

export function ThreadLeadingMark({
  children,
  nativeTerminal,
  isWorktree,
  providerName,
}: {
  children: ReactNode;
  nativeTerminal: boolean;
  isWorktree: boolean;
  providerName: string | null;
}) {
  const mode = threadModeLabel({ nativeTerminal, isWorktree });
  return (
    <span
      role={mode === null ? undefined : "img"}
      aria-label={
        mode === null
          ? undefined
          : providerName === null
            ? mode
            : `${providerName}, ${mode.toLowerCase()}`
      }
      className="relative inline-flex size-4 shrink-0 items-center justify-center"
    >
      {children}
      {mode === null ? null : (
        <span
          aria-hidden
          data-thread-mode-badge={nativeTerminal ? "native-terminal" : "worktree"}
          className="absolute -bottom-0.5 -right-0.5 grid size-2.5 place-items-center rounded-full bg-background ring-1 ring-background"
        >
          <Icon
            name={nativeTerminal ? "Terminal" : "FolderGit"}
            className="size-1.5"
          />
        </span>
      )}
    </span>
  );
}
