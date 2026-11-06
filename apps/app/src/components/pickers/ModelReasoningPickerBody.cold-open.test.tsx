// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelReasoningPicker } from "./ModelReasoningPicker";
import { ModelReasoningPickerBody } from "./ModelReasoningPickerBodySplit";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

const download = vi.hoisted(() => ({ imports: 0, release: () => {} }));
vi.mock("./ModelReasoningPickerBody", async (original) => {
  download.imports += 1;
  await new Promise<void>((resolve) => {
    download.release = resolve;
  });
  return original();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps reasoning keys available and opens on the first click while the body downloads", async () => {
  const reasoning = vi.fn();
  const { wrapper } = createQueryClientTestHarness();
  render(
    <ModelReasoningPicker
      providerOptions={[{ value: "codex", label: "Codex" }]}
      selectedProviderId="codex"
      hasMultipleProviders={false}
      modelValue="gpt-5.5"
      modelOptions={[
        { value: "gpt-5.5", label: "GPT-5.5" },
        ...["o3", "o4", "gpt-5.2", "gpt-4.1", "gpt-4o"].map((value) => ({
          value,
          label: value,
        })),
      ]}
      onModelChange={() => {}}
      reasoningValue="medium"
      reasoningOptions={[
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ]}
      onReasoningChange={reasoning}
      serviceTierValue={undefined}
      serviceTierOptions={[]}
      onServiceTierChange={() => {}}
      modal={false}
    />,
    { wrapper },
  );
  expect(download.imports).toBe(0);
  const trigger = screen.getByRole("button", {
    name: "Provider, model and reasoning",
  });
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  expect(reasoning).toHaveBeenCalledExactlyOnceWith("high");
  fireEvent.click(trigger);
  await waitFor(() => expect(download.imports).toBe(1));
  expect(
    await screen.findByRole("status", { name: "Loading model picker" }),
  ).toBeTruthy();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  await act(async () => {
    download.release();
    await ModelReasoningPickerBody.preload();
  });
  const search = screen.getByPlaceholderText("Search models");
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  });
  expect(document.activeElement).toBe(search);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(document.activeElement).toBe(search);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(search, { key: "Escape" });
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});
