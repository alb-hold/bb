// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSetupComplete } from "./useSetupComplete";

const mocks = vi.hoisted(() => ({
  useSidebarNavigation: vi.fn(),
  useSidebarNavigationPreview: vi.fn(),
  useSystemConfig: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: mocks.useSystemConfig,
}));
vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigationPreview: mocks.useSidebarNavigationPreview,
  useSidebarNavigationPaging: () => ({
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: async () => undefined,
  }),
  useSidebarNavigation: mocks.useSidebarNavigation,
}));

function arrange({
  onboardingCompletedAt,
  threadCount,
}: {
  onboardingCompletedAt: string | null;
  threadCount: number;
}) {
  mocks.useSystemConfig.mockReturnValue({
    data: { generalSettings: { onboardingCompletedAt } },
  });
  mocks.useSidebarNavigation.mockReturnValue({
    data: {
      projects: [{ id: "proj_1", threads: [] }],
      personalProject: {
        threads: Array.from({ length: threadCount }, (_, index) => ({
          id: `thr_${index}`,
        })),
      },
    },
  });
  mocks.useSidebarNavigationPreview.mockReturnValue(undefined);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSetupComplete", () => {
  it("is false until the setup guide is finished or skipped", () => {
    arrange({ onboardingCompletedAt: null, threadCount: 3 });

    expect(renderHook(() => useSetupComplete()).result.current).toBe(false);
  });

  it("is false after the guide until the first thread exists", () => {
    arrange({
      onboardingCompletedAt: "2026-10-09T00:00:00.000Z",
      threadCount: 0,
    });

    expect(renderHook(() => useSetupComplete()).result.current).toBe(false);
  });

  it("is true once the guide is done and a thread exists", () => {
    arrange({
      onboardingCompletedAt: "2026-10-09T00:00:00.000Z",
      threadCount: 1,
    });

    expect(renderHook(() => useSetupComplete()).result.current).toBe(true);
  });

  it("does not treat populated placeholder navigation as complete before fresh data", () => {
    arrange({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z", threadCount: 1 });
    const navigation = {
      projects: [{ id: "proj_1", threads: [] }],
      personalProject: { threads: [{ id: "thr_placeholder" }] },
    };
    mocks.useSidebarNavigation.mockReturnValue({ data: navigation, isPlaceholderData: true });
    const hook = renderHook(() => useSetupComplete());
    expect(hook.result.current).toBe(false);
    mocks.useSidebarNavigation.mockReturnValue({ data: navigation, isPlaceholderData: false });
    hook.rerender();
    expect(hook.result.current).toBe(true);
  });
});
