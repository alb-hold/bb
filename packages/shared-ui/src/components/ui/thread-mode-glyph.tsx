import { Icon } from "./icon";

export function ThreadModeGlyph({
  nativeTerminal,
  isWorktree,
}: {
  nativeTerminal: boolean;
  isWorktree: boolean;
}) {
  const name = nativeTerminal ? "Terminal" : isWorktree ? "FolderGit" : null;
  const label = nativeTerminal ? "Native terminal" : "Worktree";
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center"
      role={name === null ? undefined : "img"}
      aria-label={name === null ? undefined : label}
      aria-hidden={name === null ? true : undefined}
    >
      {name === null ? null : (
        <Icon name={name} className="size-4 shrink-0" aria-hidden />
      )}
    </span>
  );
}
