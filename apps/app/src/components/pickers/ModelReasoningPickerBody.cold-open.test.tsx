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
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

const download = vi.hoisted(() => ({ imports: 0, release: () => {} }));
vi.mock("./ModelReasoningPickerBody", async (original) => {
  download.imports += 1;
  await new Promise<void>((resolve) => {
    download.release = resolve;
  });
  return original();
});
afterEach(cleanup);

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
  await act(async () => download.release());
  const search = await screen.findByPlaceholderText(
    "Search models",
    {},
    { timeout: 10000 },
  );
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});
