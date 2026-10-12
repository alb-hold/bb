// @vitest-environment jsdom

import type { PendingInteraction } from "@bb/domain";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeTerminalWaitingBanner,
  nativeTerminalWaitingPrompts,
} from "./NativeTerminalWaitingBanner";

afterEach(cleanup);

function question(
  id: string,
  status: PendingInteraction["status"],
  prompt: string,
): PendingInteraction {
  return {
    id,
    threadId: "thr_n",
    turnId: "native-terminal-turn",
    status,
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
    resolution: null,
    providerId: "claude-code",
    providerThreadId: "session",
    providerRequestId: `native:${id}`,
    payload: {
      kind: "user_question",
      questions: [
        {
          id: `native:${id}`,
          prompt,
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
  };
}

describe("native terminal waiting banner", () => {
  it("lists only the questions still pending", () => {
    expect(
      nativeTerminalWaitingPrompts([
        question("a", "pending", "Merge now?"),
        question("b", "interrupted", "Old question?"),
        question("c", "pending", "Which branch?"),
      ]),
    ).toEqual(["Merge now?", "Which branch?"]);
  });

  it("tells the user to answer in the terminal and shows the question", () => {
    render(
      <NativeTerminalWaitingBanner
        prompts={["Merge now?"]}
        providerLabel="Claude Code"
      />,
    );
    expect(
      screen.getByText("Claude Code is waiting for your answer in the terminal"),
    ).toBeTruthy();
    expect(screen.getByText("Merge now?")).toBeTruthy();
  });

  it("renders nothing when no question is pending", () => {
    const { container } = render(
      <NativeTerminalWaitingBanner prompts={[]} providerLabel="Codex" />,
    );
    expect(container.firstChild).toBeNull();
  });
});
