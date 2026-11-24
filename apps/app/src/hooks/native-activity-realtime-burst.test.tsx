// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { isRunningThreadRuntimeDisplayStatus } from "@bb/client-core";
import type { ThreadRuntimeState } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { createRealtimeCacheEffects } from "./realtime-cache-effects";
import { threadListQueryKey, threadQueryKey } from "./queries/query-keys";
import { useNativeActivityNotice } from "./useNativeActivityUnconfirmed";

const START_MS = 1_800_000_000_500;
const HEARTBEAT_MS = 30_000;
const BURST_AT_MS = 61_000;
const SESSION_MS = 180_000;

type Display = ThreadRuntimeState["displayStatus"];

function runtimeOf(
  displayStatus: Display,
  lastEvidenceAt?: number,
): ThreadRuntimeState {
  return {
    displayStatus,
    ...(lastEvidenceAt === undefined
      ? {}
      : {
          nativeActivity: {
            lastEvidenceAt,
            freshForMs: 90_000,
            confirmation: "confirmed",
            evidenceKind: "holder-report",
          },
        }),
  };
}

describe("native activity realtime burst", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("never reads Activity not reported across receipts and an interrupt burst delivered through the realtime dispatch", async () => {
    vi.useFakeTimers({ now: START_MS });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const seeded: ThreadResponse = {
      ...makeThreadResponse({ runtime: runtimeOf("active", START_MS - 10) }),
      status: "active",
      nativeTerminal: true,
    };
    const threadId = seeded.id;
    let serverRuntime = seeded.runtime;
    const detailFetches: number[] = [];
    const effects = createRealtimeCacheEffects({ queryClient });
    const activity = makeThreadListEntry().activity;

    const send = (
      changes: ("events-appended" | "status-changed" | "terminals-changed")[],
      status?: { status: ThreadResponse["status"]; runtime: ThreadRuntimeState },
    ) => {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: threadId,
        changes,
        ...(status === undefined
          ? {}
          : {
              metadata: {
                statusChange: {
                  status: status.status,
                  runtime: status.runtime,
                  activity,
                  latestAttentionAt: seeded.latestAttentionAt,
                  updatedAt: seeded.updatedAt,
                },
              },
            }),
      });
    };

    const log: string[] = [];
    const { unmount } = renderHook(
      () => {
        const thread = useQuery<ThreadResponse>({
          queryKey: threadQueryKey(threadId),
          queryFn: async () => {
            detailFetches.push(Date.now());
            return {
              ...seeded,
              status: "active",
              runtime: serverRuntime,
            } satisfies ThreadResponse;
          },
          initialData: seeded,
          staleTime: Infinity,
        }).data;
        const notice = useNativeActivityNotice(thread.runtime);
        const portal = isRunningThreadRuntimeDisplayStatus(
          thread.runtime.displayStatus,
        )
          ? notice.unconfirmed
            ? "activity-unreported"
            : "working"
          : "none";
        log.push(
          `${portal}|${thread.runtime.displayStatus}|${thread.runtime.nativeActivity?.lastEvidenceAt}`,
        );
        return portal;
      },
      { wrapper },
    );

    const perTick: string[] = [];
    for (let elapsed = 1_000; elapsed <= SESSION_MS; elapsed += 1_000) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      if (elapsed % HEARTBEAT_MS === 0) {
        serverRuntime = runtimeOf("active", Date.now() - 10);
        await act(async () => {
          send(["status-changed"], { status: "active", runtime: serverRuntime });
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      if (elapsed === BURST_AT_MS - (BURST_AT_MS % 1_000)) {
        const lastEvidenceAt = Date.now() - 10;
        await act(async () => {
          send(["events-appended"]);
          send(["events-appended"]);
          send(["status-changed"], {
            status: "stopping",
            runtime: runtimeOf("stopping"),
          });
          send(["status-changed"], {
            status: "error",
            runtime: runtimeOf("error"),
          });
          send(["terminals-changed", "status-changed"]);
          await vi.advanceTimersByTimeAsync(300);
        });
        serverRuntime = runtimeOf("error", lastEvidenceAt);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(700);
        });
        serverRuntime = runtimeOf("active", Date.now() - 10);
        await act(async () => {
          send(["status-changed"], { status: "active", runtime: serverRuntime });
          await vi.advanceTimersByTimeAsync(1_000);
        });
        elapsed += 2_000;
      }
      perTick.push(log.at(-1) ?? "none");
    }

    expect(perTick.filter((entry) => entry.startsWith("activity-unreported"))).toEqual([]);
    expect(perTick.at(-1)?.startsWith("working|active|")).toBe(true);
    expect(detailFetches.length).toBeGreaterThan(0);
    unmount();
  });

  it("keeps the newest receipt when a list refetch returns an older copy at the same updatedAt", async () => {
    vi.useFakeTimers({ now: START_MS });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const seeded: ThreadResponse = {
      ...makeThreadResponse({ runtime: runtimeOf("active", START_MS - 10) }),
      status: "active",
      nativeTerminal: true,
    };
    const threadId = seeded.id;
    const staleEntry = makeThreadListEntry({
      id: threadId,
      projectId: "project-1",
      status: "active",
      updatedAt: seeded.updatedAt,
      runtime: runtimeOf("active", START_MS - 120_000),
    });
    const listKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const effects = createRealtimeCacheEffects({ queryClient });
    const activity = makeThreadListEntry().activity;
    let freshRuntime = seeded.runtime;
    let listFetches = 0;

    const log: string[] = [];
    const { unmount } = renderHook(
      () => {
        const thread = useQuery<ThreadResponse>({
          queryKey: threadQueryKey(threadId),
          queryFn: async () => ({ ...seeded, runtime: freshRuntime }),
          initialData: seeded,
          staleTime: Infinity,
        }).data;
        useQuery({
          queryKey: listKey,
          queryFn: async () => {
            listFetches += 1;
            return [staleEntry];
          },
          initialData: [staleEntry],
          staleTime: Infinity,
        });
        const notice = useNativeActivityNotice(thread.runtime);
        const portal = isRunningThreadRuntimeDisplayStatus(
          thread.runtime.displayStatus,
        )
          ? notice.unconfirmed
            ? "activity-unreported"
            : "working"
          : "none";
        log.push(`${portal}|${thread.runtime.nativeActivity?.lastEvidenceAt}`);
        return portal;
      },
      { wrapper },
    );

    const perTick: string[] = [];
    for (let elapsed = 1_000; elapsed <= SESSION_MS; elapsed += 1_000) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      if (elapsed % HEARTBEAT_MS === 0) {
        freshRuntime = runtimeOf("active", Date.now() - 10);
        await act(async () => {
          effects.handleChanged({
            type: "changed",
            entity: "thread",
            id: threadId,
            changes: ["status-changed"],
            metadata: {
              statusChange: {
                status: "active",
                runtime: freshRuntime,
                activity,
                latestAttentionAt: seeded.latestAttentionAt,
                updatedAt: seeded.updatedAt,
              },
            },
          });
          effects.handleChanged({
            type: "changed",
            entity: "thread",
            id: threadId,
            changes: ["terminals-changed", "status-changed"],
          });
          await vi.advanceTimersByTimeAsync(300);
        });
      }
      perTick.push(log.at(-1) ?? "none");
    }

    expect(listFetches).toBeGreaterThan(0);
    expect(
      perTick.filter((entry) => entry.startsWith("activity-unreported")),
    ).toEqual([]);
    unmount();
  });
});
