export const REFUSAL_LOG_ONCE_CAPACITY = 4096;

export interface RefusalLogOnce {
  isNewRefusal(refusalKey: string): boolean;
}

export function refusalKeyIdentity(refusalKey: string): string {
  const separator = refusalKey.indexOf("|");
  return separator === -1 ? refusalKey : refusalKey.slice(0, separator);
}

export function createRefusalLogOnce(
  capacity = REFUSAL_LOG_ONCE_CAPACITY,
): RefusalLogOnce {
  const lastKeys = new Map<string, string>();
  return {
    isNewRefusal(refusalKey) {
      const identity = refusalKeyIdentity(refusalKey);
      const previous = lastKeys.get(identity);
      lastKeys.delete(identity);
      lastKeys.set(identity, refusalKey);
      while (lastKeys.size > capacity) {
        const oldest = lastKeys.keys().next().value;
        if (oldest === undefined) break;
        lastKeys.delete(oldest);
      }
      return previous !== refusalKey;
    },
  };
}
