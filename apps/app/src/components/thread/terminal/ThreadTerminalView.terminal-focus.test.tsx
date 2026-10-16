// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { ThreadTerminalView } from "./ThreadTerminalView";

afterEach(() => {
  cleanup();
});

describe("ThreadTerminalView terminal focus boundary", () => {
  it("marks the pane when rendered without ThreadTerminalPanel", () => {
    const { container } = render(
      <ThreadTerminalView
        autoFocus={false}
        isPanelOpen
        session={makeTerminalSession({
          id: "term_focus",
          threadId: "thr_focus",
          environmentId: "env_focus",
          hostId: "host_focus",
          createdAt: 1,
          updatedAt: 1,
          status: "running",
        })}
      />,
    );

    expect(container.firstElementChild).toHaveAttribute("data-app-terminal", "");
  });
});
