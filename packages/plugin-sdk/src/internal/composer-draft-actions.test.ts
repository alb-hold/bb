// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createComposerDraftActions } from "./composer-draft-actions.js";

it("warms draft validation once at idle without changing a draft and preserves rejection", () => {
  const idle = vi.fn();
  vi.stubGlobal("requestIdleCallback", idle);
  const setDraft = vi.fn();
  const target = () => ({
    getDraft: () => ({ text: "kept", mentions: [], attachments: [] }),
    setDraft,
    isAvailable: () => true,
    focus: vi.fn(),
  });
  try {
    const actions = createComposerDraftActions(target);
    createComposerDraftActions(target);
    expect(idle).toHaveBeenCalledOnce();
    idle.mock.calls[0]![0]();
    expect(setDraft).not.toHaveBeenCalled();
    expect(actions.draft.text).toBe("kept");
    expect(() =>
      actions.replace({
        text: "x",
        mentions: [
          { kind: "thread", threadId: "t", label: "t", from: 0, to: 2 },
        ],
      }),
    ).toThrow("Invalid composer draft");
    actions.replace({ text: "valid", mentions: [] });
    expect(setDraft).toHaveBeenCalledWith({ text: "valid", mentions: [] });
  } finally {
    vi.unstubAllGlobals();
  }
});
