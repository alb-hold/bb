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
} from "./model/fixtures.js";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "./preferences/preferences-sync.js";
import {
  threadListPullRequestRpcContract,
  type ThreadListPullRequest,
} from "./rows/pull-request-query.js";
import {
  defaultPreferences,
  type PreferenceValues,
} from "../shared/preferences.js";

const execFileAsync = promisify(execFile);
const chromiumPath = inject("threadListChromiumPath");
const pluginCss = inject("threadListPluginCss");

const app = await loadPluginApp(() => import("../app"));
const registration = app.threadLists[0];
if (!registration) {
  throw new Error("thread-list slot not registered");
}
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

const WIDE_PALLIUM_PR: ThreadListPullRequest = {
  number: 123_456_789,
  title: "Wide Pallium orchestrator PR",
  url: "https://github.com/albrand/bb/pull/123456789",
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

type EnvironmentPullRequestOutcome =
  | { outcome: "available"; pullRequest: ThreadListPullRequest }
  | { outcome: "absent" };

function createDeferredPullRequestRpc(
  pullRequestsByEnv: Record<string, ThreadListPullRequest> = {
    env_pallium: PALLIUM_PR,
    env_seahaven: SEAHAVEN_PR,
  },
) {
  let resolved = false;
  const pending: Array<{
    keys: string[];
    resolve: (value: Record<string, EnvironmentPullRequestOutcome>) => void;
  }> = [];
  const buildResponse = (keys: string[]) =>
    Object.fromEntries(
      keys.map((key) => {
        const pullRequest = pullRequestsByEnv[key];
        return [
          key,
          pullRequest
            ? ({ outcome: "available", pullRequest } as const)
            : ({ outcome: "absent" } as const),
        ];
      }),
    );

  return {
    pullRequests(input: unknown) {
      const { keys } =
        threadListPullRequestRpcContract.pullRequests.input.parse(input);
      if (resolved) {
        return Promise.resolve(buildResponse(keys));
      }
      return new Promise<Record<string, EnvironmentPullRequestOutcome>>(
        (resolve) => {
          pending.push({ keys, resolve });
        },
      );
    },
    resolveAll() {
      resolved = true;
      for (const entry of pending.splice(0)) {
        entry.resolve(buildResponse(entry.keys));
      }
    },
  };
}

function phoneHomePreferences(): PreferenceValues {
  return {
    ...defaultPreferences(),
    organizationMode: "project",
    groupByReadStatus: false,
    environmentGrouping: false,
  };
}

async function renderPhoneHomeSidebar({
  providers,
  pullRequestsByEnv,
}: {
  providers: Partial<PluginProvidersState>;
  pullRequestsByEnv?: Record<string, ThreadListPullRequest>;
}) {
  setPreferencesMirrorStorageForTest(null);
  const deferredPr = createDeferredPullRequestRpc(pullRequestsByEnv);
  const preferences = phoneHomePreferences();
  const callRpc = vi.fn().mockResolvedValue({
    automations: [],
  }) as PluginBrowserBbSdk["plugins"]["callRpc"];

  const slot = await act(async () =>
    renderSlot(
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
          pullRequests: deferredPr.pullRequests,
        },
      },
    ),
  );

  await waitFor(() => {
    expect(
      slot.container.querySelectorAll("[data-sidebar-windowed-item]"),
    ).toHaveLength(2);
  });

  return { slot, deferredPr };
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

function withHostThreadTitleMarkup(html: string): string {
  return html.replaceAll(
    "<span data-thread-title=",
    '<span class="inline-block max-w-full truncate whitespace-pre" data-thread-title=',
  );
}

type TestPointerMode = "coarse" | "fine" | "none";

const BLINK_POINTER_SETTINGS: Record<TestPointerMode, string> = {
  coarse:
    "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1",
  fine: "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
  none: "--blink-settings=primaryPointerType=1,availablePointerTypes=1,primaryHoverType=1,availableHoverTypes=1",
};

function stubPointerMatchMedia(pointerMode: TestPointerMode) {
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => {
    const matches =
      (query === "(pointer: coarse)" && pointerMode === "coarse") ||
      (query === "(pointer: fine)" && pointerMode === "fine") ||
      (query === "(pointer: none)" && pointerMode === "none") ||
      (query === "(hover: hover)" && pointerMode === "fine") ||
      (query === "(hover: none)" && pointerMode !== "fine");
    return {
      matches,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    };
  });
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
    stubPointerMatchMedia("coarse");
    const { slot, deferredPr } = await renderPhoneHomeSidebar({
      providers: { status: "loading", providers: [] },
    });
    const { container } = slot;

    const placeholders = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-windowed-item]"),
    );
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0]?.getAttribute("style")).toBe("height: 156px;");
    expect(placeholders[1]?.getAttribute("style")).toBe("height: 52px;");

    await act(async () => {
      realizeObservedWindowedItems();
    });
    await act(async () => {
      realizeObservedWindowedItems();
    });

    const palliumRow = findThreadRow(container, "thr_pallium");
    const seahavenRow = findThreadRow(container, "thr_seahaven");

    for (const row of [palliumRow, seahavenRow]) {
      expect(
        row.classList.contains("[--bb-sidebar-mobile-row-height:3.25rem]"),
      ).toBe(true);
      expect(
        row.classList.contains(
          "max-md:pointer-coarse:h-(--bb-sidebar-mobile-row-height)",
        ),
      ).toBe(true);
      expect(row.classList.contains("max-md:h-auto")).toBe(true);

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
      expect(statusSlot?.classList.contains("max-md:overflow-hidden")).toBe(
        true,
      );
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

    const palliumChip = palliumRow.querySelector<HTMLElement>(
      "[data-sidebar-thread-pull-request]",
    );
    expect(palliumChip?.classList.contains("max-md:shrink")).toBe(true);
    expect(palliumChip?.classList.contains("max-md:overflow-hidden")).toBe(
      true,
    );
    expect(
      palliumChip?.firstElementChild?.classList.contains("truncate"),
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

interface PrChipSnapshot extends BoxSnapshot {
  labelClientWidth: number;
  labelScrollWidth: number;
}

interface PhoneRowSnapshot {
  row: BoxSnapshot;
  leadingWidth: number;
  titleLeft: number;
  titleWidth: number;
  statusSlot: BoxSnapshot | null;
  statusSlotWidth: number;
  trailingLeft: number;
  trailingWidth: number;
  prChip: PrChipSnapshot | null;
  statusIndicator: BoxSnapshot | null;
}

interface PhoneSidebarSnapshot {
  name: string;
  coarse: boolean;
  fine: boolean;
  pointerNone: boolean;
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
const measureSection = (section) => {
  const originTop = section.getBoundingClientRect().top;
  const rowSnapshot = (threadId) => {
    const link = section.querySelector('[data-sidebar-thread-id="' + threadId + '"]');
    if (!link) return null;
    const row = link.closest('[data-sidebar-rename-row]');
    const leading = row.querySelector('[data-sidebar-thread-leading]');
    const title = row.querySelector('.bb-thread-title');
    const statusSlot = row.querySelector('[data-sidebar-thread-trailing-badges]');
    const trailing = row.querySelector('[data-sidebar-thread-trailing]');
    const prChipEl = row.querySelector('[data-sidebar-thread-pull-request]');
    const prLabelEl = prChipEl ? (prChipEl.firstElementChild || prChipEl) : null;
    const statusSlotEl = row.querySelector('[data-sidebar-status-slot]');
    const statusWrapperEl = statusSlotEl ? statusSlotEl.parentElement : null;
    return {
      row: box(row),
      leadingWidth: leading ? box(leading).width : 0,
      titleLeft: box(title).left,
      titleWidth: box(title).width,
      statusSlot: statusSlot ? box(statusSlot) : null,
      statusSlotWidth: statusSlot ? box(statusSlot).width : 0,
      trailingLeft: box(trailing).left,
      trailingWidth: box(trailing).width,
      prChip: prChipEl
        ? {
            ...box(prChipEl),
            labelClientWidth: prLabelEl.clientWidth,
            labelScrollWidth: prLabelEl.scrollWidth,
          }
        : null,
      statusIndicator: statusWrapperEl ? box(statusWrapperEl) : null,
    };
  };
  const seahavenSection = section.querySelector('[data-sidebar-sticky-project-item][data-sidebar-project-id="proj_seahaven"]');
  const placeholders = [...section.querySelectorAll('[data-sidebar-windowed-item]:empty')].map((el) => box(el).height);
  return {
    name: section.getAttribute('data-snapshot'),
    coarse: matchMedia('(pointer: coarse)').matches,
    fine: matchMedia('(pointer: fine)').matches,
    pointerNone: matchMedia('(pointer: none)').matches,
    seahavenSectionTop: box(seahavenSection).top - originTop,
    placeholderHeights: placeholders,
    pallium: rowSnapshot('thr_pallium'),
    seahaven: rowSnapshot('thr_seahaven'),
  };
};
const sections = [...document.querySelectorAll('section[data-snapshot]')];
for (const section of sections) {
  section.style.display = 'none';
}
const results = {};
for (const section of sections) {
  section.style.display = 'block';
  const measured = measureSection(section);
  results[measured.name] = measured;
  section.style.display = 'none';
}
document.getElementById('layout').textContent = JSON.stringify(results);
`;

async function measurePhoneSidebarSnapshots(
  snapshots: Record<string, string>,
  sidebarWidth: number,
  pointerMode: TestPointerMode = "coarse",
): Promise<Record<string, PhoneSidebarSnapshot>> {
  const dir = await mkdtemp(join(tmpdir(), "bb-phone-cls-"));
  try {
    const page = join(dir, "phone-home.html");
    const themeCss = await readFile(
      join(process.cwd(), "../../apps/app/src/components/ui/theme.css"),
      "utf8",
    );
    const sections = Object.entries(snapshots)
      .map(
        ([name, html]) =>
          `<section data-snapshot="${name}"><div data-bb-plugin-root style="width:${sidebarWidth}px">${withHostThreadTitleMarkup(html)}</div></section>`,
      )
      .join("\n");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
@layer theme, base, components, utilities;
:root{--bb-sidebar-row-height:1.75rem;--bb-sidebar-row-height-coarse:2.5rem;--sidebar:#fafafa;--sidebar-accent:#e4e4e7;--timeline-accent:#2563eb}
*,::before,::after{box-sizing:border-box}
body{margin:0}
[data-thread-status-glyph]{display:inline-block;width:16px;height:16px}
${pluginCss ?? ""}
${themeCss}
</style></head><body>
${sections}
<pre id="layout"></pre>
<script>addEventListener("load", () => setTimeout(() => {${PHONE_MEASURE_SCRIPT}}, 30));</script>
</body></html>`,
    );
    const args = [
      "--headless",
      `--user-data-dir=${join(dir, "profile")}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--hide-scrollbars",
      BLINK_POINTER_SETTINGS[pointerMode],
      "--window-size=390,844",
      "--virtual-time-budget=2000",
      "--dump-dom",
      `file://${page}`,
    ];
    const { stdout } = await execFileAsync(chromiumPath ?? "", args, {
      timeout: 30_000,
    });
    const match = /<pre id="layout">([^<]*)<\/pre>/.exec(stdout);
    if (match?.[1] === undefined) {
      throw new Error(stdout.slice(0, 500));
    }
    return JSON.parse(
      match[1].replaceAll("&quot;", '"'),
    ) as Record<string, PhoneSidebarSnapshot>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(
  pluginCss === null || (chromiumPath === null && !process.env.CI),
)("phone home sidebar reserved geometry in Chromium 390x844", () => {
  it.each([258, 320, 390])(
    "keeps row height, section position, icon slot, and status-slot width unchanged across late arrivals and wide PR chips at %spx sidebar width",
    async (sidebarWidth) => {
      stubPointerMatchMedia("coarse");
      const { slot: loadingSlot, deferredPr: deferredLoading } =
        await renderPhoneHomeSidebar({
          providers: { status: "loading", providers: [] },
        });

      const beforeRealizeHtml = loadingSlot.container.innerHTML;
      await act(async () => {
        realizeObservedWindowedItems();
      });
      const afterTopRealizeHtml = loadingSlot.container.innerHTML;
      await act(async () => {
        realizeObservedWindowedItems();
      });
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

      intersectionObservers.length = 0;
      resetPreferencesSyncForTest();
      const { slot: readySlot, deferredPr: deferredReady } =
        await renderPhoneHomeSidebar({
          providers: { status: "ready", providers: [CLAUDE_PROVIDER] },
        });
      await act(async () => {
        realizeObservedWindowedItems();
      });
      await act(async () => {
        realizeObservedWindowedItems();
      });
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
      readySlot.lifecycle.unmount();

      intersectionObservers.length = 0;
      resetPreferencesSyncForTest();
      const { slot: widePrSlot, deferredPr: deferredWidePr } =
        await renderPhoneHomeSidebar({
          providers: { status: "ready", providers: [CLAUDE_PROVIDER] },
          pullRequestsByEnv: {
            env_pallium: WIDE_PALLIUM_PR,
            env_seahaven: SEAHAVEN_PR,
          },
        });
      await act(async () => {
        realizeObservedWindowedItems();
      });
      await act(async () => {
        realizeObservedWindowedItems();
      });
      await act(async () => {
        deferredWidePr.resolveAll();
      });
      await waitFor(() => {
        expect(
          widePrSlot.container.querySelector(
            "[data-sidebar-thread-pull-request]",
          )?.textContent,
        ).toBe("#123456789");
      });
      const afterWidePrHtml = widePrSlot.container.innerHTML;

      const measured = await measurePhoneSidebarSnapshots(
        {
          beforeRealize: beforeRealizeHtml,
          afterTopRealize: afterTopRealizeHtml,
          beforeLateData: beforeLateDataHtml,
          afterPrOnly: afterPrOnlyHtml,
          afterIconsAndPr: afterIconsAndPrHtml,
          afterWidePr: afterWidePrHtml,
        },
        sidebarWidth,
        "coarse",
      );

      const beforeRealize = measured.beforeRealize!;
      const afterTopRealize = measured.afterTopRealize!;
      const beforeLateData = measured.beforeLateData!;
      const afterPrOnly = measured.afterPrOnly!;
      const afterIconsAndPr = measured.afterIconsAndPr!;
      const afterWidePr = measured.afterWidePr!;

      expect(beforeRealize.coarse).toBe(true);
      expect(beforeRealize.fine).toBe(false);
      expect(beforeRealize.pointerNone).toBe(false);
      expect(beforeLateData.coarse).toBe(true);
      expect(beforeLateData.fine).toBe(false);
      expect(beforeLateData.pointerNone).toBe(false);
      expect(afterIconsAndPr.coarse).toBe(true);
      expect(afterWidePr.coarse).toBe(true);
      expect(beforeLateData.pallium).not.toBeNull();
      expect(beforeLateData.seahaven).not.toBeNull();
      expect(afterIconsAndPr.pallium).not.toBeNull();
      expect(afterIconsAndPr.seahaven).not.toBeNull();
      expect(afterWidePr.pallium).not.toBeNull();

      expect(beforeRealize.placeholderHeights).toEqual([156, 52]);
      expect(afterTopRealize.seahavenSectionTop).toBe(
        beforeRealize.seahavenSectionTop,
      );
      expect(beforeLateData.seahavenSectionTop).toBe(
        beforeRealize.seahavenSectionTop,
      );
      expect(afterPrOnly.seahavenSectionTop).toBe(
        beforeRealize.seahavenSectionTop,
      );
      expect(afterIconsAndPr.seahavenSectionTop).toBe(
        beforeRealize.seahavenSectionTop,
      );
      expect(afterWidePr.seahavenSectionTop).toBe(
        beforeRealize.seahavenSectionTop,
      );

      expect(beforeLateData.pallium!.row.height).toBe(52);
      expect(beforeLateData.seahaven!.row.height).toBe(52);
      expect(afterPrOnly.pallium!.row.height).toBe(52);
      expect(afterIconsAndPr.pallium!.row.height).toBe(52);
      expect(afterIconsAndPr.seahaven!.row.height).toBe(52);
      expect(afterWidePr.pallium!.row.height).toBe(52);

      expect(beforeLateData.pallium!.leadingWidth).toBe(16);
      expect(afterIconsAndPr.pallium!.leadingWidth).toBe(16);
      expect(afterIconsAndPr.pallium!.titleLeft).toBe(
        beforeLateData.pallium!.titleLeft,
      );

      expect(beforeLateData.pallium!.statusSlotWidth).toBe(84);
      expect(afterPrOnly.pallium!.statusSlotWidth).toBe(84);
      expect(afterIconsAndPr.pallium!.statusSlotWidth).toBe(84);
      expect(afterWidePr.pallium!.statusSlotWidth).toBe(84);
      expect(afterIconsAndPr.seahaven!.statusSlotWidth).toBe(84);

      expect(beforeLateData.pallium!.trailingWidth).toBeGreaterThanOrEqual(121);
      expect(afterIconsAndPr.pallium!.trailingWidth).toBe(
        beforeLateData.pallium!.trailingWidth,
      );
      expect(afterWidePr.pallium!.trailingWidth).toBe(
        beforeLateData.pallium!.trailingWidth,
      );
      expect(afterIconsAndPr.pallium!.trailingLeft).toBe(
        beforeLateData.pallium!.trailingLeft,
      );
      expect(afterWidePr.pallium!.trailingLeft).toBe(
        beforeLateData.pallium!.trailingLeft,
      );
      expect(afterIconsAndPr.pallium!.titleWidth).toBe(
        beforeLateData.pallium!.titleWidth,
      );
      expect(afterWidePr.pallium!.titleWidth).toBe(
        beforeLateData.pallium!.titleWidth,
      );
      expect(afterIconsAndPr.seahaven!.titleWidth).toBe(
        beforeLateData.seahaven!.titleWidth,
      );

      const normalSlot = afterIconsAndPr.pallium!.statusSlot!;
      const normalPr = afterIconsAndPr.pallium!.prChip!;
      const normalStatus = afterIconsAndPr.pallium!.statusIndicator!;
      expect(normalPr.labelScrollWidth).toBeLessThanOrEqual(
        normalPr.labelClientWidth + 1,
      );
      expect(normalPr.left).toBeGreaterThanOrEqual(normalSlot.left - 0.5);
      expect(normalPr.right).toBeLessThanOrEqual(normalStatus.left + 0.5);
      expect(normalStatus.right).toBeLessThanOrEqual(normalSlot.right + 0.5);

      const wideSlot = afterWidePr.pallium!.statusSlot!;
      const widePr = afterWidePr.pallium!.prChip!;
      const wideStatus = afterWidePr.pallium!.statusIndicator!;
      expect(widePr.labelScrollWidth).toBeGreaterThan(widePr.labelClientWidth);
      expect(widePr.left).toBeGreaterThanOrEqual(wideSlot.left - 0.5);
      expect(widePr.right).toBeLessThanOrEqual(wideStatus.left + 0.5);
      expect(wideStatus.right).toBeLessThanOrEqual(wideSlot.right + 0.5);
    },
    40_000,
  );

  it.each<TestPointerMode>(["fine", "none"])(
    "keeps compact %s-pointer no-state rows under 45px while matching non-coarse windowed placeholders",
    async (pointerMode) => {
      stubPointerMatchMedia(pointerMode);
      const { slot } = await renderPhoneHomeSidebar({
        providers: { status: "ready", providers: [CLAUDE_PROVIDER] },
      });

      const placeholders = Array.from(
        slot.container.querySelectorAll<HTMLElement>(
          "[data-sidebar-windowed-item]",
        ),
      );
      expect(placeholders[0]?.getAttribute("style")).toBe("height: 132px;");
      expect(placeholders[1]?.getAttribute("style")).toBe("height: 44px;");

      const beforeRealizeHtml = slot.container.innerHTML;
      await act(async () => {
        realizeObservedWindowedItems();
      });
      await act(async () => {
        realizeObservedWindowedItems();
      });
      const afterRealizeHtml = slot.container.innerHTML;

      const measured = await measurePhoneSidebarSnapshots(
        {
          beforeRealize: beforeRealizeHtml,
          afterRealize: afterRealizeHtml,
        },
        390,
        pointerMode,
      );

      const beforeRealize = measured.beforeRealize!;
      const afterRealize = measured.afterRealize!;
      expect(afterRealize.coarse).toBe(false);
      expect(afterRealize.fine).toBe(pointerMode === "fine");
      expect(afterRealize.pointerNone).toBe(pointerMode === "none");
      expect(beforeRealize.placeholderHeights).toEqual([132, 44]);
      expect(afterRealize.pallium!.row.height).toBeLessThan(45);
      expect(afterRealize.seahaven!.row.height).toBeLessThan(45);
      expect(afterRealize.seahavenSectionTop).toBe(
        beforeRealize.seahavenSectionTop,
      );
    },
    40_000,
  );
});
