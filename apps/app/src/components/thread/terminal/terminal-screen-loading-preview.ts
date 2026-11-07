import type { TerminalScreenResult } from "@bb/sdk";

export function mountTerminalScreenLoadingPreview({
  container,
  snapshot,
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
}: {
  container: HTMLDivElement;
  snapshot: TerminalScreenResult;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
}): { dispose(): void; refresh(lineHeight: number): void } {
  const preview = document.createElement("pre");
  preview.dataset.terminalScreenLoadingPreview = "";
  preview.setAttribute("aria-hidden", "true");
  preview.className =
    "pointer-events-none absolute inset-0 m-0 overflow-hidden bg-sidebar pl-2 text-foreground";
  preview.style.fontFamily = fontFamily;
  preview.style.fontSize = `${fontSize}px`;
  preview.style.fontWeight = String(fontWeight);
  preview.style.lineHeight = "normal";
  preview.style.whiteSpace = "pre";
  preview.style.right = "auto";
  preview.style.bottom = "auto";
  preview.style.zIndex = "6";
  container.parentElement?.append(preview);
  const refresh = (height: number) => {
    preview.style.top = `${container.offsetTop}px`;
    preview.style.left = `${container.offsetLeft}px`;
    preview.style.width = `${container.clientWidth}px`;
    preview.style.height = "auto";
    preview.style.lineHeight = "normal";
    preview.textContent = "W";
    const characterHeight = preview.getBoundingClientRect().height;
    preview.style.lineHeight = `${Math.floor((characterHeight || fontSize * 1.2) * height)}px`;
    preview.textContent = snapshot.rows.join("\n");
    preview.style.height = `${container.clientHeight}px`;
  };
  refresh(lineHeight);
  return { dispose: () => preview.remove(), refresh };
}
