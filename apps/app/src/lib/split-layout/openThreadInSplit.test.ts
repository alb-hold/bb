import { describe, expect, it, vi } from "vitest";
import { openThreadInSplit } from "./openThreadInSplit";
import { countPanes, findPaneByThread, type SplitLayout } from "./index";

function layout(threadId = "thread-1"): SplitLayout {
  return {
    root: {
      type: "pane",
      paneId: "pane-1",
      content: { kind: "thread", projectId: "project-1", threadId },
    },
    focusedPaneId: "pane-1",
  };
}

function eightPanes(): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: Array.from({ length: 8 }, () => 0.125),
      children: Array.from({ length: 8 }, (_, index) => ({
        type: "pane" as const,
        paneId: `pane-${index + 1}`,
        content: {
          kind: "thread" as const,
          projectId: "project-1",
          threadId: `thread-${index + 1}`,
        },
      })),
    },
    focusedPaneId: "pane-1",
  };
}

describe("openThreadInSplit", () => {
  it("preserves search deep-link state when creating a split", () => {
    let current = layout();
    const navigate = vi.fn();
    openThreadInSplit({
      store: {
        get: () => current,
        set: (_atom, value) => {
          current = value;
        },
      },
      navigate,
      projectId: "project-1",
      threadId: "thread-2",
      isCompact: false,
      state: { searchMessageSeq: 42, searchThreadId: "thread-2" },
    });

    expect(current.root.type).toBe("split");
    expect(navigate).toHaveBeenCalledWith(
      "/projects/project-1/threads/thread-2",
      {
        state: { searchMessageSeq: 42, searchThreadId: "thread-2" },
      },
    );
  });

  it("keeps replace semantics and state when the result is already open", () => {
    const current = layout("thread-2");
    const navigate = vi.fn();
    openThreadInSplit({
      store: { get: () => current, set: vi.fn() },
      navigate,
      projectId: "project-1",
      threadId: "thread-2",
      isCompact: false,
      state: { searchMessageSeq: 7, searchThreadId: "thread-2" },
    });

    expect(navigate).toHaveBeenCalledWith(
      "/projects/project-1/threads/thread-2",
      {
        replace: true,
        state: { searchMessageSeq: 7, searchThreadId: "thread-2" },
      },
    );
  });

  it("refuses at the eight-pane cap instead of replacing the focused pane", () => {
    const current = eightPanes();
    const set = vi.fn();
    const navigate = vi.fn();
    const result = openThreadInSplit({
      store: { get: () => current, set },
      navigate,
      projectId: "project-1",
      threadId: "thread-9",
      isCompact: false,
    });

    expect(result).toBe("at-pane-limit");
    expect(countPanes(current.root)).toBe(8);
    expect(findPaneByThread(current.root, "project-1", "thread-1")).not.toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("plain-navigates without touching the layout on compact viewports", () => {
    const set = vi.fn();
    const navigate = vi.fn();
    openThreadInSplit({
      store: { get: () => layout(), set },
      navigate,
      projectId: "project-1",
      threadId: "thread-9",
      isCompact: true,
    });

    expect(set).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      "/projects/project-1/threads/thread-9",
      undefined,
    );
  });
});
