import { waitFor } from "@testing-library/react";

export function waitForReadiness<T>(
  promise: Promise<T>,
  failureMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(failureMessage)), 5_000);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

export async function waitForReadinessCondition<T>(
  callback: () => T,
  failureMessage: string,
): Promise<T> {
  try {
    return await waitFor(callback, { timeout: 5_000 });
  } catch {
    const terminalError = document.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )?.textContent;
    throw new Error(
      terminalError ? `${failureMessage}: ${terminalError}` : failureMessage,
    );
  }
}
