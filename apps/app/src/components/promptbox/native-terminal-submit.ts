export const NATIVE_TERMINAL_SUPPORT_PENDING_REASON =
  "Checking whether this provider supports Terminal mode…";

export function nativeTerminalSupportPendingReason(
  requested: boolean,
  support: boolean | undefined,
): string | null {
  return requested && support === undefined
    ? NATIVE_TERMINAL_SUPPORT_PENDING_REASON
    : null;
}
