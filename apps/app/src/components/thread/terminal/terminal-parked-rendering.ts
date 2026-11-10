import type { Terminal } from "@xterm/xterm";

interface DetachedScrollbar {
  element: HTMLElement;
  parent: ParentNode;
  next: ChildNode | null;
}

function detachScrollbars(terminal: Terminal): DetachedScrollbar[] {
  const detached: DetachedScrollbar[] = [];
  for (const element of terminal.element?.querySelectorAll<HTMLElement>(
    ".xterm-scrollbar",
  ) ?? []) {
    const parent = element.parentNode;
    if (parent === null) continue;
    detached.push({ element, parent, next: element.nextSibling });
  }
  for (const { element } of detached) element.remove();
  return detached;
}

function restoreScrollbars(
  terminal: Terminal,
  detached: readonly DetachedScrollbar[],
): void {
  const root = terminal.element;
  if (root === undefined) return;
  const replaced = new Set<ParentNode>();
  for (const { parent } of detached) {
    if (
      root.contains(parent) &&
      parent.querySelector(":scope > .xterm-scrollbar") !== null
    )
      replaced.add(parent);
  }
  for (let index = detached.length - 1; index >= 0; index--) {
    const { element, parent, next } = detached[index];
    if (!root.contains(parent) || replaced.has(parent)) continue;
    if (next !== null && next.parentNode === parent)
      parent.insertBefore(element, next);
    else parent.appendChild(element);
  }
}

export function releaseParkedTerminalRendering(terminal: Terminal): () => void {
  const detached = detachScrollbars(terminal);
  terminal.clearTextureAtlas();
  for (const row of terminal.element?.querySelectorAll(".xterm-rows > div") ?? []) {
    row.replaceChildren();
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    restoreScrollbars(terminal, detached);
  };
}
