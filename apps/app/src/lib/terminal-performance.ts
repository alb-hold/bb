export function markTerminalPerformance(
  name: string,
  options?: PerformanceMarkOptions,
): void {
  performance.clearMarks?.(name);
  performance.mark?.(name, options);
}

export async function traceTerminalGate<T>(
  name: string,
  load: () => Promise<T>,
  detail?: Record<string, string>,
): Promise<T> {
  markTerminalPerformance(`${name}-start`, { detail });
  try {
    const value = await load();
    markTerminalPerformance(`${name}-end`, {
      detail: { ...detail, outcome: "resolved" },
    });
    return value;
  } catch (error) {
    markTerminalPerformance(`${name}-end`, {
      detail: { ...detail, outcome: "rejected" },
    });
    throw error;
  }
}
