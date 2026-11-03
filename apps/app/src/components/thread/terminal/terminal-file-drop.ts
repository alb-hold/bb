export function quoteTerminalPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function formatTerminalFileDrop(paths: readonly string[]): string {
  const validPaths = paths.filter((path) => path.length > 0);
  return validPaths.map(quoteTerminalPath).join(" ");
}

export function resolveTerminalFileDropPaths<T>(
  files: readonly T[],
  getPathForFile: ((file: T) => string) | undefined,
): string[] {
  if (getPathForFile === undefined) return [];
  return files.map(getPathForFile).filter((path) => path.length > 0);
}

export function handleTerminalFileDrop<T>({
  files,
  getPathForFile,
  isRunning,
  sendInput,
}: {
  files: readonly T[];
  getPathForFile: ((file: T) => string) | undefined;
  isRunning: boolean;
  sendInput: (input: string) => void;
}): boolean {
  const input = formatTerminalFileDrop(
    resolveTerminalFileDropPaths(files, getPathForFile),
  );
  if (!input || !isRunning) return false;
  sendInput(input);
  return true;
}

export function getNewTerminalSelection(
  text: string,
  previousText: string,
): string | null {
  return text.trim().length > 0 && text !== previousText ? text : null;
}
