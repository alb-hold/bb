import { describe, expect, it } from "vitest";
import {
  pickActiveTerminalId,
  resolveTerminalPanelMount,
  selectActiveTerminalSession,
  shouldAutoCloseCleanTerminalSession,
  shouldAutoCloseCleanTerminalSessionsForPanel,
} from "./useThreadTerminalController";
import {
  shouldCloseUnretainedDisconnectedTerminalSession,
  shouldShowRetainedTerminalSession,
} from "@/lib/terminal-session-visibility";
import {
  makeTerminalSession,
  makeTerminalSession as terminalSession,
} from "@/test/fixtures/terminal-sessions";

describe("pickActiveTerminalId", () => {
  it("does not replace an exact plugin tab with a sibling session", () => {
    const sibling = terminalSession({ id: "term_sibling" });

    expect(
      pickActiveTerminalId([sibling], "term_missing", "term_missing"),
    ).toBeNull();
    expect(
      pickActiveTerminalId([sibling], "term_sibling", "term_sibling"),
    ).toBe("term_sibling");
  });
  it("shows disconnected sessions only while retaining a mounted terminal view", () => {
    const disconnected = terminalSession({
      id: "term_disconnected",
      status: "disconnected",
    });

    expect(
      shouldShowRetainedTerminalSession({
        retainedTerminalIds: new Set<string>(),
        session: disconnected,
      }),
    ).toBe(false);
    expect(
      shouldShowRetainedTerminalSession({
        retainedTerminalIds: new Set(["term_disconnected"]),
        session: disconnected,
      }),
    ).toBe(true);
    expect(
      shouldShowRetainedTerminalSession({
        retainedTerminalIds: new Set<string>(),
        session: terminalSession({ status: "running" }),
      }),
    ).toBe(true);
  });

  it("keeps server-listed exited terminals visible after a remount", () => {
    const exited = terminalSession({ id: "term_exited", status: "exited" });

    expect(
      shouldShowRetainedTerminalSession({
        retainedTerminalIds: new Set<string>(),
        session: exited,
      }),
    ).toBe(true);
    expect(
      shouldShowRetainedTerminalSession({
        retainedTerminalIds: new Set(["term_exited"]),
        session: exited,
      }),
    ).toBe(true);
  });

  it("cleans up a disconnected session only when no pane still mounts it", () => {
    const disconnected = terminalSession({
      id: "term_disconnected",
      status: "disconnected",
    });

    expect(
      shouldCloseUnretainedDisconnectedTerminalSession({
        retainedTerminalIds: new Set<string>(),
        session: disconnected,
      }),
    ).toBe(true);
    expect(
      shouldCloseUnretainedDisconnectedTerminalSession({
        retainedTerminalIds: new Set(["term_other_pane", "term_disconnected"]),
        session: disconnected,
      }),
    ).toBe(false);
    expect(
      shouldCloseUnretainedDisconnectedTerminalSession({
        retainedTerminalIds: new Set<string>(),
        session: terminalSession({ status: "running" }),
      }),
    ).toBe(false);
  });

  it("auto-closes only clean UI-created terminal sessions", () => {
    const cleanUiCreated = terminalSession({ id: "term_ui" });
    const external = terminalSession({ id: "term_external" });
    const dirty = terminalSession({ id: "term_dirty" });
    const userInput = terminalSession({
      id: "term_user_input",
      lastUserInputAt: 2,
    });

    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(["term_dirty"]),
        session: cleanUiCreated,
        uiCreatedTerminalIds: new Set(["term_ui", "term_dirty"]),
      }),
    ).toBe(true);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(),
        session: external,
        uiCreatedTerminalIds: new Set(["term_ui"]),
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(["term_dirty"]),
        session: dirty,
        uiCreatedTerminalIds: new Set(["term_dirty"]),
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(),
        session: userInput,
        uiCreatedTerminalIds: new Set(["term_user_input"]),
      }),
    ).toBe(false);
  });

  it("preserves clean terminals while a compact panel remains persisted", () => {
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: false,
        isPanelPersistedOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: true,
        isPanelPersistedOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: false,
        isPanelPersistedOpen: false,
      }),
    ).toBe(true);
  });
});

type PanelStep = { isPanelOpen: boolean; isPanelPersistedOpen: boolean };

function runPanelSteps(initiallyOpen: boolean, steps: readonly PanelStep[]) {
  let hasPanelOpened = initiallyOpen;
  return steps.map((step) => {
    const mount = resolveTerminalPanelMount({ hasPanelOpened, ...step });
    hasPanelOpened = mount.hasPanelOpened;
    return mount.shouldMountTerminalView;
  });
}

describe("resolveTerminalPanelMount", () => {
  it("does not mount or fetch a persisted-open terminal the panel never showed", () => {
    expect(
      resolveTerminalPanelMount({
        hasPanelOpened: false,
        isPanelOpen: false,
        isPanelPersistedOpen: true,
      }),
    ).toEqual({
      hasPanelOpened: false,
      shouldFetchTerminals: false,
      shouldMountTerminalView: false,
    });
  });

  it("mounts and fetches for an open panel that is not persisted open", () => {
    expect(
      resolveTerminalPanelMount({
        hasPanelOpened: false,
        isPanelOpen: true,
        isPanelPersistedOpen: false,
      }),
    ).toEqual({
      hasPanelOpened: true,
      shouldFetchTerminals: true,
      shouldMountTerminalView: true,
    });
  });

  it("keeps the view mounted across a compact close and unmounts once persisted state closes", () => {
    expect(
      runPanelSteps(true, [
        { isPanelOpen: true, isPanelPersistedOpen: true },
        { isPanelOpen: false, isPanelPersistedOpen: true },
        { isPanelOpen: false, isPanelPersistedOpen: false },
        { isPanelOpen: false, isPanelPersistedOpen: true },
        { isPanelOpen: true, isPanelPersistedOpen: true },
      ]),
    ).toEqual([true, true, false, false, true]);
  });
});

describe("selectActiveTerminalSession", () => {
  const own = makeTerminalSession({ id: "term_1", threadId: "thr_1" });
  const sibling = makeTerminalSession({
    id: "term_sibling",
    threadId: "thr_1",
  });
  const target = { kind: "thread", threadId: "thr_1" } as const;

  it("selects the panel's own terminal", () => {
    expect(
      selectActiveTerminalSession({
        sessions: [sibling, own],
        target,
        terminalId: "term_1",
      }),
    ).toBe(own);
  });

  it("never shows a sibling terminal in place of its own missing terminal", () => {
    expect(
      selectActiveTerminalSession({
        sessions: [sibling],
        target,
        terminalId: "term_1",
      }),
    ).toBeNull();
  });
});
