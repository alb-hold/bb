// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePromptVoice } from "./usePromptVoice";
import type { PromptBoxHandle, PromptVoiceConfig } from "./ComposerBox";
import { appToast } from "@/components/ui/app-toast";

const download = vi.hoisted(() => ({
  imports: 0,
  reject: (_error: Error) => {},
}));
vi.mock("./usePromptVoiceRuntime", async () => {
  download.imports++;
  await new Promise<void>((_resolve, reject) => {
    download.reject = reject;
  });
  throw new Error("Voice download failed");
});
vi.mock("@/components/ui/app-toast", () => ({ appToast: { error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Composer() {
  const ref = useRef<PromptBoxHandle | null>(null);
  const voice = usePromptVoice(ref, undefined, null);
  return (
    <>
      {voice.runtime}
      <textarea defaultValue="Keep this draft" />
      <button onClick={() => void voice.start()}>Mic</button>
    </>
  );
}

it("keeps the draft and mic usable after a cold download failure, then records on one retry", async () => {
  render(<Composer />);
  const mic = screen.getByRole("button", { name: "Mic" });
  mic.focus();
  fireEvent.click(mic);
  await waitFor(() => expect(download.imports).toBe(1));
  await act(async () => download.reject(new Error("Offline")));
  await waitFor(() =>
    expect(appToast.error).toHaveBeenCalledWith(
      "Voice input couldn't load. Try again.",
    ),
  );
  expect(document.activeElement).toBe(mic);
  expect(screen.getByRole("textbox")).toHaveProperty(
    "value",
    "Keep this draft",
  );
  const start = vi.fn();
  vi.doMock("./usePromptVoiceRuntime", () => ({
    PromptVoiceRuntime: ({
      publish,
    }: {
      publish: (voice: PromptVoiceConfig) => void;
    }) => {
      useEffect(() => {
        publish({
          state: "idle",
          delivery: "insert",
          microphoneWarning: null,
          isSupported: true,
          stream: null,
          failedRecordings: [],
          start,
          stop: vi.fn(),
          send: vi.fn(),
          cancel: vi.fn(),
          retry: vi.fn(),
          discard: vi.fn(),
          download: vi.fn(),
        });
      }, [publish]);
      return null;
    },
  }));
  fireEvent.click(mic);
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("textbox")).toHaveProperty(
    "value",
    "Keep this draft",
  );
});
