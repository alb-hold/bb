export const OSC_52_AUTO_COPY_WINDOW_MS = 5_000;
export const OSC_52_AUTO_COPY_MAX_BYTES = 256 * 1024;

export function shouldAutoCopyOsc52({
  copyOnSelect,
  lastUserInputAt,
  now,
  text,
}: {
  copyOnSelect: boolean;
  lastUserInputAt: number | null;
  now: number;
  text: string;
}): boolean {
  if (!copyOnSelect || lastUserInputAt === null) return false;
  const sinceInput = now - lastUserInputAt;
  if (sinceInput < 0 || sinceInput > OSC_52_AUTO_COPY_WINDOW_MS) return false;
  return (
    text.length <= OSC_52_AUTO_COPY_MAX_BYTES &&
    new TextEncoder().encode(text).length <= OSC_52_AUTO_COPY_MAX_BYTES
  );
}
