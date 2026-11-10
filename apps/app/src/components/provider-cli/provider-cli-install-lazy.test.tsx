// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderCliInstallLogDialogProps } from "@/components/dialogs/ProviderCliInstallLogDialog";
import { ProviderCliInstallLogDialogHost } from "./provider-cli-install";

const state = vi.hoisted(() => ({
  snapshot: { logDialogState: null } as {
    logDialogState: ProviderCliInstallLogDialogProps["state"];
  },
  listeners: new Set<() => void>(),
  loaded: vi.fn(),
  close: vi.fn(),
}));

vi.mock("./provider-cli-install-store", () => ({
  getProviderCliInstallSnapshot: () => state.snapshot,
  subscribeProviderCliInstalls: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
  closeProviderCliInstallLog: state.close,
}));

vi.mock("@/components/dialogs/ProviderCliInstallLogDialog", () => {
  state.loaded();
  return {
    ProviderCliInstallLogDialog: ({
      state: dialog,
      onClose,
    }: ProviderCliInstallLogDialogProps) => (
      <button onClick={onClose}>{dialog?.log ?? "Closed log"}</button>
    ),
  };
});

afterEach(cleanup);

it("loads setup logs on first open and retains the surface after closing", async () => {
  render(<ProviderCliInstallLogDialogHost />);
  expect(state.loaded).not.toHaveBeenCalled();
  act(() => {
    state.snapshot = {
      logDialogState: {
        displayName: "Codex",
        log: "Install failed: permission denied",
        message: "Review the setup log",
        title: "Setup failed",
      },
    };
    state.listeners.forEach((listener) => listener());
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Install failed: permission denied",
    }),
  );
  expect(state.close).toHaveBeenCalledOnce();
  act(() => {
    state.snapshot = { logDialogState: null };
    state.listeners.forEach((listener) => listener());
  });
  expect(screen.getByRole("button", { name: "Closed log" })).toBeTruthy();
  expect(state.loaded).toHaveBeenCalledOnce();
});
