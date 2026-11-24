import { NATIVE_STATUS_CONTRACT_CASES } from "@bb/test-helpers";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("V5 CLI: shared native terminal status contract", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it.each(NATIVE_STATUS_CONTRACT_CASES)(
    "renders consistent status in bb thread show and bb thread list for $name",
    async (contractCase) => {
      const baseThread = fixtures.makeThread({
        id: `thr-${contractCase.name}`,
        projectId: "proj-status-contract",
        providerId: contractCase.providerId,
        status: contractCase.expectedStatus,
        title: `Thread ${contractCase.name}`,
      });
      const detailPayload = {
        ...baseThread,
        hasPendingInteraction: false,
        nativeTerminal: true,
        runtime: contractCase.expectedRuntime,
      };
      const listPayload = {
        ...makeThreadListEntry(baseThread),
        ...baseThread,
        hasPendingInteraction: false,
        nativeTerminal: true,
        listIndicator: contractCase.expectedListIndicator,
        runtime: contractCase.expectedRuntime,
      };

      stubServerApi({
        "v1.threads.:id.$get": async () => detailPayload,
        "v1.threads.:id.events.$get": async () => [],
        "v1.threads.:id.timeline.$get": fixtures.makeEmptyTimelineGetMock(),
        "v1.threads.:id.child-summary.$get": async () => ({
          nonDeletedChildCount: 0,
          unarchivedDescendantCount: 0,
          working: 0,
          waiting: 0,
          idle: 0,
          failed: 0,
          totalTokens: 0,
          children: [],
        }),
        "v1.threads.:id.spend-summary.$get": async () => ({
          historyComplete: false,
          providerId: contractCase.providerId,
          total: {
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningOutputTokens: null,
            totalTokens: null,
          },
          turns: [],
        }),
        "v1.threads.$get": async () => [listPayload],
        "v1.projects.$get": async () => [
          { id: "proj-status-contract", name: "Status" },
        ],
      });

      await runCommand(["thread", "show", baseThread.id], register);
      const showText = collectLogLines(vi.mocked(console.log)).join("\n");
      expect(showText).toContain(`Status: ${contractCase.expectedShowStatus}`);

      vi.mocked(console.log).mockClear();
      await runCommand(["thread", "show", baseThread.id, "--json"], register);
      const showJson = JSON.parse(
        collectLogLines(vi.mocked(console.log)).join("\n"),
      );
      expect(showJson.thread.status).toBe(contractCase.expectedStatus);
      expect(showJson.thread.runtime).toEqual(contractCase.expectedRuntime);

      vi.mocked(console.log).mockClear();
      await runCommand(["thread", "list"], register);
      const listTable = collectLogPayloads(vi.mocked(console.log)).join("\n");
      const rowLine = listTable
        .split("\n")
        .find((line) => line.includes(baseThread.id));
      expect(rowLine).toBeDefined();
      const cells = rowLine!
        .trim()
        .split(/\s{2,}/u)
        .map((cell) => cell.trim());
      expect(cells[3]).toBe(contractCase.expectedListStatus);
      expect(cells[4]).toBe(contractCase.expectedListNeedsYou);

      vi.mocked(console.log).mockClear();
      await runCommand(["thread", "list", "--json"], register);
      const [listJsonRow] = JSON.parse(
        collectLogPayloads(vi.mocked(console.log)).join("\n"),
      );
      expect(listJsonRow.status).toBe(contractCase.expectedStatus);
      expect(listJsonRow.runtime).toEqual(contractCase.expectedRuntime);
      expect(listJsonRow.listIndicator).toBe(
        contractCase.expectedListIndicator,
      );
    },
  );
});
