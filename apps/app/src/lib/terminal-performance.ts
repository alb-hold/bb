export function markTerminalPerformance(
  name: string,
  options?: PerformanceMarkOptions,
): void {
  performance.clearMarks?.(name);
  performance.mark?.(name, options);
}

export function measureTerminalPerformance<T>(name: string, run: () => T): T {
  const start = performance.now();
  try {
    return run();
  } finally {
    performance.clearMeasures?.(name);
    performance.measure?.(name, { start, end: performance.now() });
  }
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
