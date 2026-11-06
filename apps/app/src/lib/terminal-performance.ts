export function markTerminalPerformance(
  name: string,
  options?: PerformanceMarkOptions,
): void {
  performance.clearMarks?.(name);
  performance.mark?.(name, options);
}
