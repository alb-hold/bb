import type { TerminalScreenResult } from "@bb/sdk";

export function mountTerminalScreenLoadingPreview({
  container,
  snapshot,
  fontFamily,
  fontSize,
  lineHeight,
}: {
  container: HTMLDivElement;
  snapshot: TerminalScreenResult;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}): () => void {
  const preview = document.createElement("pre");
  preview.dataset.terminalScreenLoadingPreview = "";
  preview.setAttribute("aria-hidden", "true");
  preview.className =
    "pointer-events-none absolute inset-0 m-0 overflow-hidden bg-sidebar pl-2 text-foreground";
  preview.style.fontFamily = fontFamily;
  preview.style.fontSize = `${fontSize}px`;
  preview.style.lineHeight = "normal";
  preview.style.whiteSpace = "pre";
  preview.style.bottom = "auto";
  preview.textContent = "W";
  container.parentElement?.append(preview);
  const characterHeight = preview.getBoundingClientRect().height;
  preview.style.lineHeight = `${Math.floor((characterHeight || fontSize * 1.2) * lineHeight)}px`;
  preview.textContent = snapshot.rows.join("\n");
  return () => preview.remove();
}
