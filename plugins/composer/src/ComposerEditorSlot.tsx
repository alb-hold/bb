import {
  memo,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";
import {
  PromptMentionLinkContext,
  type PromptMentionLinkResolver,
} from "./editor/prompt-mention-link";
import {
  COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE,
  getComposerEditorMaxHeightCss,
  resolveComposerEditorMinHeightCss,
  type ComposerEditorLayout,
} from "./composerHeightAtoms";

export type { ComposerEditorLayout } from "./composerHeightAtoms";
export const COMPOSER_EDITOR_AVAILABLE_HEIGHT_PROPERTY =
  "--composer-editor-available-height";


export function blurPromptEditor(editor: Editor | null | undefined): void {
  editor?.view.dom.blur();
  window.getSelection()?.removeAllRanges();
}

export const ComposerEditorSlot = memo(function ComposerEditorSlot({
  editor,
  empty,
  scrollContainerRef,
  inputLocked,
  isCompactLayout,
  minHeight,
  layout,
  resolveMentionLink,
  userHeightPx,
}: {
  editor: Editor | null;
  empty: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  inputLocked: boolean;
  isCompactLayout: boolean;
  minHeight: number;
  layout: ComposerEditorLayout;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
  userHeightPx: number | null;
}) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || editor === null || editor.isEditable)
        return;
      event.preventDefault();
      blurPromptEditor(editor);
    },
    [editor],
  );
  const style = useMemo(
    () => ({
      minHeight: isCompactLayout
        ? "48px"
        : `var(${COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE}, ${resolveComposerEditorMinHeightCss({ floorPx: minHeight, userHeightPx, layout })})`,
      height: isCompactLayout ? "48px" : undefined,
      maxHeight: isCompactLayout
        ? "48px"
        : `min(${getComposerEditorMaxHeightCss(layout)}, var(${COMPOSER_EDITOR_AVAILABLE_HEIGHT_PROPERTY}, 100dvh))`,
    }),
    [isCompactLayout, minHeight, userHeightPx, layout],
  );
  return (
    <div
      ref={scrollContainerRef}
      data-promptbox-editor-scroll=""
      data-compact-empty-editor={
        userHeightPx === null && empty ? "" : undefined
      }
      aria-busy={inputLocked || undefined}
      className={cn(
        "w-full overflow-y-auto bg-transparent px-4 pb-1 pr-14 pt-3 outline-none",
        COARSE_POINTER_TEXT_BASE_CLASS,
        "leading-relaxed",
        isCompactLayout && "h-12 overflow-hidden pb-0 pr-2 pt-0",
      )}
      style={style}
    >
      <PromptMentionLinkContext.Provider value={resolveMentionLink ?? null}>
        <EditorContent
          editor={editor}
          onKeyDown={handleKeyDown}
          data-promptbox-editor-content=""
          data-promptbox-compact-content={isCompactLayout ? "" : undefined}
          className={cn(
            "h-full min-h-full",
            isCompactLayout && "flex items-center",
            "[&_.ProseMirror]:min-h-full [&_.ProseMirror]:leading-[1.7] [&_.ProseMirror]:outline-none",
            "[&_.ProseMirror_p]:m-0",
            "[&_.ProseMirror_blockquote]:my-1 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-surface-selected-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-muted-foreground",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-subtle-foreground",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:font-light",
          )}
        />
      </PromptMentionLinkContext.Provider>
    </div>
  );
});
