// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  ExecutionControls,
  type ExecutionControlsProps,
} from "./ExecutionControls";
import { ModelReasoningMenu } from "@/components/pickers/ModelReasoningMenuSplit";

function makeExecutionControlsProps(
  providerOnChange?: (value: string) => void,
): ExecutionControlsProps {
  return {
    provider: {
      options: [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude Code" },
      ],
      selectedId: "codex",
      onChange: providerOnChange,
      hasMultiple: true,
    },
    model: {
      active: null,
      selected: "gpt-5",
      options: [{ value: "gpt-5", label: "GPT-5" }],
      moreOptions: [],
      isLoading: false,
      loadFailed: false,
      loadError: null,
      onChange: vi.fn(),
    },
    reasoning: {
      value: "medium",
      options: [{ value: "medium", label: "Medium" }],
      onChange: vi.fn(),
    },
  };
}

function renderExecutionControls(props: ExecutionControlsProps) {
  const { wrapper } = createQueryClientTestHarness();
  return render(<ExecutionControls {...props} />, { wrapper });
}

beforeAll(() => ModelReasoningMenu.preload());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ExecutionControls", () => {
  it("keeps the model chip bounded beside a terminal control that can wrap", () => {
    const props = makeExecutionControlsProps();
    renderExecutionControls({
      ...props,
      model: {
        ...props.model,
        selected: "claude-opus-4-6",
        options: [{ value: "claude-opus-4-6", label: "Opus 4.6 (1M)" }],
      },
      nativeTerminal: { enabled: false, onChange: vi.fn() },
    });

    const chip = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    const control = screen.getByRole("radiogroup", {
      name: "Run this thread in",
    });
    const wrappingRow = chip.closest(".flex-wrap");
    expect(wrappingRow).not.toBeNull();
    expect(wrappingRow?.contains(control)).toBe(true);
    expect(wrappingRow?.classList.contains("min-w-0")).toBe(true);
    expect(wrappingRow?.classList.contains("max-w-full")).toBe(true);
    expect(chip.classList.contains("overflow-hidden")).toBe(true);
    expect(chip.textContent).toContain("1M");
  });

  it("shows whether the thread runs in chat or its terminal and switches between them", () => {
    const onChange = vi.fn();
    const { rerender } = renderExecutionControls({
      ...makeExecutionControlsProps(),
      nativeTerminal: { enabled: false, onChange },
    });

    const group = screen.getByRole("radiogroup", { name: "Run this thread in" });
    const chat = within(group).getByRole("radio", { name: "Chat" });
    const terminal = within(group).getByRole("radio", { name: "Terminal" });
    expect(chat.getAttribute("aria-checked")).toBe("true");
    expect(terminal.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(chat);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(terminal);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(
      <ExecutionControls
        {...makeExecutionControlsProps()}
        nativeTerminal={{ enabled: true, onChange }}
      />,
    );
    expect(
      screen
        .getByRole("radio", { name: "Terminal" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("radio", { name: "Chat" }));
    expect(onChange).toHaveBeenLastCalledWith(false);

    rerender(<ExecutionControls {...makeExecutionControlsProps()} />);
    expect(
      screen.queryByRole("radiogroup", { name: "Run this thread in" }),
    ).toBeNull();
  });

  it("hides provider tabs when the provider is locked", () => {
    renderExecutionControls(makeExecutionControlsProps());

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.queryByText("Model")).not.toBeNull();
    expect(screen.queryByTitle("Claude Code")).toBeNull();
  });

  it("shows provider tabs when provider changes are allowed", () => {
    renderExecutionControls(makeExecutionControlsProps(vi.fn()));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.queryByTitle("Claude Code")).not.toBeNull();
  });

  it("keeps showing the known model when model options fail to load", () => {
    const props = makeExecutionControlsProps();
    renderExecutionControls({
      ...props,
      model: {
        ...props.model,
        active: { model: "o4-mini" },
        options: [],
        loadFailed: true,
        loadError: { providerId: "codex", code: "failed", detail: null },
      },
    });

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(trigger.textContent).toContain("o4-mini");
    expect(trigger.textContent).not.toContain("Failed to load models");
  });
});
