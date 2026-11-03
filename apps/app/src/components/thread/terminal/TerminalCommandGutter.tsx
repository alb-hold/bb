import type { TerminalCommandMark } from "./terminal-prompt-tracker";

interface TerminalCommandGutterProps {
  commandMarks: readonly TerminalCommandMark[];
  lineHeight: number;
  rows: number;
  viewportLine: number;
}

export function TerminalCommandGutter({
  commandMarks,
  lineHeight,
  rows,
  viewportLine,
}: TerminalCommandGutterProps) {
  return (
    <div className="pointer-events-none absolute inset-y-2 left-2 z-10 w-1">
      {commandMarks.map((mark, index) => {
        const row = mark.line - viewportLine;
        if (row < 0 || row >= rows || mark.exitCode === null) return null;
        return (
          <span
            key={`${mark.line}-${index}`}
            role="img"
            aria-label={
              mark.exitCode === 0
                ? "Command succeeded"
                : `Command failed with exit code ${mark.exitCode}`
            }
            className={`absolute left-0 top-0 size-1 rounded-full ${mark.exitCode === 0 ? "bg-success" : "bg-destructive"}`}
            style={{ transform: `translateY(${row * lineHeight}px)` }}
          />
        );
      })}
    </div>
  );
}
