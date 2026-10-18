import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSearchAddonInstance } from "./terminal-search-addon";
import { TerminalMobileControls } from "./TerminalMobileControls";
import { TerminalSearch } from "./TerminalSearch";

export default {
  title: "thread/terminal/Terminal Search",
};

function SearchableTerminal({ touch = false }: { touch?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [addon, setAddon] = useState<TerminalSearchAddonInstance | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    let mountedTerminal: Terminal | null = null;
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
    ]).then(([xterm, fitModule, searchModule]) => {
      if (!active || !hostRef.current) return;
      mountedTerminal = new xterm.Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        scrollback: 10_000,
      });
      const fit = new fitModule.FitAddon();
      const search = new searchModule.SearchAddon();
      mountedTerminal.loadAddon(fit);
      mountedTerminal.loadAddon(search);
      mountedTerminal.open(hostRef.current);
      fit.fit();
      mountedTerminal.write(
        "Native CLI output\r\nfirst needle result\r\nsecond needle result\r\nready for search\r\n",
      );
      setTerminal(mountedTerminal);
      setAddon(search);
    });
    return () => {
      active = false;
      mountedTerminal?.dispose();
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="group/terminal-pane relative min-h-0 flex-1 overflow-hidden bg-sidebar p-2">
        <div ref={hostRef} className="h-full w-full overflow-hidden" />
        <TerminalSearch
          addon={addon}
          terminal={terminal}
          touch={touch}
          open={open}
          onOpenChange={setOpen}
        />
      </div>
      {touch ? (
        <TerminalMobileControls
          controlActive={false}
          disabled={terminal === null}
          onArrow={() => undefined}
          onControlChange={() => undefined}
          onInput={() => undefined}
          onKeyboardToggle={() => undefined}
          onPaste={() => undefined}
          onSearch={() => setOpen(true)}
          onSelectText={() => undefined}
        />
      ) : null}
    </div>
  );
}

export function DesktopSplitPane() {
  return (
    <div className="grid h-[32rem] min-h-0 grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
      <SearchableTerminal />
      <SearchableTerminal />
    </div>
  );
}

export function CompactPhone() {
  return (
    <div className="flex h-[44rem] w-[24.375rem] min-h-0 flex-col overflow-hidden rounded-xl border border-border">
      <SearchableTerminal touch />
    </div>
  );
}
