// @vitest-environment jsdom

import { sdk } from "@/lib/sdk";
import { describe, expect, it, vi } from "vitest";
import { waitForReadinessCondition } from "./ThreadTerminalView.terminal-focus-test-utils";
import {
  ackedThrough,
  mountTerminal,
  renderTerminal,
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

const osc = (body: string) => btoa(`\x1b]9;4;${body}\x07`);

describe("ThreadTerminalView progress and replay", () => {
  it("reports the output sequence of replayed and live progress", async () => {
    const { onProgressChange, session, socket } =
      await mountTerminal("running");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 3,
    });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("working\r\n") },
    });
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: osc("1;60") },
    });
    socket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("still working\r\n") },
    });
    await waitForReadinessCondition(
      () => ackedThrough(3),
      "replayed output was not acknowledged",
    );
    expect(onProgressChange.mock.calls).toEqual([
      [0.6, 1, "term_progress_replay"],
    ]);

    socket.receive({
      type: "output",
      chunk: { seq: 3, dataBase64: osc("1;40") },
    });
    socket.receive({
      type: "output",
      chunk: { seq: 4, dataBase64: osc("0") },
    });
    await waitForReadinessCondition(
      () =>
        expect(onProgressChange.mock.calls).toEqual([
          [0.6, 1, "term_progress_replay"],
          [0.4, 3, "term_progress_replay"],
          [null, 4, "term_progress_replay"],
        ]),
      "live progress was not reported with its output sequence",
    );
  });

  it("reports the output sequence of the retained output of an exited terminal", async () => {
    vi.mocked(sdk.terminals.output).mockResolvedValue({
      chunks: [
        { seq: 0, dataBase64: osc("1;70") },
        { seq: 1, dataBase64: btoa("done\r\n") },
      ],
      nextSeq: 2,
    } as Awaited<ReturnType<typeof sdk.terminals.output>>);
    const { onProgressChange } = renderTerminal("exited");
    await waitForReadinessCondition(
      () =>
        expect(
          document.querySelector(".xterm-rows")?.textContent ?? "",
        ).toContain("Terminal exited"),
      "retained output was not written within 5000 ms",
    );
    expect(onProgressChange.mock.calls).toEqual([
      [0.7, 0, "term_progress_replay"],
    ]);
  });
});
