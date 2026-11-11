// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadIdentityLeadingMark } from "./ThreadIdentityLeadingMark";

describe("ThreadIdentityLeadingMark", () => {
  it("renders the shared thread leading mark with native-terminal badge", () => {
    const { container } = render(
      <ThreadIdentityLeadingMark
        providerId="codex"
        provider={{ displayName: "Codex", id: "codex" } as never}
        nativeTerminal
        isWorktree={false}
      />,
    );
    expect(
      container.querySelector('[data-thread-mode-badge="native-terminal"]'),
    ).not.toBeNull();
  });
});
