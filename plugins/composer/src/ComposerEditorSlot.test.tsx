// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ComposerEditorSlot } from "./ComposerEditorSlot";

afterEach(cleanup);

it("preserves the text token's contrast on the empty composer", () => {
  const { container } = render(
    <ComposerEditorSlot
      editor={null}
      scrollContainerRef={{ current: null }}
      inputLocked={false}
      isCompactLayout={false}
      minHeight={48}
      layout="thread"
      resolveMentionLink={undefined}
      userHeightPx={null}
    />,
  );
  const editor = container.querySelector("[data-promptbox-editor-content]");
  expect(editor?.className).toContain("::before]:text-subtle-foreground");
  expect(editor?.className).not.toContain("::before]:opacity-");
});
