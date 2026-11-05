import type { TerminalScreenResult } from "@bb/sdk";

export function mountTerminalScreenLoadingPreview({
  container,
  snapshot,
  fontFamily,
}: {
  container: HTMLDivElement;
  snapshot: TerminalScreenResult;
  fontFamily: string;
}): () => void {
  const preview = document.createElement("pre");
  preview.dataset.terminalScreenLoadingPreview = "";
  preview.setAttribute("aria-hidden", "true");
  preview.className =
    "pointer-events-none absolute inset-0 m-0 overflow-hidden bg-sidebar pl-2 text-foreground";
  preview.style.fontFamily = fontFamily;
  preview.style.fontSize = "12px";
  preview.style.lineHeight = "normal";
  preview.style.whiteSpace = "pre";
  preview.textContent = snapshot.rows.join("\n");
  container.parentElement?.append(preview);
  return () => preview.remove();
}
