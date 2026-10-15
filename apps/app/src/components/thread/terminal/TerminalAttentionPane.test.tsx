// @vitest-environment jsdom

import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { handleTerminalServerMessage } from "./ThreadTerminalView";
import { TerminalAttentionPane } from "./TerminalAttentionPane";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";

afterEach(cleanup);

describe("terminal attention pane", () => {
  it("removes the pane ring when the session-updated frame clears attention", () => {
    const initialSession = makeTerminalSession({
      attention: { at: 10, kind: "osc-9", seq: 12 },
    });
    const clearedSession: TerminalSession = {
      ...initialSession,
      attention: null,
    };
    const frame: TerminalServerMessage = {
      type: "session-updated",
      session: clearedSession,
    };

    function OpenTerminalPane() {
      const [session, setSession] = useState(initialSession);
      return (
        <TerminalAttentionPane attention={session.attention}>
          <button
            onClick={() =>
              handleTerminalServerMessage({
                acknowledgeOutput: () => undefined,
                message: frame,
                onReplayComplete: () => undefined,
                onSessionChange: setSession,
                replayNextSeq: null,
                replayWriteState: { suppressedWriteCount: 0 },
                setReplayNextSeq: () => undefined,
                terminal: null as never,
              })
            }
          >
            Receive update
          </button>
        </TerminalAttentionPane>
      );
    }

    const rendered = render(<OpenTerminalPane />);
    expect(rendered.container.querySelector(".ring-attention")).not.toBeNull();

    fireEvent.click(rendered.getByRole("button", { name: "Receive update" }));

    expect(rendered.container.querySelector(".ring-attention")).toBeNull();
  });
});
