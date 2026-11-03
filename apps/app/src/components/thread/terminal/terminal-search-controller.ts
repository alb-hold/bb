export interface TerminalSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  decorations?: {
    matchBackground: string;
    matchBorder: string;
    matchOverviewRuler: string;
    activeMatchBackground: string;
    activeMatchBorder: string;
    activeMatchColorOverviewRuler: string;
  };
}

export type TerminalSearchToggle = "caseSensitive" | "wholeWord" | "regex";

export interface TerminalSearchState extends TerminalSearchOptions {
  query: string;
  resultIndex: number;
  resultCount: number;
  error: string | null;
}

export interface TerminalSearchAddon {
  clearDecorations: () => void;
  findNext: (query: string, options: TerminalSearchOptions) => boolean;
  findPrevious: (query: string, options: TerminalSearchOptions) => boolean;
  onDidChangeResults: (listener: (event: { resultIndex: number; resultCount: number }) => void) => { dispose: () => void };
}

const emptyState: TerminalSearchState = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  query: "",
  resultIndex: 0,
  resultCount: 0,
  error: null,
};

export function createTerminalSearchController(
  addon: TerminalSearchAddon,
  onChange: (state: TerminalSearchState) => void,
  focusTerminal?: () => void,
  decorations?: TerminalSearchOptions["decorations"],
) {
  let state = { ...emptyState };
  let disposed = false;
  const resultSubscription = addon.onDidChangeResults((result) => {
    if (disposed) return;
    state = {
      ...state,
      resultIndex: result.resultIndex < 0 ? 0 : result.resultIndex + 1,
      resultCount: result.resultCount,
    };
    onChange(state);
  });

  const search = (direction: "next" | "previous") => {
    if (disposed) return;
    if (!state.query) {
      addon.clearDecorations();
      state = { ...state, resultIndex: 0, resultCount: 0, error: null };
      onChange(state);
      return;
    }
    try {
      addon[direction === "next" ? "findNext" : "findPrevious"](
        state.query,
        {
          caseSensitive: state.caseSensitive,
          wholeWord: state.wholeWord,
          regex: state.regex,
          decorations,
        },
      );
      state = { ...state, error: null };
      onChange(state);
    } catch (error) {
      addon.clearDecorations();
      state = {
        ...state,
        resultIndex: 0,
        resultCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      onChange(state);
    }
  };

  return {
    setQuery(query: string) {
      state = { ...state, query };
      search("next");
    },
    setOption(option: TerminalSearchToggle, value: boolean) {
      state = { ...state, [option]: value };
      search("next");
    },
    next: () => search("next"),
    previous: () => search("previous"),
    close(restoreFocus = true) {
      if (!disposed) {
        disposed = true;
        resultSubscription.dispose();
        addon.clearDecorations();
        if (restoreFocus) focusTerminal?.();
      }
    },
  };
}
