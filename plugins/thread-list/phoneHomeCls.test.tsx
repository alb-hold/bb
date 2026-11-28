// @vitest-environment jsdom

import { act, cleanup, waitFor } from "@testing-library/react";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type {
  PluginBrowserBbSdk,
  PluginProvidersState,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  makePluginProject,
  makeSidebarEnvironment,
  makeSidebarThread,
} from "./app/model/fixtures.js";
import {
  preferencesMirrorStorageKey,
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "./app/preferences/preferences-sync.js";
import {
  threadListPullRequestRpcContract,
  type ThreadListPullRequest,
} from "./app/rows/pull-request-query.js";
import { defaultPreferences } from "./shared/preferences.js";

const execFileAsync = promisify(execFile);
const chromiumPath = inject("threadListChromiumPath");
const pluginCss = inject("threadListPluginCss");

const app = await loadPluginApp(() => import("./app"));
const registration = app.threadLists[0]!;
const SlotComponent = registration.component;

function WindowedSlot(props: PluginThreadListProps) {
  return (
    <div data-sidebar="content">
      <SlotComponent {...props} />
    </div>
  );
}

const PALLIUM_PROJECT = makePluginProject({
  id: "proj_pallium",
  name: "pallium",
});
const SEAHAVEN_PROJECT = makePluginProject({
  id: "proj_seahaven",
  name: "seahaven",
});

const PALLIUM_PARENT = makeSidebarThread({
  id: "thr_pallium",
  projectId: PALLIUM_PROJECT.id,
  providerId: "claude",
  title: "Pallium orchestrator",
  displayTitle: "Pallium orchestrator",
  status: "active",
  runtimeStatus: "active",
  updatedAt: 100_000,
  createdAt: 100_000,
  latestAttentionAt: 100_000,
  environment: makeSidebarEnvironment({
    id: "env_pallium",
    branchName: "feat/pallium-cls",
  }),
});

const PALLIUM_CHILD_1 = makeSidebarThread({
  id: "thr_pallium_child_1",
  parentThreadId: PALLIUM_PARENT.id,
  projectId: PALLIUM_PROJECT.id,
  providerId: "claude",
  title: "Pallium worker 1",
  displayTitle: "Pallium worker 1",
  updatedAt: 90_000,
  createdAt: 90_000,
  latestAttentionAt: 90_000,
});

const PALLIUM_CHILD_2 = makeSidebarThread({
  id: "thr_pallium_child_2",
  parentThreadId: PALLIUM_PARENT.id,
  projectId: PALLIUM_PROJECT.id,
  providerId: "claude",
  title: "Pallium worker 2",
  displayTitle: "Pallium worker 2",
  updatedAt: 80_000,
  createdAt: 80_000,
  latestAttentionAt: 80_000,
});

const SEAHAVEN_THREAD = makeSidebarThread({
  id: "thr_seahaven",
  projectId: SEAHAVEN_PROJECT.id,
  providerId: "claude",
  title: "Verify delivery status of Guilherme",
  displayTitle: "Verify delivery status of Guilherme",
  updatedAt: 70_000,
  createdAt: 70_000,
  latestAttentionAt: 70_000,
  environment: makeSidebarEnvironment({
    id: "env_seahaven",
    branchName: "fix/seahaven-delivery",
  }),
});

const CLAUDE_PROVIDER: PluginProvidersState["providers"][number] = {
  id: "claude",
  pluginId: "claude-code",
  displayName: "Claude Code",
  logoUrl:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6'/%3E%3C/svg%3E",
  available: true,
  maintenance: { health: false, usage: false, installation: false },
  capabilities: {
    supportsThreadArchive: true,
    supportsThreadRename: true,
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    supportsFork: true,
    supportsSessionRewind: false,
    modelCatalogScope: "workspace",
    permissionModes: ["accept-edits", "auto", "full"],
  },
  composerActions: [],
  completedTurnDisplay: "collapse",
};

const PALLIUM_PR: ThreadListPullRequest = {
  number: 2925,
  title: "Pallium orchestrator PR",
  url: "https://github.com/albrand/bb/pull/2925",
  state: "open",
};

const SEAHAVEN_PR: ThreadListPullRequest = {
  number: 649,
  title: "Seahaven delivery PR",
  url: "https://github.com/albrand/bb/pull/649",
  state: "open",
};

interface MockIntersectionObserverInstance {
  callback: IntersectionObserverCallback;
  observed: Set<Element>;
}

const intersectionObservers: MockIntersectionObserverInstance[] = [];

function realizeObservedWindowedItems() {
  for (const instance of [...intersectionObservers]) {
    const entries = Array.from(
      instance.observed,
      (target) =>
        ({
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          boundingClientRect: new DOMRect(0, 0, 258, 52),
          intersectionRect: new DOMRect(0, 0, 258, 52),
          rootBounds: new DOMRect(0, 0, 258, 844),
          time: 0,
        }) satisfies IntersectionObserverEntry,
    );
    if (entries.length > 0) {
      instance.callback(entries, {} as IntersectionObserver);
    }
  }
}

function createDeferredPullRequestRpc() {
  const resolvers = new Map<
    string,
    (value: { pullRequest: ThreadListPullRequest | null }) => void
  >();
  const callRpc: PluginBrowserBbSdk["plugins"]["callRpc"] = vi.fn(
    (call) =>
      new Promise<{ pullRequest: ThreadListPullRequest | null }>((resolve) => {
        if (call.method === threadListPullRequestRpcContract.method) {
          const input = call.input as { environmentId: string };
          resolvers.set(input.environmentId, resolve);
          return;
        }
        resolve({ pullRequest: null });
      }) as ReturnType<PluginBrowserBbSdk["plugins"]["callRpc"]>,
  );
  return {
    callRpc,
    resolveAll() {
      resolvers.get("env_pallium")?.({ pullRequest: PALLIUM_PR });
      resolvers.get("env_seahaven")?.({ pullRequest: SEAHAVEN_PR });
    },
  };
}

function seedPhoneHomePreferences() {
  const preferences = {
    ...defaultPreferences(),
    organizationMode: "project" as const,
    groupByReadStatus: false,
    groupThreadsByEnvironment: false,
  };
  window.localStorage.setItem(
    preferencesMirrorStorageKey("test-plugin"),
    JSON.stringify(preferences),
  );
  return preferences;
}

function renderPhoneHomeSidebar({
  providers,
  callRpc,
}: {
  providers: Partial<PluginProvidersState>;
  callRpc: PluginBrowserBbSdk["plugins"]["callRpc"];
}) {
  const preferences = seedPhoneHomePreferences();
  return renderSlot(
    { component: WindowedSlot },
    {
      activeThreadId: null,
      activeProjectId: null,
      isCompactViewport: true,
      experimental_isVisible: true,
      onNavigate: vi.fn(),
      searchQuery: "",
    },
    {
      providers,
      sidebarThreads: {
        projects: [PALLIUM_PROJECT, SEAHAVEN_PROJECT],
        threads: [
          PALLIUM_PARENT,
          PALLIUM_CHILD_1,
          PALLIUM_CHILD_2,
          SEAHAVEN_THREAD,
        ],
      },
      sdk: { plugins: { callRpc } },
      rpc: {
        listPreferences: () => ({ preferences }),
        setPreference: (input: unknown) => input,
      },
    },
  );
}

function findThreadRow(container: HTMLElement, threadId: string): HTMLElement {
  const link = container.querySelector<HTMLElement>(
    `[data-sidebar-thread-id="${threadId}"]`,
  );
  const row = link?.closest<HTMLElement>("[data-sidebar-rename-row]");
  if (!row) {
    throw new Error(`Missing rendered ThreadRow for ${threadId}`);
  }
  return row;
}

beforeEach(() => {
  intersectionObservers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly observed = new Set<Element>();
      readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        intersectionObservers.push(this);
      }
      observe(element: Element) {
        this.observed.add(element);
      }
      unobserve(element: Element) {
        this.observed.delete(element);
      }
      disconnect() {
        this.observed.clear();
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    },
  );
});

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("phone home sidebar reserved geometry", () => {
  it("reserves final mobile row heights, leading icon slots, and status-slot widths before late data arrives", async () => {
    const deferredPr = createDeferredPullRequestRpc();
    const { container } = renderPhoneHomeSidebar({
      providers: { status: "loading", providers: [] },
      callRpc: deferredPr.callRpc,
    });

    const placeholders = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-windowed-item]"),
    );
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0]?.getAttribute("style")).toBe("height: 156px;");
    expect(placeholders[1]?.getAttribute("style")).toBe("height: 52px;");

    act(realizeObservedWindowedItems);
    act(realizeObservedWindowedItems);

    const palliumRow = findThreadRow(container, "thr_pallium");
    const seahavenRow = findThreadRow(container, "thr_seahaven");

    for (const row of [palliumRow, seahavenRow]) {
      expect(
        row.classList.contains("[--bb-sidebar-mobile-row-height:3.25rem]"),
      ).toBe(true);
      expect(
        row.classList.contains("max-md:h-(--bb-sidebar-mobile-row-height)"),
      ).toBe(true);
      expect(
        row.classList.contains(
          "max-md:pointer-coarse:h-(--bb-sidebar-mobile-row-height)",
        ),
      ).toBe(true);
      expect(row.classList.contains("max-md:h-auto")).toBe(false);

      const leading = row.querySelector<HTMLElement>(
        "[data-sidebar-thread-leading]",
      );
      expect(leading).not.toBeNull();
      expect(leading?.classList.contains("size-4")).toBe(true);
      expect(leading?.classList.contains("max-md:mr-1.5")).toBe(true);

      const statusSlot = row.querySelector<HTMLElement>(
        "[data-sidebar-thread-trailing-badges]",
      );
      expect(statusSlot).not.toBeNull();
      expect(statusSlot?.classList.contains("max-md:w-21")).toBe(true);
      expect(statusSlot?.classList.contains("max-md:justify-end")).toBe(true);
    }

    await act(async () => {
      deferredPr.resolveAll();
    });
    await waitFor(() => {
      expect(
        palliumRow.querySelector("[data-sidebar-thread-pull-request]")
          ?.textContent,
      ).toBe("#2925");
      expect(
        seahavenRow.querySelector("[data-sidebar-thread-pull-request]")
          ?.textContent,
      ).toBe("#649");
    });

    expect(
      palliumRow
        .querySelector("[data-sidebar-thread-trailing-badges]")
        ?.classList.contains("max-md:w-21"),
    ).toBe(true);
    expect(
      seahavenRow
        .querySelector("[data-sidebar-thread-trailing-badges]")
        ?.classList.contains("max-md:w-21"),
    ).toBe(true);
  });
});

interface BoxSnapshot {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface PhoneRowSnapshot {
  row: BoxSnapshot;
  leadingWidth: number;
  titleLeft: number;
  titleWidth: number;
  statusSlotWidth: number;
  trailingLeft: number;
  trailingWidth: number;
}

interface PhoneSidebarSnapshot {
  coarse: boolean;
  seahavenSectionTop: number;
  placeholderHeights: number[];
  pallium: PhoneRowSnapshot | null;
  seahaven: PhoneRowSnapshot | null;
}

const PHONE_MEASURE_SCRIPT = `
const box = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
};
const rowSnapshot = (threadId) => {
  const link = document.querySelector('[data-sidebar-thread-id="' + threadId + '"]');
  if (!link) return null;
  const row = link.closest('[data-sidebar-rename-row]');
  const leading = row.querySelector('[data-sidebar-thread-leading]');
  const title = row.querySelector('.bb-thread-title');
  const statusSlot = row.querySelector('[data-sidebar-thread-trailing-badges]');
  const trailing = row.querySelector('[data-sidebar-thread-trailing]');
  return {
    row: box(row),
    leadingWidth: leading ? box(leading).width : 0,
    titleLeft: box(title).left,
    titleWidth: box(title).width,
    statusSlotWidth: statusSlot ? box(statusSlot).width : 0,
    trailingLeft: box(trailing).left,
    trailingWidth: box(trailing).width,
  };
};
const seahavenSection = document.querySelector('[data-sidebar-section-id="project:proj_seahaven"]');
const placeholders = [...document.querySelectorAll('[data-sidebar-windowed-item]:empty')].map((el) => box(el).height);
document.getElementById('layout').textContent = JSON.stringify({
  coarse: matchMedia('(pointer: coarse)').matches,
  seahavenSectionTop: box(seahavenSection).top,
  placeholderHeights: placeholders,
  pallium: rowSnapshot('thr_pallium'),
  seahaven: rowSnapshot('thr_seahaven'),
});
`;

async function measurePhoneSidebarLayout(
  sidebarHtml: string,
  sidebarWidth: number,
): Promise<PhoneSidebarSnapshot> {
  const dir = await mkdtemp(join(tmpdir(), "bb-phone-cls-"));
  try {
    const page = join(dir, "phone-home.html");
    const themeCss = await readFile(
      new URL("../../apps/app/src/components/ui/theme.css", import.meta.url),
      "utf8",
    );
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
:root{--bb-sidebar-row-height:1.75rem;--bb-sidebar-row-height-coarse:2.5rem;--sidebar:#fafafa;--sidebar-accent:#e4e4e7;--timeline-accent:#2563eb}
*,::before,::after{box-sizing:border-box}
body{margin:0}
${pluginCss ?? ""}
${themeCss}
</style></head><body>
<div data-bb-plugin-root style="width:${sidebarWidth}px">${sidebarHtml}</div>
<pre id="layout"></pre>
<script>addEventListener("load", () => setTimeout(() => {${PHONE_MEASURE_SCRIPT}}, 30));</script>
</body></html>`,
    );
    const { stdout } = await execFileAsync(chromiumPath ?? "", [
      "--headless",
      `--user-data-dir=${join(dir, "profile")}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--hide-scrollbars",
      "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1",
      "--window-size=390,844",
      "--virtual-time-budget=2000",
      "--dump-dom",
      `file://${page}`,
    ]);
    const match = /<pre id="layout">([^<]*)<\/pre>/.exec(stdout);
    if (match?.[1] === undefined) {
      throw new Error(stdout.slice(0, 500));
    }
    const snapshot = JSON.parse(
      match[1].replaceAll("&quot;", '"'),
    ) as PhoneSidebarSnapshot;
    return snapshot;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(
  pluginCss === null || (chromiumPath === null && !process.env.CI),
)("phone home sidebar reserved geometry in Chromium 390x844", () => {
  it.each([258, 320])(
    "keeps row height, section position, icon slot, and status-slot width unchanged across late arrivals at %spx sidebar width",
    async (sidebarWidth) => {
      const deferredLoading = createDeferredPullRequestRpc();
      const loadingSlot = renderPhoneHomeSidebar({
        providers: { status: "loading", providers: [] },
        callRpc: deferredLoading.callRpc,
      });

      const beforeRealizeHtml = loadingSlot.container.innerHTML;
      act(realizeObservedWindowedItems);
      const afterTopRealizeHtml = loadingSlot.container.innerHTML;
      act(realizeObservedWindowedItems);
      const beforeLateDataHtml = loadingSlot.container.innerHTML;

      await act(async () => {
        deferredLoading.resolveAll();
      });
      await waitFor(() => {
        expect(
          loadingSlot.container.querySelectorAll(
            "[data-sidebar-thread-pull-request]",
          ),
        ).toHaveLength(2);
      });
      const afterPrOnlyHtml = loadingSlot.container.innerHTML;
      loadingSlot.lifecycle.unmount();

      resetPreferencesSyncForTest();
      const deferredReady = createDeferredPullRequestRpc();
      const readySlot = renderPhoneHomeSidebar({
        providers: { status: "ready", providers: [CLAUDE_PROVIDER] },
        callRpc: deferredReady.callRpc,
      });
      act(realizeObservedWindowedItems);
      act(realizeObservedWindowedItems);
      await act(async () => {
        deferredReady.resolveAll();
      });
      await waitFor(() => {
        expect(
          readySlot.container.querySelectorAll(
            "[data-sidebar-thread-pull-request]",
          ),
        ).toHaveLength(2);
      });
      expect(
        readySlot.container.querySelectorAll(
          '[data-sidebar-thread-provider="claude"]',
        ).length,
      ).toBeGreaterThanOrEqual(2);
      const afterIconsAndPrHtml = readySlot.container.innerHTML;

      const [
        beforeRealize,
        afterTopRealize,
        beforeLateData,
        afterPrOnly,
        afterIconsAndPr,
      ] = await Promise.all([
        measurePhoneSidebarLayout(beforeRealizeHtml, sidebarWidth),
        measurePhoneSidebarLayout(afterTopRealizeHtml, sidebarWidth),
        measurePhoneSidebarLayout(beforeLateDataHtml, sidebarWidth),
        measurePhoneSidebarLayout(afterPrOnlyHtml, sidebarWidth),
        measurePhoneSidebarLayout(afterIconsAndPrHtml, sidebarWidth),
      ]);

      expect(beforeLateData.coarse).toBe(true);
      expect(beforeLateData.pallium).not.toBeNull();
      expect(beforeLateData.seahaven).not.toBeNull();
      expect(afterIconsAndPr.pallium).not.toBeNull();
      expect(afterIconsAndPr.seahaven).not.toBeNull();

      expect(beforeLateData.pallium!.row.height).toBe(52);
      expect(beforeLateData.seahaven!.row.height).toBe(52);
      expect(beforeRealize.placeholderHeights).toEqual([156, 52]);
      expect(afterTopRealize.seahavenSectionTop).toBe(
        beforeRealize.seahavenSectionTop,
      );
      expect(beforeLateData.seahavenSectionTop).toBe(
        beforeRealize.seahavenSectionTop,
      );

      expect(afterPrOnly.pallium!.row.height).toBe(
        beforeLateData.pallium!.row.height,
      );
      expect(afterIconsAndPr.pallium!.row.height).toBe(
        beforeLateData.pallium!.row.height,
      );
      expect(afterIconsAndPr.seahaven!.row.height).toBe(
        beforeLateData.seahaven!.row.height,
      );

      expect(beforeLateData.pallium!.leadingWidth).toBe(16);
      expect(afterIconsAndPr.pallium!.leadingWidth).toBe(
        beforeLateData.pallium!.leadingWidth,
      );
      expect(afterIconsAndPr.pallium!.titleLeft).toBe(
        beforeLateData.pallium!.titleLeft,
      );

      expect(afterPrOnly.pallium!.statusSlotWidth).toBe(
        beforeLateData.pallium!.statusSlotWidth,
      );
      expect(afterIconsAndPr.pallium!.statusSlotWidth).toBe(
        beforeLateData.pallium!.statusSlotWidth,
      );
      expect(afterIconsAndPr.seahaven!.statusSlotWidth).toBe(
        beforeLateData.seahaven!.statusSlotWidth,
      );
      expect(afterIconsAndPr.pallium!.trailingLeft).toBe(
        beforeLateData.pallium!.trailingLeft,
      );
      expect(afterIconsAndPr.pallium!.titleWidth).toBe(
        beforeLateData.pallium!.titleWidth,
      );
      expect(afterIconsAndPr.seahaven!.titleWidth).toBe(
        beforeLateData.seahaven!.titleWidth,
      );
    },
    40_000,
  );
});
