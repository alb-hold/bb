import { Icon } from "./icon";

export function ThreadModeGlyph({
  nativeTerminal,
  isWorktree,
  hideWorkspaceOnDesktop = false,
}: {
  nativeTerminal: boolean;
  isWorktree: boolean;
  hideWorkspaceOnDesktop?: boolean;
}) {
  const name = nativeTerminal ? "Terminal" : isWorktree ? "FolderGit" : "Folder";
  const label = nativeTerminal ? "Native terminal" : isWorktree ? "Worktree" : "Workspace";
  return (
    <span className={hideWorkspaceOnDesktop && !nativeTerminal && !isWorktree ? "md:hidden" : undefined} role="img" aria-label={label}>
      <Icon name={name} className="size-3.5 shrink-0" aria-hidden />
    </span>
  );
}
