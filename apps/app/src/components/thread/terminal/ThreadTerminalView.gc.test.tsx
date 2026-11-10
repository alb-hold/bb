// @vitest-environment jsdom

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Terminal } from "@xterm/xterm";
import { cleanup, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  ackedThrough,
  mountTerminal,
  testState,
} from "./ThreadTerminalView.progress-test-utils";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    terminals: {
      experimental_screen: vi.fn(),
      output: vi.fn(),
      experimental_attention: { clear: vi.fn() },
    },
  },
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: vi.fn() },
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { showKeyboardHints: false },
      keybindings: [],
    },
  }),
}));

vi.mock("@/hooks/usePluginCommandBindings", () => ({
  usePluginCommandBindings: () => ({
    commands: [],
    defaults: [],
    keybindings: [],
  }),
}));

it("collects terminals and SVGs after 10,000 outputs and 10 unmounts", async () => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  const terminals: WeakRef<Terminal>[] = [];
  const elements: WeakRef<HTMLElement>[] = [];
  const icons: WeakRef<SVGSVGElement>[] = [];
  const originalOpen = Terminal.prototype.open;
  const open = vi
    .spyOn(Terminal.prototype, "open")
    .mockImplementation(function (this: Terminal, parent: HTMLElement) {
      terminals.push(new WeakRef(this));
      originalOpen.call(this, parent);
      elements.push(new WeakRef(this.element!));
    });
  for (let cycle = 0; cycle < 10; cycle++) {
    const { session, socket } = await mountTerminal("running");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    for (let seq = 0; seq < 1000; seq++) {
      socket.receive({
        type: "output",
        chunk: { seq, dataBase64: btoa("streaming output\r\n") },
      });
    }
    await waitFor(() => ackedThrough(1000), { timeout: 30_000 });
    icons.push(
      ...Array.from(
        document.querySelectorAll("svg"),
        (icon) => new WeakRef(icon),
      ),
    );
    cleanup();
    vi.clearAllMocks();
    testState.sockets.length = 0;
    testState.socketMessages.length = 0;
    render(<div />);
    cleanup();
    document.querySelector("body");
    await new Promise((resolve) => setTimeout(resolve, 20));
    collect();
  }
  render(<div />);
  cleanup();
  document.querySelector("body");
  open.mockRestore();
  vi.restoreAllMocks();
  for (let pass = 0; pass < 5; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    collect();
  }
  expect(terminals).not.toHaveLength(0);
  expect(
    terminals.filter((reference) => reference.deref() !== undefined),
  ).toHaveLength(0);
  expect(
    elements.filter((reference) => reference.deref() !== undefined),
  ).toHaveLength(0);
  expect(icons).not.toHaveLength(0);
  expect(
    icons.filter((reference) => reference.deref() !== undefined),
  ).toHaveLength(0);
}, 300_000);
