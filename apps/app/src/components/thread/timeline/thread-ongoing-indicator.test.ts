import { describe, expect, it } from "vitest";
import { resolveThreadOngoingIndicator } from "./thread-ongoing-indicator";

const idle = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeWorkflowCount: 0,
  displayStatus: "idle",
  isStopping: false,
  isTurnSubmitting: false,
  nativeTerminal: false,
  nativeActivityUnconfirmed: false,
  timelineLoading: false,
  threadStatus: "idle",
} as const;

describe("resolveThreadOngoingIndicator", () => {
  it.each([
    {
      name: "a background-only indicator while runtime is idle with a workflow running",
      input: { ...idle, activeWorkflowCount: 1 },
      expected: { show: true, label: "Background work running" },
    },
    {
      name: "the normal working label while runtime is active",
      input: {
        ...idle,
        activeWorkflowCount: 1,
        displayStatus: "active",
        threadStatus: "active",
      },
      expected: { show: true, label: undefined },
    },
    {
      name: "no stale runtime indicator for an idle native thread",
      input: { ...idle, displayStatus: "active", nativeTerminal: true },
      expected: { show: false, label: undefined },
    },
    {
      name: "a background indicator for an idle thread with only a nested agent active",
      input: { ...idle, activeBackgroundAgentCount: 1 },
      expected: { show: true, label: "Background work running" },
    },
    {
      name: "no indicator once the nested agent count returns to zero",
      input: idle,
      expected: { show: false, label: undefined },
    },
    {
      name: "no runtime-only indicator after native activity expires",
      input: {
        ...idle,
        displayStatus: "active",
        nativeActivityUnconfirmed: true,
      },
      expected: { show: false, label: undefined },
    },
    {
      name: "preserve background activity after native activity expires",
      input: {
        ...idle,
        displayStatus: "active",
        activeBackgroundAgentCount: 1,
        nativeActivityUnconfirmed: true,
      },
      expected: { show: true, label: "Background work running" },
    },
  ] as const)("shows $name", ({ input, expected }) => {
    expect(resolveThreadOngoingIndicator(input)).toEqual(expected);
  });
});
