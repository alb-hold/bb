// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PromptBoxHandle } from "./ComposerBox";

const saved = vi.hoisted(() => ({ hasFailed: vi.fn(), runtime: vi.fn() }));
vi.mock("@/lib/voice-recording-store", () => ({
  hasFailedVoiceRecordings: saved.hasFailed,
}));
vi.mock("./usePromptVoiceRuntime", () => {
  saved.runtime();
  return { PromptVoiceRuntime: () => <p>Recovered recordings</p> };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([false, true])(
  "loads the voice runtime without microphone intent only for saved recovery (saved=%s)",
  async (hasSaved) => {
    vi.resetModules();
    saved.hasFailed.mockResolvedValue(hasSaved);
    const { usePromptVoice } = await import("./usePromptVoice");
    function Composer() {
      const ref: { current: PromptBoxHandle | null } = { current: null };
      const voice = usePromptVoice(ref, undefined, "thread/recover");
      return <>{voice.runtime}</>;
    }
    const view = render(<Composer />);
    await waitFor(() =>
      expect(saved.hasFailed).toHaveBeenCalledWith("thread/recover"),
    );
    if (hasSaved) {
      await waitFor(() =>
        expect(view.queryByText("Recovered recordings")).not.toBeNull(),
      );
      expect(saved.runtime).toHaveBeenCalledOnce();
    } else {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      expect(saved.runtime).not.toHaveBeenCalled();
      expect(view.queryByText("Recovered recordings")).toBeNull();
    }
  },
);
