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
  it("keeps both execution labels visible beside a bounded model chip", () => {
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
    expect(wrappingRow?.getAttribute("data-execution-controls-layout")).toBe("stacked");
    expect(chip.hasAttribute("data-model-reasoning-trigger")).toBe(true);
    for (const name of ["Chat", "Terminal"]) {
      const choice = screen.getByRole("radio", { name });
      expect(choice.className).toContain("data-[state=on]:bg-accent");
      expect(choice.textContent).toBe(name);
      expect(
        choice.querySelector("span")?.classList.contains("max-md:hidden"),
      ).toBe(false);
    }
    expect(chip.textContent).toContain("1M");
  });

  it("shows whether the thread runs in chat or its terminal and switches between them", () => {
    const onChange = vi.fn();
    const { rerender } = renderExecutionControls({
      ...makeExecutionControlsProps(),
      nativeTerminal: { enabled: false, onChange },
    });

    const group = screen.getByRole("radiogroup", {
      name: "Run this thread in",
    });
    const chat = within(group).getByRole("radio", { name: "Chat" });
    const terminal = within(group).getByRole("radio", { name: "Terminal" });
    expect(chat.getAttribute("aria-description")).toBe(
      "bb renders the conversation",
    );
    expect(terminal.getAttribute("aria-description")).toBe(
      "Runs the provider's own CLI",
    );
    expect(terminal.className).toContain("max-md:h-11");
    expect(terminal.className).toContain("max-md:before:inset-y-1.5");
    expect(terminal.className).toContain(
      "max-md:data-[state=on]:bg-transparent",
    );
    expect(
      screen
        .getByRole("radiogroup", { name: "Run this thread in" })
        .classList.contains("border"),
    ).toBe(false);
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
    expect(
      screen
        .getByRole("radio", { name: "Terminal" })
        .querySelector("span")
        ?.classList.contains("max-md:hidden"),
    ).toBe(false);
    expect(
      screen
        .getByRole("radio", { name: "Chat" })
        .querySelector("span")
        ?.classList.contains("max-md:hidden"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("radio", { name: "Chat" }));
    expect(onChange).toHaveBeenLastCalledWith(false);

    rerender(<ExecutionControls {...makeExecutionControlsProps()} />);
    expect(
      screen.queryByRole("radiogroup", { name: "Run this thread in" }),
    ).toBeNull();
  });

  it("keeps real execution controls mounted while their catalog resolves", () => {
    const props = {
      ...makeExecutionControlsProps(),
      nativeTerminal: { enabled: true, onChange: vi.fn() },
    };
    const { container, rerender } = renderExecutionControls({
      ...props,
      pending: true,
    });
    const model = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    const terminal = screen.getByRole("radio", { name: "Terminal" });
    expect(model.textContent).toContain("GPT-5");
    expect(model.hasAttribute("disabled")).toBe(true);
    expect(terminal.getAttribute("data-state")).toBe("on");
    expect(
      container.querySelector('[role="status"], [data-slot="skeleton"]'),
    ).toBeNull();
    rerender(<ExecutionControls {...props} pending={false} />);
    expect(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    ).toBe(model);
    expect(screen.getByRole("radio", { name: "Terminal" })).toBe(terminal);
    expect(model.hasAttribute("disabled")).toBe(false);
    expect(
      container.querySelector('[role="status"], [data-slot="skeleton"]'),
    ).toBeNull();
  });

  it("retains the mode control geometry when the resolved provider cannot run terminals", () => {
    const onChange = vi.fn();
    const props = {
      ...makeExecutionControlsProps(),
      nativeTerminal: { enabled: false, disabled: true, onChange },
    };
    const { container, rerender } = renderExecutionControls({
      ...props,
      pending: true,
    });
    const before = Array.from(container.querySelectorAll("button")).map(
      (button) => button.className,
    );
    const count = container.querySelectorAll("button").length;
    rerender(
      <ExecutionControls
        {...props}
        nativeTerminal={{
          ...props.nativeTerminal,
          unavailableReason: "This provider does not support Terminal mode",
        }}
        pending={false}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(count);
    const terminal = screen.getByRole("radio", { name: "Terminal" });
    expect(terminal.className).toBe(before.at(-1));
    expect(terminal.hasAttribute("disabled")).toBe(true);
    expect(terminal.title).toBe("This provider does not support Terminal mode");
    fireEvent.click(terminal);
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("radiogroup", { name: "Run this thread in" })
        .closest('[data-execution-controls-layout="stacked"]'),
    ).not.toBeNull();
  });

  it("exposes the stored-model substitution on the model chip", () => {
    const props = makeExecutionControlsProps();
    const note = "gpt-5.2-codex isn't available; using GPT-5";
    renderExecutionControls({
      ...props,
      model: { ...props.model, unavailableModel: "gpt-5.2-codex" },
    });
    const chip = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    expect(chip.querySelector("[title]")?.getAttribute("title")).toBe(note);
    expect(chip.getAttribute("aria-description")).toBe(note);
    expect(chip.textContent).toContain("GPT-5");
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

    expect(trigger.textContent).toContain("o4-Mini");
    expect(trigger.textContent).not.toContain("Failed to load models");
  });
});
