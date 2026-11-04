// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerSendMenu } from "./ComposerSendMenu";

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(),
  experimental_useComposerContributions: () => ({
    sendMenuItems: [],
    MenuEntry: () => null,
  }),
}));

afterEach(cleanup);

it("keeps send and its options in a rounded capsule for empty and filled drafts", () => {
  for (const hasInput of [false, true]) {
    const view = render(
      <ComposerSendMenu
        isPointerCoarse={false}
        modifierKind={null}
        hasInput={hasInput}
        canSubmit={hasInput}
        onSubmit={() => {}}
      >
        <button data-promptbox-submit-action="">Send</button>
      </ComposerSendMenu>,
    );
    expect(
      view.container.querySelector("[data-promptbox-send-menu]")?.className,
    ).toContain("rounded-full");
    view.unmount();
  }
});
