// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { isRunningThreadRuntimeDisplayStatus } from "@bb/client-core";
import type { ThreadRuntimeState } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getThreadDetailActivityIndicator } from "@/lib/thread-activity-label";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { registerThreadEntityViews } from "./cache-owners/thread-entity-store";
import {
  updateCachedThreadListStatusState,
  updateCachedThreadStatusState,
} from "./cache-owners/query-cache";
import { threadQueryKey } from "./queries/query-keys";
import { useNativeActivityNotice } from "./useNativeActivityUnconfirmed";

const START_MS = 1_800_000_000_500;
const HEARTBEAT_MS = 30_000;
const SESSION_MS = 180_000;

function receiptRuntime(lastEvidenceAt: number): ThreadRuntimeState {
  return {
    displayStatus: "active",
    nativeActivity: {
      lastEvidenceAt,
      freshForMs: 90_000,
      confirmation: "confirmed",
      evidenceKind: "holder-report",
    },
  };
}

describe("native activity header flicker", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the native header indicator working on every tick while receipt-only status changes arrive every 30 seconds", () => {
    vi.useFakeTimers({ now: START_MS });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const seeded: ThreadResponse = {
      ...makeThreadResponse({ runtime: receiptRuntime(START_MS - 10) }),
      status: "active",
      nativeTerminal: true,
    };
    const threadId = seeded.id;
    queryClient.setQueryData(threadQueryKey(threadId), seeded);
    registerThreadEntityViews(queryClient);

    const observed: string[] = [];
    const { unmount } = renderHook(
      () => {
        const thread = useQuery<ThreadResponse>({
          queryKey: threadQueryKey(threadId),
          queryFn: () => Promise.reject(new Error("unexpected refetch")),
          enabled: false,
          staleTime: Infinity,
        }).data;
        if (thread === undefined) throw new Error("thread missing");
        const notice = useNativeActivityNotice(thread.runtime);
        const portal = isRunningThreadRuntimeDisplayStatus(
          thread.runtime.displayStatus,
        )
          ? notice.unconfirmed
            ? "activity-unreported"
            : "working"
          : "none";
        const label = getThreadDetailActivityIndicator(thread);
        observed.push(
          `${portal}/${label}@${thread.runtime.nativeActivity?.lastEvidenceAt}`,
        );
        return portal;
      },
      { wrapper },
    );

    const perTick: string[] = [];
    for (let elapsed = 1_000; elapsed <= SESSION_MS; elapsed += 1_000) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      if (elapsed % HEARTBEAT_MS === 0) {
        const change = {
          status: "active" as const,
          runtime: receiptRuntime(Date.now() - 10),
          activity: makeThreadListEntry().activity,
          latestAttentionAt: seeded.latestAttentionAt,
          updatedAt: seeded.updatedAt,
        };
        act(() => {
          updateCachedThreadListStatusState(queryClient, threadId, change);
          updateCachedThreadStatusState(queryClient, threadId, change);
        });
      }
      perTick.push(observed.at(-1) ?? "none");
    }

    expect(
      perTick.filter(
        (entry) => !entry.startsWith("working/") || entry.includes("unreported"),
      ),
    ).toEqual([]);
    unmount();
  });
});
