import { Placeholder } from "@tiptap/extensions/placeholder";
import Blockquote from "@tiptap/extension-blockquote";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { TrailingNode } from "@tiptap/extensions/trailing-node";
import type { AnyExtension } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import {
  PromptDecorationExtension,
  type PromptDecorationExtensionOptions,
} from "./prompt-decoration-extension";
import { PromptMentionExtension } from "./prompt-mention-extension";

const CurrentNodePlaceholder = Placeholder.extend({
  addProseMirrorPlugins() {
    return (this.parent?.() ?? []).map(
      (plugin) => new Plugin({ props: plugin.props }),
    );
  },
});

interface PromptEditorExtensionsOptions extends PromptDecorationExtensionOptions {
  getPlaceholder: () => string;
}

export function promptEditorExtensions({
  getPlaceholder,
  getDecorationSources,
  onRuleError,
}: PromptEditorExtensionsOptions): AnyExtension[] {
  return [
    Blockquote,
    Document,
    HardBreak,
    UndoRedo,
    Paragraph,
    Text,
    TrailingNode,
    CurrentNodePlaceholder.configure({
      showOnlyCurrent: true,
      includeChildren: false,
      placeholder: () => getPlaceholder(),
    }),
    PromptMentionExtension,
    PromptDecorationExtension.configure({
      ...(getDecorationSources !== undefined ? { getDecorationSources } : {}),
      ...(onRuleError !== undefined ? { onRuleError } : {}),
    }),
  ];
}
