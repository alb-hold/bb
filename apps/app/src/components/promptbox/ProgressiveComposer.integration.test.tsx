// @vitest-environment jsdom

import { createPortal } from "react-dom";

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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PromptDraftAttachment } from "@bb/client-core";
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import {
  ComposerBox,
  type PromptBoxHandle,
  type PromptVoiceConfig,
} from "./ComposerBox";
import { PendingComposerSubmission } from "./PendingComposerSubmission";
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

it("keeps the first opened control and its typed search alive across the swap", async () => {
  let mounts = 0;
  function Controls() {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    useLayoutEffect(() => {
      mounts++;
    }, []);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Pick model
        </button>
        {open &&
          createPortal(
            <input
              aria-label="Find model"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />,
            document.body,
          )}
      </>
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
  fireEvent.click(screen.getByRole("button", { name: "Pick model" }));
  const search = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Find model",
  });
  search.focus();
  fireEvent.change(search, { target: { value: "typed before rich" } });
  await act(registerComposerPlugin);
  await waitFor(() =>
    expect(view.container.querySelector("textarea")).toBeNull(),
  );
  expect(screen.getByRole("textbox", { name: "Find model" })).toBe(search);
  expect(search.value).toBe("typed before rich");
  expect(document.activeElement).toBe(search);
  expect(mounts).toBe(1);
  client.clear();
});

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
