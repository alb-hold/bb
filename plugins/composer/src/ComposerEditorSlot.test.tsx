// @vitest-environment jsdom
import { readFileSync } from "node:fs";
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

it.each([null, 180])("only compacts the empty home editor without a resized height (%s)", (userHeightPx) => {
  const { container } = render(<ComposerEditorSlot editor={null} scrollContainerRef={{ current: null }} inputLocked={false} isCompactLayout={false} minHeight={68} layout="root-compose" resolveMentionLink={undefined} userHeightPx={userHeightPx} />);
  expect(container.querySelector("[data-promptbox-editor-scroll]")?.hasAttribute("data-compact-empty-editor")).toBe(userHeightPx === null);
});

it("retains desktop height while reducing the empty phone editor floor", () => {
  const css = readFileSync("src/composer.css", "utf8");
  expect(css).toMatch(/@media \(width < 48rem\)\s*{\s*\[data-compact-empty-editor\]\s*{\s*min-height: 44px !important/);
});
