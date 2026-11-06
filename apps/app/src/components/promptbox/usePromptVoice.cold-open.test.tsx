// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePromptVoice } from "./usePromptVoice";
import type { PromptBoxHandle } from "./ComposerBox";

const download = vi.hoisted(() => ({
  imports: 0,
  release: () => {},
  start: vi.fn(),
}));
vi.mock("./usePromptVoiceRuntime", async (original) => {
  download.imports += 1;
  await new Promise<void>((resolve) => {
    download.release = resolve;
  });
  return original();
});
vi.mock("@/hooks/useVoiceInput", () => ({
  useVoiceInput: () => ({
    state: "idle",
    delivery: "insert",
    microphoneWarning: null,
    isSupported: true,
    stream: null,
    failedRecordings: [],
    start: download.start,
    stop: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    discard: vi.fn(),
    download: vi.fn(),
  }),
}));
afterEach(cleanup);

function Composer() {
  const ref = useRef<PromptBoxHandle | null>(null);
  const voice = usePromptVoice(ref, undefined, null);
  return (
    <>
      {voice.runtime}
      <button onClick={() => void voice.start()}>Mic</button>
    </>
  );
}

it("records on the first press after the runtime download completes", async () => {
  render(<Composer />);
  vi.useFakeTimers();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  vi.useRealTimers();
  expect(download.imports).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Mic" }));
  await waitFor(() => expect(download.imports).toBe(1));
  expect(download.start).not.toHaveBeenCalled();
  await act(async () => download.release());
  await waitFor(() => expect(download.start).toHaveBeenCalledTimes(1), {
    timeout: 10000,
  });
  fireEvent.click(screen.getByRole("button", { name: "Mic" }));
  await waitFor(() => expect(download.start).toHaveBeenCalledTimes(2));
});
