export const NATIVE_TERMINAL_SUPPORT_PENDING_REASON =
  "Checking whether this provider supports Terminal mode…";

export function nativeTerminalSupportPendingReason(
  requested: boolean,
  explicit: boolean,
  support: boolean | undefined,
): string | null {
  return requested && explicit && support === undefined
    ? NATIVE_TERMINAL_SUPPORT_PENDING_REASON
    : null;
}

export function nativeTerminalPreferenceStored(
  key: string,
  open: () => Pick<Storage, "getItem"> | undefined = () => globalThis.localStorage,
): boolean {
  try {
    return open()?.getItem(key) != null;
  } catch {
    return false;
  }
}
