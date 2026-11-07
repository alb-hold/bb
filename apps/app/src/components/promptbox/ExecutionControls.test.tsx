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
import { Icon } from "@bb/shared-ui/icon";
import { readFileSync } from "node:fs";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";

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
  it.each([
    [360, false],
    [390, false],
    [360, true],
    [390, true],
  ] as const)(
    "keeps model identities at %spx with terminal=%s",
    (width, terminal) => {
      const props = makeExecutionControlsProps();
      const { wrapper } = createQueryClientTestHarness();
      const names = [
        "GPT-6.1-Sol",
        "Claude Opus 5.5 (1M)",
        "Organization Custom ACP Production Model",
      ];
      const content = (label: string) => (
        <CompactViewportOverrideProvider isCompactViewport>
          <div style={{ width }}>
            <ExecutionControls
              {...props}
              model={{ ...props.model, options: [{ value: "gpt-5", label }] }}
              nativeTerminal={{ enabled: terminal, onChange: vi.fn() }}
            />
          </div>
        </CompactViewportOverrideProvider>
      );
      const view = render(content(names[0]!), { wrapper });
      for (const label of names) {
        view.rerender(content(label));
        const trigger = screen.getByRole("button", {
          name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        });
        const name = trigger.querySelector("[data-model-name]")!;
        expect(name.textContent).toContain(
          label === names[0] ? "6.1-Sol" : label.split(" (")[0],
        );
        expect(name.className).not.toContain("truncate");
        expect(trigger.textContent).not.toContain("Medium");
        expect(
          trigger.querySelector("[title]")?.getAttribute("title"),
        ).toContain(label);
        expect(
          screen
            .getByRole("radio", { name: terminal ? "Terminal" : "Chat" })
            .getAttribute("data-state"),
        ).toBe("on");
        const selected = screen.getByRole("radio", {
          name: terminal ? "Terminal" : "Chat",
        });
        expect(selected.className).not.toContain(
          "data-[state=on]:border-foreground/60",
        );
      }
    },
  );

  it("gives selected terminal a foreground label and single selected fill", () => {
    renderExecutionControls({
      ...makeExecutionControlsProps(),
      nativeTerminal: { enabled: true, onChange: vi.fn() },
    });
    const terminal = screen.getByRole("radio", { name: "Terminal" });
    expect(terminal.getAttribute("data-state")).toBe("on");
    expect(terminal.className).toContain("data-[state=on]:text-foreground");
    expect(terminal.className).not.toContain(
      "data-[state=on]:border-foreground/60",
    );
    expect(terminal.className).toContain("data-[state=on]:bg-accent");
    expect(terminal.hasAttribute("disabled")).toBe(false);
  });

  it.each([
    "GPT-6.1-Sol",
    "Opus 5.5 (1M)",
    "Organization Custom ACP Production Model",
  ])(
    "reserves a shared minimum width and exposes the full selection for %s",
    (label) => {
      const props = makeExecutionControlsProps();
      const { wrapper } = createQueryClientTestHarness();
      const content = (loading: boolean) => (
        <ExecutionControls
          {...props}
          model={
            loading
              ? { ...props.model, selected: "", options: [], isLoading: true }
              : {
                  ...props.model,
                  selected: "gpt-6.1-sol",
                  options: [{ value: "gpt-6.1-sol", label }],
                }
          }
          nativeTerminal={{ enabled: false, onChange: vi.fn() }}
        />
      );
      const { rerender } = render(content(true), { wrapper });
      const trigger = screen.getByRole("button", {
        name: /^Provider, model and reasoning/,
      });
      const widthContract = () => {
        expect(trigger.classList.contains("min-w-44")).toBe(true);
        expect(trigger.classList.contains("w-max")).toBe(true);
        expect(trigger.classList.contains("shrink-0")).toBe(false);
      };
      widthContract();
      rerender(content(false));
      expect(trigger.getAttribute("aria-description")).toContain(
        label.replace("GPT-", ""),
      );
      expect(trigger.getAttribute("aria-description")).toContain(
        "Medium reasoning",
      );
      widthContract();
    },
  );

  it.each([320, 360, 390])(
    "keeps Terminal and Chat labels visible at %i px",
    (width) => {
      const css = readFileSync("src/app.css", "utf8");
      const style = document.createElement("style");
      const media = /@media \(width <= (\d+)px\) \{/g;
      for (const match of css.matchAll(media)) {
        if (width > Number(match[1])) continue;
        const start = match.index! + match[0].length;
        let end = start;
        let depth = 1;
        while (depth > 0 && end < css.length) {
          if (css[end] === "{") depth++;
          if (css[end] === "}") depth--;
          end++;
        }
        style.textContent += css.slice(start, end - 1);
      }
      document.head.append(style);
      try {
        renderExecutionControls({
          ...makeExecutionControlsProps(),
          nativeTerminal: { enabled: true, onChange: vi.fn() },
        });
        for (const label of ["Terminal", "Chat"]) {
          const button = screen.getByRole("radio", { name: label });
          const text = within(button).getByText(label);
          expect(getComputedStyle(text).display).not.toBe("none");
          expect(getComputedStyle(text).visibility).not.toBe("hidden");
        }
      } finally {
        style.remove();
      }
    },
  );

  it("paints the loading model at 390px and resolves without remounting across phone widths", () => {
    const props = makeExecutionControlsProps();
    const { wrapper } = createQueryClientTestHarness();
    const css = readFileSync("src/app.css", "utf8");
    const style = document.createElement("style");
    style.textContent =
      "[data-model-reasoning-trigger] > span { visibility: hidden; }" +
      css
        .slice(css.lastIndexOf("@media (width <= 480px) {"))
        .replace("@media (width <= 480px) {", "")
        .replace(/}\s*$/, "");
    document.head.append(style);
    const content = (width: number, loading: boolean) => (
      <CompactViewportOverrideProvider isCompactViewport>
        <div style={{ width }}>
          <ExecutionControls
            {...props}
            provider={{
              ...props.provider,
              options: [
                {
                  value: "codex",
                  label: "Codex",
                  icon: () => <Icon name="Terminal" />,
                },
              ],
            }}
            model={
              loading
                ? { ...props.model, selected: "", options: [], isLoading: true }
                : props.model
            }
            nativeTerminal={{ enabled: true, onChange: vi.fn() }}
          />
        </div>
      </CompactViewportOverrideProvider>
    );
    try {
      const { rerender } = render(content(390, true), { wrapper });
      const trigger = screen.getByRole("button", {
        name: /^Provider, model and reasoning/,
      });
      expect(trigger.textContent).toBe("Model");
      expect(
        getComputedStyle(trigger.querySelector(":scope > span")!).visibility,
      ).toBe("visible");
      expect(trigger.querySelectorAll("[data-icon-root]")).toHaveLength(2);
      rerender(content(360, true));
      expect(
        screen.getByRole("button", { name: /^Provider, model and reasoning/ }),
      ).toBe(trigger);
      rerender(content(390, false));
      expect(
        screen.getByRole("button", { name: /^Provider, model and reasoning/ }),
      ).toBe(trigger);
      expect(trigger.querySelector("[data-model-name]")?.textContent).toBe("5");
    } finally {
      style.remove();
    }
  });

  it("keeps the unresolved model glyph and chevron in a 360px compact composer", () => {
    const props = makeExecutionControlsProps();
    const { wrapper } = createQueryClientTestHarness();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <div style={{ width: 360 }}>
          <ExecutionControls
            {...props}
            pending
            provider={{ options: [], selectedId: "" }}
            model={{
              ...props.model,
              selected: "",
              options: [],
              isLoading: true,
            }}
            nativeTerminal={{ enabled: true, onChange: vi.fn() }}
          />
        </div>
      </CompactViewportOverrideProvider>,
      { wrapper },
    );

    const chip = screen.getByRole("button", {
      name: /^Provider, model and reasoning/,
    });
    expect(chip.textContent).toBe("Model");
    expect(chip.querySelectorAll("[data-icon-root]").length).toBe(2);
    expect(chip.hasAttribute("disabled")).toBe(false);
    expect(
      chip
        .closest("[data-execution-controls-layout]")
        ?.getAttribute("data-execution-controls-layout"),
    ).toBe("stacked");
    expect(screen.getByRole("radio", { name: "Chat" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Terminal" })).toBeTruthy();
  });

  it("keeps model text beside compact execution choices", () => {
    const props = makeExecutionControlsProps();
    const { wrapper } = createQueryClientTestHarness();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <ExecutionControls
          {...props}
          provider={{
            ...props.provider,
            options: [
              {
                value: "codex",
                label: "Codex",
                icon: () => <Icon name="Terminal" />,
              },
            ],
          }}
          model={{
            ...props.model,
            selected: "gpt-6.1-sol",
            options: [{ value: "gpt-6.1-sol", label: "GPT-6.1-Sol" }],
          }}
          nativeTerminal={{ enabled: true, onChange: vi.fn() }}
        />
      </CompactViewportOverrideProvider>,
      { wrapper },
    );

    const chip = screen.getByRole("button", {
      name: /^Provider, model and reasoning/,
    });
    expect(chip.textContent).toContain("6.1-Sol");
    expect(chip.querySelectorAll("[data-icon-root]").length).toBe(2);
    expect(screen.getByRole("radio", { name: "Chat" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Terminal" })).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

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
      name: /^Provider, model and reasoning/,
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
    expect(wrappingRow?.getAttribute("data-execution-controls-layout")).toBe(
      "stacked",
    );
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
      name: /^Provider, model and reasoning/,
    });
    const terminal = screen.getByRole("radio", { name: "Terminal" });
    expect(model.textContent).toContain("GPT-5");
    expect(model.hasAttribute("disabled")).toBe(false);
    expect(terminal.getAttribute("data-state")).toBe("on");
    expect(
      container.querySelector('[role="status"], [data-slot="skeleton"]'),
    ).toBeNull();
    rerender(<ExecutionControls {...props} pending={false} />);
    expect(
      screen.getByRole("button", { name: /^Provider, model and reasoning/ }),
    ).toBe(model);
    expect(screen.getByRole("radio", { name: "Terminal" })).toBe(terminal);
    expect(model.hasAttribute("disabled")).toBe(false);
    expect(
      container.querySelector('[role="status"], [data-slot="skeleton"]'),
    ).toBeNull();
  });

  it("opens with the last selection while models are loading", async () => {
    const props = makeExecutionControlsProps();
    renderExecutionControls({
      ...props,
      pending: true,
      model: {
        ...props.model,
        options: [],
        isLoading: true,
      },
    });
    const trigger = screen.getByRole("button", {
      name: /^Provider, model and reasoning/,
    });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(trigger.textContent).toContain("GPT-5");
    fireEvent.click(trigger);
    expect(await screen.findByLabelText("Loading models")).toBeTruthy();
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
      name: /^Provider, model and reasoning/,
    });
    expect(chip.querySelector("[title]")?.getAttribute("title")).toBe(note);
    expect(chip.getAttribute("aria-description")).toBe(note);
    expect(chip.textContent).toContain("GPT-5");
  });

  it("hides provider tabs when the provider is locked", () => {
    renderExecutionControls(makeExecutionControlsProps());

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Provider, model and reasoning/,
      }),
    );

    expect(screen.queryByText("Model")).not.toBeNull();
    expect(screen.queryByTitle("Claude Code")).toBeNull();
  });

  it("shows provider tabs when provider changes are allowed", () => {
    renderExecutionControls(makeExecutionControlsProps(vi.fn()));

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Provider, model and reasoning/,
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
      name: /^Provider, model and reasoning/,
    });

    expect(trigger.textContent).toContain("o4-Mini");
    expect(trigger.textContent).not.toContain("Failed to load models");
  });
});

it.each([false, true])(
  "keeps phone mode selection distinct with loading=%s",
  (loading) => {
    const props = makeExecutionControlsProps();
    const { container } = renderExecutionControls({
      ...props,
      pending: loading,
      model: { ...props.model, isLoading: loading },
      nativeTerminal: { enabled: true, onChange: vi.fn() },
    });
    const pill = container.querySelector("[data-model-reasoning-trigger]")!;
    expect(pill.className).toContain("max-md:min-h-11");
    expect(pill.className).toContain("max-md:rounded-md");
    expect(pill.className).toContain("max-md:bg-transparent");
    const terminal = screen.getByRole("radio", { name: "Terminal" });
    expect(terminal.getAttribute("data-state")).toBe("on");
    expect(terminal.className).toContain("max-md:h-11");
    expect(terminal.className).toContain("max-md:px-2");
    expect(terminal.parentElement!.className).toContain("w-max");
  },
);
