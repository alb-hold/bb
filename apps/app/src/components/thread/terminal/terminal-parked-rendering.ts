import type { Terminal } from "@xterm/xterm";

const PARKED_DETACH_SELECTORS = [
  ".xterm-scrollbar",
  ".xterm-screen > style",
] as const;

interface DetachedNode {
  element: HTMLElement;
  parent: ParentNode;
  next: ChildNode | null;
  selector: string;
}

function detachParkedNodes(terminal: Terminal): DetachedNode[] {
  const detached: DetachedNode[] = [];
  for (const selector of PARKED_DETACH_SELECTORS) {
    for (const element of terminal.element?.querySelectorAll<HTMLElement>(
      selector,
    ) ?? []) {
      const parent = element.parentNode;
      if (parent === null) continue;
      detached.push({ element, parent, next: element.nextSibling, selector });
    }
  }
  for (const { element } of detached) element.remove();
  return detached;
}

function restoreParkedNodes(
  terminal: Terminal,
  detached: readonly DetachedNode[],
): void {
  const root = terminal.element;
  if (root === undefined) return;
  const replaced = new Map<ParentNode, Set<string>>();
  for (const { parent, selector } of detached) {
    const scoped = selector.split(">").at(-1)?.trim() ?? selector;
    if (
      !root.contains(parent) ||
      parent.querySelector(`:scope > ${scoped}`) === null
    )
      continue;
    const selectors = replaced.get(parent) ?? new Set<string>();
    selectors.add(selector);
    replaced.set(parent, selectors);
  }
  for (let index = detached.length - 1; index >= 0; index--) {
    const { element, parent, next, selector } = detached[index];
    if (!root.contains(parent) || replaced.get(parent)?.has(selector) === true)
      continue;
    if (next !== null && next.parentNode === parent)
      parent.insertBefore(element, next);
    else parent.appendChild(element);
  }
}

export function releaseParkedTerminalRendering(terminal: Terminal): () => void {
  const detached = detachParkedNodes(terminal);
  terminal.clearTextureAtlas();
  for (const row of terminal.element?.querySelectorAll(".xterm-rows > div") ?? []) {
    row.replaceChildren();
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    restoreParkedNodes(terminal, detached);
  };
}
