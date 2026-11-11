// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadLeadingMark } from "./thread-mode-glyph";
import { Icon } from "./icon";

describe("ThreadLeadingMark", () => {
  it("renders a native-terminal mode badge large enough to read", () => {
    const { container } = render(
      <ThreadLeadingMark
        nativeTerminal
        isWorktree={false}
        providerName="Codex"
      >
        <Icon name="Sparkles" className="size-4" aria-hidden />
      </ThreadLeadingMark>,
    );
  const badge = container.querySelector(
      '[data-thread-mode-badge="native-terminal"]',
    );
    expect(badge).not.toBeNull();
    expect(badge?.className).toContain("size-2.5");
  });
});
