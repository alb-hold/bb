// @vitest-environment jsdom

import { useLayoutEffect, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ExperimentalComposerInput } from "@get-bb/plugin-sdk";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { ProgressiveComposer } from "./ProgressiveComposer";
import type {
  ComposerBoxProps,
  PromptBoxSubmissionConfig,
} from "./ComposerBox";

type Handoff = NonNullable<
  ExperimentalComposerInput["experimental_startupHandoff"]
>;
vi.mock("./ComposerBox", () => ({
  useComposerRendererApi: () => ({ input: { attachments: undefined } }),
}));
let frames: FrameRequestCallback[] = [];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  frames = [];
});

function PreparedEditor({ handoff }: { handoff: Handoff }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () =>
      handoff.attach((snapshot) => {
        const element = ref.current!;
        element.textContent = snapshot.draft.text;
        const selection = window.getSelection()!;
        if (snapshot.focused) element.focus();
        selection.setBaseAndExtent(
          element.firstChild ?? element,
          snapshot.anchor,
          element.firstChild ?? element,
          snapshot.head,
        );
      }),
    [handoff],
  );
  return (
    <div
      ref={ref}
      data-rich-editor=""
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
    />
  );
}

function setup(initial = "", submission?: PromptBoxSubmissionConfig) {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const submitted = vi.fn();
  const onChange = vi.fn();
  function Composer({ downloaded }: { downloaded: boolean }) {
    const [value, setValue] = useState(initial);
    const props: ComposerBoxProps = {
      submission,
      surface: "new-thread",
      value,
      mentionRanges: [],
      onChange: (next, mentions) => {
        onChange(next, mentions);
        setValue(next);
      },
      onSubmit: () => {
        submitted(value);
        setValue("");
      },
      placeholder: "Ask anything.",
      typeahead: {
        mention: { source: { projectId: undefined, environmentId: null } },
        command: {
          source: {
            projectId: undefined,
            providerId: undefined,
            commandScope: "new-thread",
            skillsTriggers: [],
            environmentId: null,
          },
        },
      },
      mentionMenuPlacement: "bottom",
    };
    return (
      <TooltipProvider>
        <ProgressiveComposer props={props}>
          {(handoff, _rich, layout) =>
            layout(downloaded ? <PreparedEditor handoff={handoff} /> : null)
          }
        </ProgressiveComposer>
      </TooltipProvider>
    );
  }
  const view = render(<Composer downloaded={false} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Ask anything.",
  });
  return {
    ...view,
    input,
    submitted,
    onChange,
    download: () => view.rerender(<Composer downloaded />),
    flush: () =>
      act(() => {
        const pending = frames;
        frames = [];
        for (const callback of pending) callback(0);
      }),
  };
}

it("keeps a 44px phone submit slot before and after typing during startup", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const view = setup();
  const sizeClasses = () => {
    const button = screen.getByRole("button", { name: "Submit (Enter)" });
    expect(button.classList).toContain("max-md:pointer-coarse:size-11");
    expect(button.classList).not.toContain("max-md:pointer-coarse:h-10");
    return Array.from(button.classList).filter((token) =>
      /^max-md:pointer-coarse:(?:size|h|w)-/.test(token),
    );
  };
  const emptySize = sizeClasses();
  fireEvent.change(view.input, { target: { value: "Send this" } });
  expect(sizeClasses()).toEqual(emptySize);
});

it("carries the last keystroke, backward selection and focus at the actual swap", () => {
  const view = setup("hello world");
  view.input.focus();
  view.download();
  fireEvent.change(view.input, { target: { value: "hello @world /plan!" } });
  view.input.setSelectionRange(6, 12, "backward");
  view.flush();
  const editor =
    view.container.querySelector<HTMLElement>("[data-rich-editor]")!;
  expect(editor.textContent).toBe("hello @world /plan!");
  expect(view.container.querySelector("textarea")).toBeNull();
  expect(document.activeElement).toBe(editor);
  expect(window.getSelection()?.anchorOffset).toBe(12);
  expect(window.getSelection()?.focusOffset).toBe(6);
});

it("keeps the composing input mounted until compositionend and carries the final input event", () => {
  const view = setup("draft ");
  fireEvent.compositionStart(view.input);
  view.download();
  fireEvent.change(view.input, { target: { value: "draft に" } });
  view.flush();
  expect(view.container.querySelector("textarea")).toBe(view.input);
  fireEvent.keyDown(view.input, {
    key: "Enter",
    keyCode: 229,
    isComposing: true,
  });
  expect(view.submitted).not.toHaveBeenCalled();
  fireEvent.compositionEnd(view.input, { data: "日本語" });
  fireEvent.change(view.input, { target: { value: "draft 日本語" } });
  view.input.setSelectionRange(9, 9);
  view.flush();
  expect(view.container.querySelector("[data-rich-editor]")?.textContent).toBe(
    "draft 日本語",
  );
  expect(window.getSelection()?.focusOffset).toBe(9);
});

it("submits Enter before the rich editor downloads and keeps Shift+Enter for text", () => {
  const view = setup();
  fireEvent.change(view.input, { target: { value: "send this" } });
  fireEvent.keyDown(view.input, { key: "Enter", shiftKey: true });
  expect(view.submitted).not.toHaveBeenCalled();
  fireEvent.keyDown(view.input, { key: "Enter" });
  expect(view.submitted).toHaveBeenCalledExactlyOnceWith("send this");
  expect(view.input.value).toBe("");
});

it("leaves focus on a different input when the rich editor becomes ready", () => {
  const view = setup("background draft");
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  view.download();
  view.flush();
  expect(document.activeElement).toBe(other);
  other.remove();
});

it.each([false, true])(
  "keeps empty-draft modifier submission semantics before rich startup (swap=%s)",
  (swapSubmitActions) => {
    const modifier = vi.fn();
    const view = setup("", { onModifierSubmit: modifier, swapSubmitActions });
    fireEvent.keyDown(view.input, {
      key: "Enter",
      ctrlKey: !swapSubmitActions,
    });
    expect(modifier).toHaveBeenCalledOnce();
    expect(view.submitted).not.toHaveBeenCalled();
    fireEvent.change(view.input, { target: { value: "queued text" } });
    fireEvent.keyDown(view.input, { key: "Enter", ctrlKey: swapSubmitActions });
    expect(view.submitted).toHaveBeenCalledExactlyOnceWith("queued text");
  },
);
