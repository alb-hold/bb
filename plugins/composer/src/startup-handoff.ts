import type { ExperimentalComposerInput } from "@get-bb/plugin-sdk/app";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import {
  promptEditorContentFromValue,
  promptEditorSerializationFromDoc,
} from "./editor/prompt-editor-serialization";

type Snapshot = Parameters<
  Parameters<
    NonNullable<
      ExperimentalComposerInput["experimental_startupHandoff"]
    >["attach"]
  >[0]
>[0];

export function applyStartupHandoff(editor: Editor, snapshot: Snapshot) {
  editor.commands.setContent(promptEditorContentFromValue(snapshot.draft));
  const serialized = promptEditorSerializationFromDoc(editor.state.doc);
  const position = (offset: number): number => {
    const bounded = Math.max(0, Math.min(offset, serialized.text.length));
    for (const segment of serialized.offsetMapping) {
      if (bounded < segment.textFrom)
        return Math.max(1, segment.docFrom - (segment.textFrom - bounded));
      if (bounded <= segment.textTo) {
        if (segment.kind === "mention")
          return bounded - segment.textFrom <
            (segment.textTo - segment.textFrom) / 2
            ? segment.docFrom
            : segment.docTo;
        return Math.min(
          segment.docTo,
          segment.docFrom + bounded - segment.textFrom,
        );
      }
    }
    return TextSelection.atEnd(editor.state.doc).from;
  };
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(
        editor.state.doc,
        position(snapshot.anchor),
        position(snapshot.head),
      ),
    ),
  );
  if (snapshot.focused) editor.view.focus();
  return { text: snapshot.draft.text, mentions: snapshot.draft.mentions };
}
