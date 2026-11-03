const REDACTED_ENV_NAMES = ["BB_NATIVE_TOOL_CREDENTIAL"];

const REDACTED = "[redacted]";

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactWirePayload(text: string): string {
  let redacted = text;
  for (const name of REDACTED_ENV_NAMES) {
    const escaped = escapeForRegExp(name);
    redacted = redacted
      .replace(
        new RegExp(
          `("name"\\s*:\\s*"${escaped}"[^{}]*?"value"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*`,
          "gu",
        ),
        `$1${REDACTED}`,
      )
      .replace(
        new RegExp(
          `("value"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*("[^{}]*?"name"\\s*:\\s*"${escaped}")`,
          "gu",
        ),
        `$1${REDACTED}$2`,
      );
  }
  return redacted;
}
