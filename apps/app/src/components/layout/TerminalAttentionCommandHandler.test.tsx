// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_ATTENTION_CONTRACT_CASES } from "@bb/test-helpers";
import { TerminalAttentionCommandHandler } from "./TerminalAttentionCommandHandler";

const mocks = vi.hoisted(() => ({
  handler: undefined as (() => boolean) | undefined,
  message: vi.fn(),
  error: vi.fn(),
  navigate: vi.fn(),
  next: vi.fn(),
  getThread: vi.fn(),
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandHandler: (_command: string, handler: () => boolean) => {
    mocks.handler = handler;
  },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { message: mocks.message, error: mocks.error },
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    terminals: { experimental_attention: { next: mocks.next } },
    threads: { get: mocks.getThread },
  },
}));

afterEach(() => {
  cleanup();
  mocks.handler = undefined;
  mocks.message.mockReset();
  mocks.error.mockReset();
  mocks.navigate.mockReset();
  mocks.next.mockReset();
  mocks.getThread.mockReset();
});

describe("terminal attention command", () => {
  it.each(TERMINAL_ATTENTION_CONTRACT_CASES)(
    "follows the shared terminal attention contract: $name",
    async (contract) => {
      const next =
        contract.nextId === null
          ? null
          : {
              id: contract.nextId,
              threadId: "thr_1",
            };
      mocks.next.mockResolvedValue(next);
      mocks.getThread.mockResolvedValue({ projectId: "proj_1" });
      render(<TerminalAttentionCommandHandler />);

      await act(async () => {
        mocks.handler?.();
      });

      if (contract.nextId === null) {
        await waitFor(() => {
          expect(mocks.message).toHaveBeenCalledWith(
            "Nothing needs attention.",
          );
        });
        expect(mocks.navigate).not.toHaveBeenCalled();
        return;
      }

      await waitFor(() => {
        expect(mocks.navigate).toHaveBeenCalledWith(
          "/projects/proj_1/threads/thr_1",
          { state: { terminalAttentionId: contract.nextId } },
        );
      });
    },
  );

  it("opens a threadless target in the root terminal pane", async () => {
    const session = {
      id: "term_global",
      threadId: null,
      environmentId: null,
      hostId: "host_1",
      title: "Build logs",
      initialCwd: "/workspace",
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
      attention: { at: 10, kind: "bell", seq: 1 },
    };
    mocks.next.mockResolvedValue(session);
    render(<TerminalAttentionCommandHandler />);

    await act(async () => {
      mocks.handler?.();
    });

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith(expect.any(String), {
        state: { terminalAttentionSession: session },
      });
    });
  });
});
