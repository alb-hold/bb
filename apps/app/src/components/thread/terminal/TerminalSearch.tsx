import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSearchAddonInstance } from "./terminal-search-addon";
import {
  createTerminalSearchController,
  type TerminalSearchState,
} from "./terminal-search-controller";

const initialState: TerminalSearchState = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  resultIndex: 0,
  resultCount: 0,
  error: null,
};

function cssColorToHex(value: string): string {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (channels?.length !== 3) return "#d4a72c";
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function readSearchDecorations() {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const read = (name: string) => {
    probe.style.backgroundColor = `var(${name})`;
    return cssColorToHex(getComputedStyle(probe).backgroundColor);
  };
  const decorations = {
    matchBackground: read("--sidebar-search-match"),
    matchBorder: read("--sidebar-search-match-border"),
    matchOverviewRuler: read("--sidebar-search-match-border"),
    activeMatchBackground: read("--sidebar-search-match-border"),
    activeMatchBorder: read("--sidebar-search-match-border"),
    activeMatchColorOverviewRuler: read("--sidebar-search-match-border"),
  };
  probe.remove();
  return decorations;
}

export function TerminalSearch({
  addon,
  terminal,
  touch = false,
  open,
  onOpenChange,
}: {
  addon: TerminalSearchAddonInstance | null;
  terminal: Terminal | null;
  touch?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState(initialState);
  const setOpen = onOpenChange;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<ReturnType<typeof createTerminalSearchController> | null>(null);

  const close = useCallback(() => {
    controllerRef.current?.close();
    controllerRef.current = null;
    setOpen(false);
    setState(initialState);
  }, [onOpenChange]);

  useEffect(() => {
    if (!terminal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "f" && terminal.hasFocus()) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      } else if (open && key === "g") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) controllerRef.current?.previous();
        else controllerRef.current?.next();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onOpenChange, open, terminal]);

  useEffect(() => {
    if (!open || !addon || !terminal) return;
    const controller = createTerminalSearchController(
      addon,
      setState,
      () => terminal.focus(),
      readSearchDecorations(),
    );
    controllerRef.current = controller;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      controller.close(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [addon, open, terminal]);

  const toggleOption = (option: "caseSensitive" | "wholeWord" | "regex") => {
    const value = !state[option];
    setState((current) => ({ ...current, [option]: value }));
    controllerRef.current?.setOption(option, value);
  };

  return (
    <div className="absolute inset-x-2 top-2 z-20 flex justify-end pointer-events-none">
      {!open ? (
        <button
          type="button"
          aria-label="Search terminal output"
          disabled={!addon || !terminal}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setOpen(true)}
          className={cn(
            "pointer-events-auto inline-flex size-11 items-center justify-center rounded-md border border-border bg-popover text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
            touch && "hidden",
          )}
        >
          <Icon name="Search" className="size-4" />
        </button>
      ) : (
        <div
          role="search"
          aria-label="Search terminal output"
          className="pointer-events-auto w-full max-w-xl rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={inputRef}
              type="search"
              value={state.query}
              onChange={(event) => {
                const query = event.currentTarget.value;
                setState((current) => ({ ...current, query }));
                controllerRef.current?.setQuery(query);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.shiftKey) controllerRef.current?.previous();
                  else controllerRef.current?.next();
                }
              }}
              placeholder="Find in terminal"
              aria-label="Find in terminal"
              aria-invalid={state.error !== null}
              className="h-11 min-w-24 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <output aria-live="polite" className="min-w-12 text-center text-xs text-muted-foreground">
              {state.resultCount === 0 ? "0 / 0" : `${state.resultIndex} / ${state.resultCount}`}
            </output>
            <button type="button" aria-label="Previous match" onClick={() => controllerRef.current?.previous()} className="inline-flex size-11 items-center justify-center rounded-md hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-ring">
              <Icon name="ChevronUp" className="size-4" />
            </button>
            <button type="button" aria-label="Next match" onClick={() => controllerRef.current?.next()} className="inline-flex size-11 items-center justify-center rounded-md hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-ring">
              <Icon name="ChevronDown" className="size-4" />
            </button>
            <button type="button" aria-label="Close search" onClick={close} className="inline-flex size-11 items-center justify-center rounded-md hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-ring">
              <Icon name="X" className="size-4" />
            </button>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {([
              ["caseSensitive", "Match case"],
              ["wholeWord", "Whole word"],
              ["regex", "Regex"],
            ] as const).map(([option, label]) => (
              <button
                key={option}
                type="button"
                aria-pressed={state[option]}
                onClick={() => toggleOption(option)}
                className={cn("rounded px-2 py-1 text-xs text-muted-foreground hover:bg-state-hover", state[option] && "bg-state-active text-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
          {state.error ? <p role="alert" className="mt-1 text-xs text-destructive">{state.error}</p> : null}
        </div>
      )}
    </div>
  );
}

export { readSearchDecorations };
