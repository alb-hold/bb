import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

export interface TerminalSearchAddonModule {
  SearchAddon: new () => ITerminalAddon & {
    clearDecorations: () => void;
    findNext: (term: string, options?: import("@xterm/addon-search").ISearchOptions) => boolean;
    findPrevious: (term: string, options?: import("@xterm/addon-search").ISearchOptions) => boolean;
    onDidChangeResults: (listener: (event: { resultIndex: number; resultCount: number }) => void) => IDisposable;
  };
}

export async function loadOptionalTerminalSearchAddon(
  importAddon: () => Promise<TerminalSearchAddonModule>,
): Promise<TerminalSearchAddonModule | null> {
  try {
    return await importAddon();
  } catch {
    return null;
  }
}

export type TerminalSearchAddonInstance = InstanceType<TerminalSearchAddonModule["SearchAddon"]>;
export type TerminalSearchLoader = Pick<Terminal, "loadAddon">;
