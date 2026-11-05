// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import { promptEditorExtensions } from "./prompt-editor-extensions";

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  vi.restoreAllMocks();
});

it("keeps placeholder changes off the viewport measurement path", () => {
  const measure = vi.spyOn(Element.prototype, "getBoundingClientRect");
  editor = new Editor({
    extensions: promptEditorExtensions({
      getPlaceholder: () => "Write a prompt",
    }),
    content: "<p></p>",
  });
  const paragraph = editor.view.dom.querySelector("p");
  expect(paragraph?.getAttribute("data-placeholder")).toBe("Write a prompt");
  expect(paragraph?.classList.contains("is-editor-empty")).toBe(true);
  editor.commands.insertContent("a");
  expect(editor.getText()).toBe("a");
  expect(paragraph?.hasAttribute("data-placeholder")).toBe(false);
  editor.commands.selectAll();
  editor.commands.deleteSelection();
  expect(paragraph?.getAttribute("data-placeholder")).toBe("Write a prompt");
  expect(measure).not.toHaveBeenCalled();
  editor.setEditable(false);
  expect(paragraph?.hasAttribute("data-placeholder")).toBe(false);
});

it("decorates the current empty paragraph after multiline input", () => {
  editor = new Editor({
    extensions: promptEditorExtensions({ getPlaceholder: () => "Continue" }),
    content: "<p>First line</p><p></p>",
  });
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  const paragraphs = editor.view.dom.querySelectorAll("p");
  expect(paragraphs[0]?.hasAttribute("data-placeholder")).toBe(false);
  expect(paragraphs[1]?.getAttribute("data-placeholder")).toBe("Continue");
  expect(paragraphs[1]?.classList.contains("is-editor-empty")).toBe(false);
});
