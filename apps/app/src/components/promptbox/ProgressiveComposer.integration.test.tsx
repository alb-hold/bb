// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { useLayoutEffect, useRef, useState } from "react";
import { Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { PromptDraftAttachment } from "@bb/client-core";
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import {
  ComposerBox,
  type PromptBoxHandle,
  type PromptVoiceConfig,
} from "./ComposerBox";
import { PendingComposerSubmission } from "./PendingComposerSubmission";
import { ExecutionControls } from "./ExecutionControls";
import { registerComposerPlugin } from "@/test/fixtures/composer-plugin";
import {
  composerSearchQueries,
  testTypeaheadConfig,
} from "@/test/fixtures/composer-search";
import { resetPluginSlotStoreForTest } from "@/lib/plugin-slots";
import { resetPluginFrontendBootStateForTest } from "@/lib/plugin-frontend-boot-state";

vi.mock("@/hooks/usePromptMentions", async () =>
  (await import("@/test/fixtures/composer-search")).fakePromptMentionsModule(),
);
vi.mock("@/hooks/useCommandSuggestions", async () =>
  (
    await import("@/test/fixtures/composer-search")
  ).fakeCommandSuggestionsModule(),
);

beforeEach(() => {
  resetPluginSlotStoreForTest();
  resetPluginFrontendBootStateForTest();
});

it.each(["", "A phone draft that keeps its wrapping through hydration"])(
  "shares the phone input column and action layout (draft=%s)",
  async (draft) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })),
    );
    onTestFinished(() => vi.unstubAllGlobals());
    const style = document.createElement("style");
    const css = readFileSync("src/app.css", "utf8");
    style.textContent = css.slice(
      css.indexOf(
        "@media (width < 48rem) {",
        css.indexOf("root-compose-desktop-recents"),
      ),
    );
    document.head.append(style);
    onTestFinished(() => style.remove());
    const rules = Array.from(style.sheet?.cssRules ?? []).flatMap((rule) =>
      "conditionText" in rule &&
      "cssRules" in rule &&
      rule.conditionText === "(width < 48rem)"
        ? Array.from((rule as CSSMediaRule).cssRules).filter(
            (child): child is CSSStyleRule =>
              "selectorText" in child && "style" in child,
          )
        : [],
    );
    expect(rules.length).toBeGreaterThan(0);
    const declaration = (element: Element, property: string) =>
      rules
        .filter((rule) => element.matches(rule.selectorText))
        .map((rule) => rule.style.getPropertyValue(property))
        .filter(Boolean)
        .at(-1);
    function Host() {
      const [value, setValue] = useState(draft);
      return (
        <ComposerBox
          surface="new-thread"
          value={value}
          mentionRanges={[]}
          onChange={setValue}
          onSubmit={() => {}}
          placeholder="Ask anything."
          typeahead={testTypeaheadConfig()}
          executionControls={
            <ExecutionControls
              pending={false}
              provider={{ selectedId: "codex" }}
              nativeTerminal={{ enabled: false, onChange() {} }}
              reasoning={{
                value: "medium",
                options: [{ value: "medium", label: "Medium" }],
                onChange() {},
              }}
              model={{
                selected: "gpt-6.1-sol",
                options: [{ value: "gpt-6.1-sol", label: "GPT-6.1-Sol" }],
                moreOptions: [],
                isLoading: false,
                loadFailed: false,
                onChange() {},
              }}
            />
          }
        />
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    onTestFinished(() => client.clear());
    const view = render(
      <QueryClientProvider client={client}>
        <Provider>
          <MemoryRouter>
            <TooltipProvider>
              <Host />
            </TooltipProvider>
          </MemoryRouter>
        </Provider>
      </QueryClientProvider>,
    );
    const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything.",
    });
    input.focus();
    input.setSelectionRange(draft.length, draft.length);
    const checkLayout = () => {
      const scroll = view.container.querySelector(
        "[data-promptbox-editor-scroll]",
      )!;
      const region = scroll.parentElement!;
      expect(declaration(region, "padding-inline-end")).toBe("3rem");
      expect(region.hasAttribute("data-promptbox-input-region")).toBe(true);
      for (const token of [
        "w-full",
        "px-4",
        "pb-1",
        "pr-14",
        "pt-3",
        "max-md:pointer-coarse:text-base",
      ])
        expect(scroll.classList.contains(token)).toBe(true);
      const row = view.container.querySelector("[data-promptbox-action-row]")!;
      expect(declaration(row, "grid-template-columns")).toBe(
        "2.75rem minmax(0, 1fr)",
      );
      expect(declaration(row, "padding")).toBe("0.75rem 0.25rem 0.25rem");
      const trailing = row.querySelector("[data-promptbox-trailing-actions]")!;
      expect(declaration(trailing, "position")).toBe("absolute");
      expect(declaration(trailing, "right")).toBe("0.5rem");
      expect(declaration(trailing, "bottom")).toBe("calc(100% - 0.5rem)");
      const plus = row.querySelector("[data-promptbox-plus-control]")!;
      const controls = row.querySelector("[data-execution-controls-layout]")!;
      expect(declaration(plus, "grid-column")).toBe("1");
      expect(declaration(controls, "grid-column")).toBe("2");
      expect(
        declaration(
          controls.querySelector("[data-native-terminal-toggle]")!,
          "width",
        ),
      ).toBe("10.5rem");
      expect(declaration(plus, "grid-row")).toBe("1");
      expect(declaration(controls, "grid-row")).toBe("1");
    };
    checkLayout();
    await act(registerComposerPlugin);
    await waitFor(() =>
      expect(view.container.querySelector("textarea")).toBeNull(),
    );
    checkLayout();
    const editor =
      view.container.querySelector<TiptapEditorHTMLElement>(".ProseMirror")!;
    expect(editor.textContent).toBe(draft);
    expect(document.activeElement).toBe(editor);
    expect(editor.editor!.state.selection.head).toBe(draft.length + 1);
  },
);
afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
});

it("hands a live home draft to the actual plugin with its selection and working editor handle", async () => {
  const handle = { current: null as PromptBoxHandle | null };
  const latest = { text: "" };
  const sent = vi.fn();
  const focus = { update: (_enabled: boolean) => {} };
  function Host() {
    const [value, setValue] = useState("");
    const [autoFocus, setAutoFocus] = useState(true);
    focus.update = setAutoFocus;
    const current = useRef(value);
    current.current = value;
    return (
      <ComposerBox
        surface="new-thread"
        autoFocus={autoFocus}
        value={value}
        mentionRanges={[]}
        onChange={(text) => {
          latest.text = text;
          setValue(text);
        }}
        onSubmit={() => {
          sent(latest.text);
          setValue("");
        }}
        promptBoxRef={handle}
        placeholder="Ask anything."
        mentionMenuPlacement="bottom"
        typeahead={testTypeaheadConfig()}
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Provider>
        <MemoryRouter>
          <TooltipProvider>
            <Host />
          </TooltipProvider>
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  );
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Ask anything.",
  });
  fireEvent.change(input, { target: { value: "first message" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sent).toHaveBeenCalledExactlyOnceWith("first message");
  fireEvent.change(input, { target: { value: "hello @world /plan" } });
  input.focus();
  input.setSelectionRange(3, 9, "backward");
  fireEvent.compositionStart(input);
  await act(registerComposerPlugin);
  await waitFor(() =>
    expect(view.container.querySelector(".ProseMirror")).not.toBeNull(),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(view.container.querySelector("textarea")).toBe(input);
  fireEvent.compositionEnd(input);
  fireEvent.change(input, { target: { value: "hello @world /plan!" } });
  input.setSelectionRange(3, 9, "backward");
  await waitFor(() =>
    expect(view.container.querySelector("textarea")).toBeNull(),
  );
  const element =
    view.container.querySelector<TiptapEditorHTMLElement>(".ProseMirror")!;
  const editor = element.editor!;
  expect(editor.getText()).toBe("hello @world /plan!");
  expect(editor.state.selection.anchor).toBe(10);
  expect(editor.state.selection.head).toBe(4);
  expect(document.activeElement).toBe(element);
  expect(handle.current?.voice).toBeTruthy();
  act(() => handle.current?.focusEnd());
  expect(editor.state.selection.empty).toBe(true);
  expect(editor.state.selection.head).toBe("hello @world /plan!".length + 1);
  act(() => focus.update(false));
  expect(document.activeElement).not.toBe(element);
  act(() => focus.update(true));
  await waitFor(() => expect(document.activeElement).toBe(element));
  await act(registerComposerPlugin);
  await waitFor(() =>
    expect(view.container.querySelector(".ProseMirror")).not.toBe(element),
  );
  const reloaded =
    view.container.querySelector<TiptapEditorHTMLElement>(
      ".ProseMirror",
    )!.editor!;
  act(() => {
    reloaded.commands.setContent("@after-reload");
    reloaded.commands.focus("end");
  });
  await waitFor(() =>
    expect(composerSearchQueries.mention).toHaveBeenCalledWith(
      "after-reload",
      "@",
    ),
  );
  client.clear();
});

it.each([false, true])(
  "mounts the real picker with the plain input and keeps its first search through the swap (loading=%s)",
  async (loading) => {
    let mounts = 0;
    const commits: boolean[] = [];
    const options = { resolve: () => {} };
    const observer = new MutationObserver(() => {
      if (
        document.querySelector("[data-progressive-composer-plain] textarea")
      ) {
        commits.push(
          document.querySelector("[data-model-reasoning-trigger]") !== null,
        );
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    function Controls() {
      const [ready, setReady] = useState(!loading);
      options.resolve = () => setReady(true);
      useLayoutEffect(() => {
        mounts++;
      }, []);
      return (
        <ExecutionControls
          pending={!ready}
          provider={{
            selectedId: ready ? "codex" : "",
            options: ready ? [{ value: "codex", label: "Codex" }] : [],
          }}
          model={{
            selected: ready ? "gpt-5.5" : "",
            options: ready
              ? [
                  { value: "gpt-5.5", label: "GPT-5.5" },
                  { value: "o4-mini", label: "o4-mini" },
                  { value: "gpt-5.2", label: "GPT-5.2" },
                  { value: "gpt-4.1", label: "GPT-4.1" },
                  { value: "o3", label: "o3" },
                  { value: "sonnet", label: "Sonnet" },
                ]
              : [],
            moreOptions: [],
            isLoading: !ready,
            loadFailed: false,
            onChange: () => {},
          }}
          reasoning={{
            value: "medium",
            options: [{ value: "medium", label: "Medium" }],
            onChange: () => {},
          }}
        />
      );
    }
    function Host() {
      const [value, setValue] = useState("draft");
      return (
        <ComposerBox
          surface="new-thread"
          value={value}
          mentionRanges={[]}
          onChange={setValue}
          onSubmit={() => {}}
          placeholder="Ask anything."
          mentionMenuPlacement="bottom"
          typeahead={testTypeaheadConfig()}
          executionControls={<Controls />}
        />
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Provider>
          <MemoryRouter>
            <TooltipProvider>
              <Host />
            </TooltipProvider>
          </MemoryRouter>
        </Provider>
      </QueryClientProvider>,
    );
    const input = await screen.findByRole("textbox", { name: "Ask anything." });
    observer.disconnect();
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every(Boolean)).toBe(true);
    expect(input.closest("[data-progressive-composer-plain]")).not.toBeNull();
    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    expect(view.container.querySelector("[contenteditable=true]")).toBeNull();
    fireEvent.click(trigger);
    if (loading) {
      await screen.findByText("Loading models");
      act(options.resolve);
    }
    const search =
      await screen.findByPlaceholderText<HTMLInputElement>("Search models");
    search.focus();
    fireEvent.change(search, { target: { value: "o4-mini" } });
    await act(registerComposerPlugin);
    await waitFor(() =>
      expect(view.container.querySelector("textarea")).toBeNull(),
    );
    expect(screen.getByPlaceholderText("Search models")).toBe(search);
    expect(search.value).toBe("o4-mini");
    expect(document.activeElement).toBe(search);
    expect(mounts).toBe(1);
    client.clear();
  },
);

it("inserts voice at the plain caret and carries a pasted attachment into the rich host", async () => {
  const handle = { current: null as PromptBoxHandle | null };
  let finish: ((items: PromptDraftAttachment[]) => void) | undefined;
  const attach = vi.fn(
    () =>
      new Promise<PromptDraftAttachment[]>((resolve) => {
        finish = resolve;
      }),
  );
  function Host() {
    const [value, setValue] = useState("left right");
    const [items, setItems] = useState<PromptDraftAttachment[]>([]);
    return (
      <ComposerBox
        surface="new-thread"
        value={value}
        mentionRanges={[]}
        onChange={setValue}
        onSubmit={() => {}}
        promptBoxRef={handle}
        placeholder="Ask anything."
        mentionMenuPlacement="bottom"
        typeahead={testTypeaheadConfig()}
        attachments={{ items, onAttachFiles: attach, onUpdate: setItems }}
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Provider>
        <MemoryRouter>
          <TooltipProvider>
            <Host />
          </TooltipProvider>
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  );
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Ask anything.",
  });
  input.focus();
  input.setSelectionRange(5, 5);
  act(() => handle.current?.voice?.deliverTranscript("voice", "insert"));
  expect(input.value).toBe("left voice right");
  expect(input.selectionStart).toBe(11);
  const file = new File(["pasted file"], "paste.txt", { type: "text/plain" });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  expect(attach).toHaveBeenCalledExactlyOnceWith([file]);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Submit (Enter)" })
      .disabled,
  ).toBe(true);
  await act(registerComposerPlugin);
  await waitFor(() =>
    expect(view.container.querySelector(".ProseMirror")).not.toBeNull(),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(view.container.querySelector("textarea")).toBe(input);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Submit (Enter)" })
      .disabled,
  ).toBe(true);
  await act(async () =>
    finish?.([
      { type: "localFile", path: "uploads/paste.txt", name: "paste.txt" },
    ]),
  );
  await waitFor(() =>
    expect(view.container.querySelector("textarea")).toBeNull(),
  );
  const editor =
    view.container.querySelector<TiptapEditorHTMLElement>(
      ".ProseMirror",
    )!.editor!;
  expect(screen.getByRole("button", { name: "Remove paste.txt" })).toBeTruthy();
  expect(editor.getText()).toBe("left voice right");
  expect(editor.state.selection.head).toBe(12);
  fireEvent.click(screen.getByRole("button", { name: "Remove paste.txt" }));
  expect(screen.queryByRole("button", { name: "Remove paste.txt" })).toBeNull();
  client.clear();
});

it("normalizes and sends a voice result while transcription is finishing before rich startup", async () => {
  const handle = { current: null as PromptBoxHandle | null };
  const latest = { text: "before " };
  const sent = vi.fn();
  const voice: PromptVoiceConfig = {
    state: "transcribing",
    delivery: "send",
    isSupported: true,
    microphoneWarning: null,
    stream: null,
    failedRecordings: [],
    start() {},
    stop() {},
    send() {},
    cancel() {},
    retry() {},
    discard() {},
    download() {},
  };
  function Host() {
    const [value, setValue] = useState(latest.text);
    return (
      <ComposerBox
        surface="new-thread"
        value={value}
        mentionRanges={[]}
        onChange={(text) => {
          latest.text = text;
          setValue(text);
        }}
        onSubmit={() => {
          sent(latest.text);
          setValue("");
        }}
        promptBoxRef={handle}
        voice={voice}
        placeholder="Ask anything."
        mentionMenuPlacement="bottom"
        typeahead={testTypeaheadConfig()}
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Provider>
        <MemoryRouter>
          <TooltipProvider>
            <Host />
          </TooltipProvider>
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  );
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Ask anything.",
  });
  input.setSelectionRange(7, 7);
  expect(handle.current?.voice?.textBeforeCursor()).toBe("before");
  act(() =>
    handle.current?.voice?.deliverTranscript("  voice\n  result  ", "send"),
  );
  expect(sent).toHaveBeenCalledExactlyOnceWith("before voice result");
  expect(input.value).toBe("");
  client.clear();
});

it.each(["plain", "rich"] as const)(
  "sends exactly once when options resolve after Enter in the %s editor",
  async (phase) => {
    const sent = vi.fn();
    const options = { resolve: () => {} };
    function Host() {
      const [value, setValue] = useState("early words more");
      const [ready, setReady] = useState(false);
      options.resolve = () => setReady(true);
      const submit = () => {
        sent(value);
        setValue("");
      };
      return (
        <PendingComposerSubmission
          text={value}
          loading={!ready}
          disabled={!ready}
          failed={false}
          isSubmitting={false}
          pendingUploads={false}
          disabledReason={ready ? undefined : "Loading model and options."}
          onSubmit={submit}
        >
          {(onBlockedSubmit) => (
            <ComposerBox
              surface="new-thread"
              value={value}
              mentionRanges={[]}
              onChange={setValue}
              onSubmit={submit}
              submission={{
                disabled: !ready,
                experimental_onBlockedSubmit: onBlockedSubmit,
              }}
              placeholder="Ask anything."
              mentionMenuPlacement="bottom"
              typeahead={testTypeaheadConfig()}
            />
          )}
        </PendingComposerSubmission>
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Provider>
          <MemoryRouter>
            <TooltipProvider>
              <Host />
            </TooltipProvider>
          </MemoryRouter>
        </Provider>
      </QueryClientProvider>,
    );
    const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything.",
    });
    input.focus();
    if (phase === "rich") {
      await act(registerComposerPlugin);
      await waitFor(() =>
        expect(view.container.querySelector("textarea")).toBeNull(),
      );
    }
    const target =
      phase === "plain"
        ? input
        : view.container.querySelector<HTMLElement>(".ProseMirror")!;
    fireEvent.keyDown(target, { key: "Enter" });
    fireEvent.keyDown(target, { key: "Enter", repeat: true });
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(
      "Your message will send when ready",
    );
    if (phase === "plain") {
      expect(input.value).toBe("early words more");
      await act(registerComposerPlugin);
      await waitFor(() =>
        expect(view.container.querySelector("textarea")).toBeNull(),
      );
    }
    expect(view.container.querySelector(".ProseMirror")?.textContent).toBe(
      "early words more",
    );
    expect(sent).not.toHaveBeenCalled();
    act(options.resolve);
    await waitFor(() =>
      expect(sent).toHaveBeenCalledExactlyOnceWith("early words more"),
    );
    expect(screen.queryByRole("status")).toBeNull();
    const editor = view.container.querySelector<HTMLElement>(".ProseMirror")!;
    await waitFor(() => expect(editor.textContent).toBe(""));
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(sent).toHaveBeenCalledTimes(1);
    client.clear();
  },
);
