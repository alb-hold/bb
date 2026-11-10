// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DiffFileCard, type DiffFileCardProps } from "./DiffFileCard.js";
import { makeDiffFileEntry } from "./diff-file-fixtures.js";

const state = vi.hoisted(() => ({ imports: vi.fn(), load: vi.fn() }));
vi.mock("@bb/shared-ui/git-diff/parsing", async (importOriginal) => {
  state.imports();
  return importOriginal<typeof import("@bb/shared-ui/git-diff/parsing")>();
});
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  internal_DO_NOT_USE_loadGitDiffParser: () => {
    state.load();
    return import("@bb/shared-ui/git-diff/parsing");
  },
}));
vi.mock("usehooks-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("usehooks-ts")>()),
  useIntersectionObserver: () => ({
    ref: () => {},
    isIntersecting: true,
    entry: undefined,
  }),
}));
afterEach(cleanup);

it("imports the shared parser only when a loaded file is expanded, then renders the same patch", async () => {
  const patch =
    "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const props: DiffFileCardProps = {
    entry: makeDiffFileEntry({ path: "file.ts", additions: 1, deletions: 1 }),
    presentation: {
      view: "unified",
      overflow: "scroll",
      showLineNumbers: true,
    },
    ignoreWhitespace: false,
    isViewed: false,
    isViewedDisabled: false,
    onViewedChange: () => {},
    isCollapsed: true,
    onToggleCollapsed: () => {},
    patchState: { status: "loaded", patch },
    onLoadPatch: () => {},
    onRetry: () => {},
  };
  const view = renderSlot({ component: DiffFileCard }, props);
  expect(state.imports).not.toHaveBeenCalled();
  expect(state.load).not.toHaveBeenCalled();
  view.rerender(<DiffFileCard {...props} isCollapsed={false} />);
  expect((await screen.findByTestId("bb-diff")).textContent).toBe(patch);
  expect(state.load).toHaveBeenCalledOnce();
  expect(state.imports).toHaveBeenCalledOnce();
});
