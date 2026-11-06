// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { promptEditorExtensions } from "./editor/prompt-editor-extensions";
import { promptEditorSerializationFromDoc } from "./editor/prompt-editor-serialization";
import { applyStartupHandoff } from "./startup-handoff";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

it.each(["hello @world /plan", "first\n\nlast", "日本語"])(
  "restores literal startup text and both selection directions: %s",
  (text) => {
    const element = document.createElement("div");
    document.body.append(element);
    editor = new Editor({
      element,
      extensions: promptEditorExtensions({
        getPlaceholder: () => "Ask anything.",
      }),
    });
    for (const [anchor, head] of [
      [1, text.length],
      [text.length, 1],
    ]) {
      applyStartupHandoff(editor, {
        draft: { text, mentions: [] },
        anchor: anchor!,
        head: head!,
        focused: true,
        scrollTop: 0,
      });
      const serialized = promptEditorSerializationFromDoc(editor.state.doc);
      expect(serialized.text).toBe(text);
      const selection = editor.state.selection;
      expect(selection.anchor > selection.head).toBe(anchor! > head!);
      expect(
        editor.state.doc.textBetween(selection.from, selection.to, "\n", "\n"),
      ).toBe(text.slice(1));
      expect(editor.view.hasFocus()).toBe(true);
    }
  },
);

it("does not steal focus from another control", () => {
  const element = document.createElement("div");
  const other = document.createElement("input");
  document.body.append(element, other);
  editor = new Editor({
    element,
    extensions: promptEditorExtensions({ getPlaceholder: () => "" }),
  });
  other.focus();
  applyStartupHandoff(editor, {
    draft: { text: "draft", mentions: [] },
    anchor: 2,
    head: 2,
    focused: false,
    scrollTop: 0,
  });
  expect(document.activeElement).toBe(other);
  expect(editor.state.selection.anchor).toBe(3);
});
