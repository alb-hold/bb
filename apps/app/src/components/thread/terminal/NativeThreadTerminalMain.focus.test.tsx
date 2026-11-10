// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NativeTerminalThread } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeThreadTerminalMain } from "./NativeThreadTerminalMain";

const pane = vi.hoisted(() => ({ isFocused: true }));
const execution = vi.hoisted(() => ({
  data: {
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
  } as {
    model?: string;
    reasoningLevel?: string;
    permissionMode?: string;
  } | null,
}));

vi.mock("@/views/thread-detail/PaneContext", () => ({
  useOptionalPaneContext: () => ({ isFocused: pane.isFocused }),
}));
vi.mock("@bb/shared-ui/hooks/use-media-query", () => ({
  useMediaQuery: () => false,
}));
vi.mock("@/hooks/useNativeActivityUnconfirmed", () => ({
  useNativeActivityUnconfirmed: () => false,
  useNativeActivityNotice: () => ({
    evidenceKind: "unknown",
    lastToolCallAt: null,
    now: 0,
    unconfirmed: false,
  }),
}));
vi.mock("@/hooks/queries/native-terminal-queries", () => ({
  useNativeTerminalThread: () => ({ dataUpdatedAt: 1, refetch: vi.fn() }),
  useOpenNativeTerminal: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data:
      execution.data === null
        ? null
        : {
            executed: null,
            lastRequested: null,
            nextTurn: execution.data,
            overrides: { model: null, reasoningLevel: null },
          },
  }),
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadPendingInteractions: () => ({ data: [] }),
}));
vi.mock("@/hooks/queries/thread-terminal-queries", () => ({
  useThreadTerminals: () => ({ data: undefined, dataUpdatedAt: 0 }),
}));
vi.mock("./NativeTerminalPanel", () => ({
  NativeTerminalPanel: Object.assign(
    ({ autoFocus }: { autoFocus?: boolean }) => (
      <div data-testid="terminal" data-autofocus={String(autoFocus)} />
    ),
    { preload: vi.fn() },
  ),
}));
vi.mock("./NativeTerminalPromptBar", () => ({
  NativeTerminalPromptBar: ({
    executionLabel = "Codex",
  }: {
    executionLabel?: string;
  }) => (
    <form data-native-terminal-prompt="">
      <span aria-label="Terminal execution">{executionLabel}</span>
      <textarea aria-label="Message" />
    </form>
  ),
}));
vi.mock("./NativeActivityNotice", () => ({
  NativeActivityNotice: () => null,
}));
vi.mock("./NativeTerminalWaitingBanner", () => ({
  NativeTerminalWaitingBanner: () => null,
  nativeTerminalWaitingPrompts: () => [],
}));

afterEach(() => {
  cleanup();
  pane.isFocused = true;
  execution.data = {
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
  };
});

const view = {
  providerId: "codex",
  displayName: "Codex",
  terminal: { id: "term_1", status: "running", exitCode: null },
} as unknown as NativeTerminalThread;

function renderMain() {
  return render(
    <NativeThreadTerminalMain
      projectId="proj_1"
      threadId="thr_1"
      threadIsProvisioning={false}
      view={view}
      runtime={{ displayStatus: "idle" }}
    />,
  );
}

const terminalAutoFocus = () =>
  screen.getByTestId("terminal").getAttribute("data-autofocus");

describe("NativeThreadTerminalMain focus", () => {
  it("uses the composer labels for the stored model, reasoning and permission", () => {
    renderMain();
    expect(screen.getByLabelText("Terminal execution").textContent).toBe(
      "Default: GPT-5 · Medium · Full Access",
    );
  });

  it.each([null, {}, { model: "gpt-5" }])(
    "omits absent execution fields for %j",
    (data) => {
      execution.data = data;
      renderMain();
      expect(screen.getByLabelText("Terminal execution").textContent).toBe(
        data?.model ? "Default: GPT-5" : "Codex",
      );
    },
  );

  it("auto-focuses the terminal on desktop until the user focuses the composer", () => {
    renderMain();
    expect(terminalAutoFocus()).toBe("true");
    fireEvent.focus(screen.getByLabelText("Message"));
    expect(terminalAutoFocus()).toBe("false");
  });

  it("keeps the terminal from taking focus back after the composer blurs, until the pane loses focus", () => {
    const view_ = renderMain();
    const composer = screen.getByLabelText("Message");
    fireEvent.focus(composer);
    fireEvent.blur(composer);
    expect(terminalAutoFocus()).toBe("false");
    pane.isFocused = false;
    view_.rerender(
      <NativeThreadTerminalMain
        projectId="proj_1"
        threadId="thr_1"
        threadIsProvisioning={false}
        view={view}
        runtime={{ displayStatus: "idle" }}
      />,
    );
    pane.isFocused = true;
    view_.rerender(
      <NativeThreadTerminalMain
        projectId="proj_1"
        threadId="thr_1"
        threadIsProvisioning={false}
        view={view}
        runtime={{ displayStatus: "idle" }}
      />,
    );
    expect(terminalAutoFocus()).toBe("true");
  });
});

it.each(["active", "idle"] as const)(
  "describes an unlabelled signal truthfully while %s",
  (displayStatus) => {
    const activityTarget = render(<header />).container;
    render(
      <NativeThreadTerminalMain
        activityTarget={activityTarget}
        projectId="proj_1"
        threadId="thr_1"
        threadIsProvisioning={false}
        view={{
          ...view,
          terminal: {
            ...view.terminal!,
            attention: { at: 10, kind: "bell", seq: 1 },
          },
        }}
        runtime={{ displayStatus }}
      />,
    );
    expect(
      screen.getByRole("status", { name: "Terminal activity" }).textContent,
    ).toBe("Check terminal");
  },
);
