import { DROPPED_FILE_MAX_BYTES } from "@bb/desktop-contract";

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

export async function handleStagedTerminalFileDrop<
  T extends { name: string; size: number },
>({
  files,
  stageFile,
  onStageFailure,
  isRunning,
  sendInput,
}: {
  files: readonly T[];
  stageFile: (file: T) => Promise<string>;
  onStageFailure: (file: T, message: string) => void;
  isRunning: () => boolean;
  sendInput: (input: string) => void;
}): Promise<boolean> {
  if (!isRunning()) return false;
  const paths: string[] = [];
  for (const file of files) {
    if (file.size > DROPPED_FILE_MAX_BYTES) {
      onStageFailure(
        file,
        `${file.name} is too large to attach (over ${DROPPED_FILE_MAX_BYTES / (1024 * 1024)} MB).`,
      );
      continue;
    }
    try {
      paths.push(await stageFile(file));
    } catch {
      onStageFailure(
        file,
        `Couldn't attach ${file.name}. Try saving it first.`,
      );
    }
  }
  const input = formatTerminalFileDrop(paths);
  if (!input || !isRunning()) return false;
  sendInput(input);
  return true;
}
