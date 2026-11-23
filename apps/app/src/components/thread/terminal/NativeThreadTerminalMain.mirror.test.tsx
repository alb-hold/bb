// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type {
  NativeTerminalThread,
  ThreadExecutionProfileResponse,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeThreadTerminalMain } from "./NativeThreadTerminalMain";

const hooks = vi.hoisted(() => ({
  profile: vi.fn<() => { data: ThreadExecutionProfileResponse | null }>(() => ({
    data: null,
  })),
  listTerminals: vi.fn(),
  refetchNative: vi.fn(),
  openNative: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: hooks.profile,
}));

vi.mock("./NativeTerminalPanel", () => ({
  NativeTerminalPanel: Object.assign(
    () => <div data-testid="terminal-panel" />,
    { preload: vi.fn() },
  ),
}));

vi.mock("@/hooks/queries/thread-terminal-queries", () => ({
  useThreadTerminals: hooks.listTerminals,
}));

vi.mock("@/hooks/queries/native-terminal-queries", () => ({
  useNativeTerminalThread: () => ({
    dataUpdatedAt: 1,
    refetch: hooks.refetchNative,
  }),
  useOpenNativeTerminal: () => ({ isPending: false, mutate: hooks.openNative }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadPendingInteractions: () => ({ data: [] }),
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

vi.mock("@bb/shared-ui/hooks/use-media-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@bb/shared-ui/hooks/use-media-query")
  >()),
  useMediaQuery: () => false,
}));

vi.mock("@/views/thread-detail/PaneContext", () => ({
  useOptionalPaneContext: () => null,
}));

vi.mock("./NativeTerminalPromptBar", () => ({
  NativeTerminalPromptBar: () => <div data-testid="prompt-bar" />,
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

const baseTerminal = {
  id: "term_mirror",
  threadId: "thr_mirror",
  environmentId: "env_mirror",
  hostId: "host_mirror",
  title: "Claude Code",
  initialCwd: "/workspace",
  cols: 120,
  rows: 36,
  status: "running" as const,
  exitCode: null,
  closeReason: null,
  createdAt: 1000,
  updatedAt: 1000,
  lastUserInputAt: null,
  attention: null,
};

const baseView: NativeTerminalThread = {
  threadId: "thr_mirror",
  providerId: "claude-code",
  displayName: "Claude Code",
  nativeSessionId: "session-mirror",
  model: null,
  canReturnToChat: false,
  terminal: baseTerminal,
  prompt: "Explain why the build failed",
  hasOutput: false,
  reply: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NativeThreadTerminalMain mirror states", () => {
  it("shows the prompt and a visible Starting terminal state before first output", () => {
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [baseTerminal] },
      dataUpdatedAt: 1,
      isLoading: false,
    });

    const { container } = render(
      <NativeThreadTerminalMain
        projectId="proj_mirror"
        runtime={{ displayStatus: "active" }}
        threadId="thr_mirror"
        threadIsProvisioning={false}
        view={baseView}
      />,
    );

    const promptMirror = container.querySelector(
      "[data-native-terminal-prompt-mirror]",
    );
    expect(promptMirror?.textContent).toContain("Explain why the build failed");
    const starting = container.querySelector(
      "[data-native-terminal-starting]",
    );
    expect(starting?.getAttribute("role")).toBe("status");
    expect(starting?.textContent).toContain("Starting terminal…");
    expect(
      container.querySelector("[data-native-terminal-reply-mirror]"),
    ).toBeNull();
  });

  it("hides Starting terminal once terminal output has been seen while keeping the prompt", () => {
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [baseTerminal] },
      dataUpdatedAt: 1,
      isLoading: false,
    });

    const { container } = render(
      <NativeThreadTerminalMain
        projectId="proj_mirror"
        runtime={{ displayStatus: "active" }}
        threadId="thr_mirror"
        threadIsProvisioning={false}
        view={{ ...baseView, hasOutput: true }}
      />,
    );

    expect(
      container.querySelector("[data-native-terminal-prompt-mirror]")
        ?.textContent,
    ).toContain("Explain why the build failed");
    expect(screen.queryByText("Starting terminal…")).toBeNull();
    expect(
      container.querySelector("[data-native-terminal-reply-mirror]"),
    ).toBeNull();
  });

  it("renders the final reply as markdown below the prompt once recorded", () => {
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [baseTerminal] },
      dataUpdatedAt: 1,
      isLoading: false,
    });

    const { container } = render(
      <NativeThreadTerminalMain
        projectId="proj_mirror"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_mirror"
        threadIsProvisioning={false}
        view={{
          ...baseView,
          hasOutput: true,
          reply: {
            text: "Fixed **the build** in `main.ts`.",
            recordedAt: 2000,
          },
        }}
      />,
    );

    const promptMirror = container.querySelector(
      "[data-native-terminal-prompt-mirror]",
    );
    const replyMirror = container.querySelector(
      "[data-native-terminal-reply-mirror]",
    );
    expect(promptMirror?.textContent).toContain("Explain why the build failed");
    expect(screen.queryByText("Starting terminal…")).toBeNull();
    expect(replyMirror).not.toBeNull();
    expect(replyMirror?.querySelector("strong")?.textContent).toBe("the build");
    expect(replyMirror?.querySelector("code")?.textContent).toBe("main.ts");
    expect(
      promptMirror!.compareDocumentPosition(replyMirror!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
