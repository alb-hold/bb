// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type {
  ProviderCliInstallAction,
  ProviderCliKey,
} from "@bb/host-daemon-contract";
import type {
  PluginUpdateJob,
  SystemAppUpdateStatus,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliIssue } from "@/components/provider-cli/provider-cli-install";
import type {
  UpdateInventory,
  UpdateInventoryMachine,
} from "@/hooks/useUpdateInventory";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makePluginListItem } from "@/test/fixtures/plugins";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";

const appUpdateState = vi.hoisted(() => ({
  status: undefined as SystemAppUpdateStatus | undefined,
}));

const live = vi.hoisted(() => ({
  inventory: null as UpdateInventory | null,
  providerJobs: {
    runningJobKey: null as string | null,
    queuedJobKeys: new Set<string>(),
    failuresByJobKey: new Map<string, unknown>(),
  },
  pluginJobs: [] as PluginUpdateJob[],
  listeners: new Set<() => void>(),
}));

type LiveUpdates = Pick<
  typeof live,
  "inventory" | "providerJobs" | "pluginJobs"
>;

function subscribeToLive(listener: () => void) {
  live.listeners.add(listener);
  return () => {
    live.listeners.delete(listener);
  };
}

function setLive(change: Partial<LiveUpdates>) {
  act(() => {
    Object.assign(live, change);
    for (const listener of live.listeners) listener();
  });
}

vi.mock("@/hooks/useUpdateInventory", () => ({
  useUpdateInventory: () =>
    useSyncExternalStore(subscribeToLive, () => live.inventory),
}));

vi.mock("@/components/provider-cli/provider-cli-install", async (original) => ({
  ...(await original<
    typeof import("@/components/provider-cli/provider-cli-install")
  >()),
  useProviderCliInstallRunner: () => ({
    ...useSyncExternalStore(subscribeToLive, () => live.providerJobs),
    startInstall: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/app-update-queries", () => ({
  useAppUpdateStatus: () => ({ data: appUpdateState.status }),
}));

vi.mock("@/hooks/queries/plugin-update-job-queries", () => ({
  usePluginUpdateJobs: () => ({
    data: useSyncExternalStore(subscribeToLive, () => live.pluginJobs),
  }),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  live.inventory = null;
  live.providerJobs = {
    runningJobKey: null,
    queuedJobKeys: new Set(),
    failuresByJobKey: new Map(),
  };
  live.pluginJobs = [];
  appUpdateState.status = undefined;
});

const UPDATE_ACTION: ProviderCliInstallAction = {
  kind: "update",
  label: "Update",
  command: "npm install -g example",
};

function providerIssue(
  provider: ProviderCliKey,
  displayName: string,
  action: ProviderCliInstallAction | null = UPDATE_ACTION,
): ProviderCliIssue {
  return {
    provider,
    status: {
      displayName,
      executableName: provider,
      executablePath: `/usr/local/bin/${provider}`,
      installed: true,
      installSource: "npmGlobal",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      minimumSupportedVersion: "1.0.0",
      npmPackageName: `@example/${provider}`,
      npmGlobalPackageVersion: "1.0.0",
      installAction: action,
      needsUpdate: true,
      versionUnsupported: false,
    },
    action,
    title: `${displayName} update available`,
    description: "1.0.0 -> 1.1.0",
    fingerprint: `${provider}:outdated`,
  };
}

function missingInstallIssue(
  provider: ProviderCliKey,
  displayName: string,
): ProviderCliIssue {
  return {
    provider,
    status: {
      displayName,
      executableName: provider,
      executablePath: null,
      installed: false,
      installSource: "notInstalled",
      currentVersion: null,
      latestVersion: "1.1.0",
      minimumSupportedVersion: null,
      npmPackageName: `@example/${provider}`,
      npmGlobalPackageVersion: null,
      installAction: null,
      needsUpdate: false,
      versionUnsupported: false,
    },
    action: null,
    title: `${displayName} CLI not installed`,
    description: `Install ${displayName} so bb can start ${displayName} sessions.`,
    fingerprint: `${provider}:missing:1.1.0`,
  };
}

function host(id: string): Host {
  return makeHost({ id, name: id });
}

function machine(
  overrides: Partial<UpdateInventoryMachine>,
): UpdateInventoryMachine {
  return {
    host: host("host-1"),
    isPrimary: true,
    providerStatus: null,
    statusPending: false,
    statusFetching: false,
    statusError: false,
    issues: [],
    canRetryDaemonUpdate: false,
    ...overrides,
  };
}

function plugin(id: string) {
  return makePluginListItem({
    id,
    name: id,
    version: "1.0.0",
    source: `npm:@acme/${id}@^1.0.0`,
  });
}

function appUpdateStatus(
  overrides: Partial<SystemAppUpdateStatus> = {},
): SystemAppUpdateStatus {
  return {
    activity: { phase: "idle" },
    available: {
      behindSince: null,
      channel: "latest",
      commit: null,
      commitCount: null,
      subjects: [],
      version: "0.49.0",
    },
    blocked: null,
    current: { commit: null, version: "0.48.2" },
    lastResult: null,
    autoUpdate: true,
    availableSkipped: false,
    runningThreadCount: 0,
    scheduled: null,
    support: { kind: "supported", mode: "npm" },
    ...overrides,
  };
}

const NO_PLUGIN_UPDATES: UpdateInventory["plugins"] = {
  trackedCount: 0,
  items: [],
};

function inventory(overrides: Partial<UpdateInventory>): UpdateInventory {
  return {
    isLoading: false,
    systemVersion: undefined,
    desktopInfo: null,
    appUpdateAvailable: false,
    desktopUpdateReady: false,
    machines: [],
    plugins: NO_PLUGIN_UPDATES,
    pluginAttentionCount: 0,
    actionableCount: 0,
    hasAttention: false,
    lastCheckedAt: null,
    ...overrides,
  };
}

function renderBadge(overrides: Partial<UpdateInventory>) {
  live.inventory = inventory(overrides);
  const { wrapper } = createQueryClientTestHarness();
  return render(<BadgeHarness />, { wrapper });
}

function BadgeHarness() {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <SidebarProvider>
          <SidebarUpdatesBadge />
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>
  );
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

describe("SidebarUpdatesBadge", () => {
  it("renders nothing when no update needs attention", () => {
    renderBadge({});
    expect(screen.queryAllByTestId(/^sidebar-updates-badge-/)).toHaveLength(0);
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
  });

  it("draws each kind of update as a separate chip that opens Settings › Updates", () => {
    appUpdateState.status = appUpdateStatus();
    renderBadge({
      appUpdateAvailable: true,
      machines: [machine({ issues: [providerIssue("codex", "Codex")] })],
      plugins: {
        trackedCount: 2,
        items: [
          { kind: "update", plugin: plugin("linear"), version: "1.2.0" },
          {
            kind: "blocked",
            plugin: plugin("legacy"),
            version: "2.0.0",
            reasons: ["engines.bb requires >=9.0.0"],
          },
        ],
      },
    });

    expect(screen.getAllByRole("link")).toHaveLength(3);
    for (const [name, icon] of [
      ["bb update available", "Download"],
      ["Codex update available", "Download"],
      ["1 plugin update available", "Plug02"],
    ]) {
      const chip = screen.getByRole("link", { name });
      expect(chip.getAttribute("href")).toBe("/settings/updates");
      expect(chip.querySelector(`[data-icon="${icon}"]`)).toBeTruthy();
    }
  });

  it("renders plain Settings › Updates links with no hover card or touch popover", async () => {
    appUpdateState.status = appUpdateStatus();
    live.inventory = inventory({
      appUpdateAvailable: true,
      machines: [machine({ issues: [providerIssue("codex", "Codex")] })],
      plugins: {
        trackedCount: 1,
        items: [{ kind: "update", plugin: plugin("linear"), version: "1.2.0" }],
      },
    });
    const onNavigate = vi.fn();
    const { wrapper } = createQueryClientTestHarness();
    const view = render(
      <MemoryRouter>
        <TooltipProvider>
          <SidebarProvider>
            <SidebarUpdatesBadge onNavigate={onNavigate} />
          </SidebarProvider>
          <LocationProbe />
        </TooltipProvider>
      </MemoryRouter>,
      { wrapper },
    );

    const providerChip = screen.getByTestId("sidebar-updates-badge-providers");
    expect(providerChip.tagName).toBe("A");
    expect(providerChip.getAttribute("href")).toBe("/settings/updates");
    fireEvent.focus(providerChip);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByTestId("sidebar-update-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update all" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Details" })).toBeNull();
    view.unmount();

    const compact = createQueryClientTestHarness();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <MemoryRouter>
          <TooltipProvider>
            <SidebarProvider>
              <SidebarUpdatesBadge onNavigate={onNavigate} />
            </SidebarProvider>
            <LocationProbe />
          </TooltipProvider>
        </MemoryRouter>
      </CompactViewportOverrideProvider>,
      { wrapper: compact.wrapper },
    );

    const compactChip = screen.getByTestId("sidebar-updates-badge-providers");
    expect(compactChip.tagName).toBe("A");
    expect(compactChip.getAttribute("href")).toBe("/settings/updates");
    fireEvent.click(compactChip);
    expect(screen.queryByTestId("sidebar-update-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update all" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Details" })).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe(
      "/settings/updates",
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("spins while updates run and restores icons when settled", () => {
    live.providerJobs = {
      ...live.providerJobs,
      runningJobKey: "host-1:claude-code",
    };
    live.pluginJobs = [
      {
        id: "job-1",
        pluginId: "linear",
        displayName: "linear",
        state: "running",
        phase: "activating",
      },
    ];
    renderBadge({
      machines: [
        machine({ issues: [providerIssue("claude-code", "Claude Code")] }),
      ],
      plugins: {
        trackedCount: 1,
        items: [{ kind: "update", plugin: plugin("linear"), version: "1.2.0" }],
      },
    });

    const providerChip = screen.getByTestId("sidebar-updates-badge-providers");
    const pluginChip = screen.getByTestId("sidebar-updates-badge-plugins");
    expect(providerChip.getAttribute("aria-label")).toBe(
      "Claude Code update available",
    );
    const providerSpinner = providerChip.querySelector('[data-icon="Loading"]');
    expect(providerSpinner?.classList.contains("animate-spin")).toBe(true);
    expect(pluginChip.querySelector('[data-icon="Loading"]')).toBeTruthy();
    expect(screen.queryByTestId("sidebar-updates-badge-bb")).toBeNull();

    setLive({
      providerJobs: { ...live.providerJobs, runningJobKey: null },
      pluginJobs: [],
    });
    expect(providerChip.querySelector('[data-icon="Download"]')).toBeTruthy();
    expect(pluginChip.querySelector('[data-icon="Plug02"]')).toBeTruthy();
  });

  it("spins only the provider chip during a provider update", () => {
    live.providerJobs = {
      ...live.providerJobs,
      runningJobKey: "host-1:claude-code",
    };
    renderBadge({
      machines: [
        machine({ issues: [providerIssue("claude-code", "Claude Code")] }),
      ],
    });

    expect(
      screen
        .getByTestId("sidebar-updates-badge-providers")
        .querySelector('[data-icon="Loading"]'),
    ).toBeTruthy();
    expect(screen.queryByTestId("sidebar-updates-badge-plugins")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-bb")).toBeNull();
  });

  it("spins only the plugin chip during a plugin update", () => {
    live.pluginJobs = [
      {
        id: "job-1",
        pluginId: "linear",
        displayName: "linear",
        state: "running",
        phase: "activating",
      },
    ];
    renderBadge({
      plugins: {
        trackedCount: 1,
        items: [{ kind: "update", plugin: plugin("linear"), version: "1.2.0" }],
      },
    });

    expect(
      screen
        .getByTestId("sidebar-updates-badge-plugins")
        .querySelector('[data-icon="Loading"]'),
    ).toBeTruthy();
    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-bb")).toBeNull();
  });

  it("spins the bb chip while bb is restarting", () => {
    appUpdateState.status = appUpdateStatus({
      activity: {
        phase: "restarting",
        startedAt: "2026-11-06T23:00:00.000Z",
        targetCommit: null,
        targetVersion: "0.49.0",
      },
    });
    renderBadge({ appUpdateAvailable: true });

    const bbChip = screen.getByTestId("sidebar-updates-badge-bb");
    expect(bbChip.getAttribute("aria-label")).toBe("bb update available");
    expect(bbChip.querySelector('[data-icon="Loading"]')).toBeTruthy();
  });

  it("ignores missing CLIs when deciding whether to render the provider chip", () => {
    renderBadge({
      appUpdateAvailable: true,
      machines: [
        machine({
          issues: [missingInstallIssue("claude-code", "Claude Code")],
        }),
      ],
    });

    expect(screen.getByTestId("sidebar-updates-badge-bb")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
  });

  it("shows only the bb chip for a bb-only update", async () => {
    renderBadge({ appUpdateAvailable: true });

    const badge = screen.getByTestId("sidebar-updates-badge-bb");
    expect(badge.classList.contains("text-muted-foreground")).toBe(true);
    const glyph = badge.querySelector("[data-icon-root]");
    expect(glyph?.classList.contains("text-muted-foreground")).toBe(true);
    expect(glyph?.classList.contains("size-4")).toBe(true);
    expect(glyph?.getAttribute("style")).toBeNull();
    expect(badge.classList.contains("rounded-full")).toBe(false);
    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
    expect(screen.getByRole("link", { name: "bb update available" })).toBe(
      badge,
    );
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => badge.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "bb update available",
    );
  });

  it("acknowledges offline machines across reloads without suppressing real updates", () => {
    const offline = machine({
      host: makeHost({
        id: "offline",
        name: "Work laptop",
        status: "disconnected",
        lastSeenAt: 100,
        lastRejectedProtocolVersion: 1,
      }),
      canRetryDaemonUpdate: true,
    });
    renderBadge({ machines: [offline] });
    expect(screen.queryAllByTestId(/^sidebar-updates-badge-/)).toHaveLength(0);
    const warning = screen.getByRole("link", {
      name: "Work laptop is offline",
    });
    expect(warning.getAttribute("href")).toBe("/settings/machines");
    fireEvent.click(warning);
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
    cleanup();

    renderBadge({ isLoading: true });
    setLive({
      inventory: inventory({
        machines: [
          {
            ...offline,
            host: { ...offline.host, lastRejectedProtocolVersion: 2 },
          },
        ],
        appUpdateAvailable: true,
      }),
    });
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
    expect(screen.getAllByTestId(/^sidebar-updates-badge-/)[0]).toBeTruthy();
    cleanup();

    renderBadge({
      machines: [{ ...offline, host: { ...offline.host, lastSeenAt: 200 } }],
    });
    expect(screen.getByTestId("sidebar-machines-attention-badge")).toBeTruthy();
  });

  it("keeps acknowledged hosts quiet when peers recover and reports new issues", () => {
    const first = machine({
      host: makeHost({ id: "first", status: "disconnected" }),
    });
    const second = machine({
      host: makeHost({ id: "second", status: "disconnected" }),
    });
    renderBadge({ machines: [first, second] });
    fireEvent.click(screen.getByRole("link", { name: "Machines offline" }));
    setLive({ inventory: inventory({ machines: [first] }) });
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();

    setLive({
      inventory: inventory({
        machines: [
          first,
          { ...second, host: { ...second.host, status: "connected" } },
        ],
      }),
    });
    setLive({ inventory: inventory({ machines: [first, second] }) });
    expect(screen.getByRole("link", { name: "Machines offline" })).toBeTruthy();
  });

  it("does not warn about intentionally paused machines or ephemeral hosts", () => {
    const paused = makeHost({ status: "disconnected" });
    paused.lifecycle.phase = "suspended";
    renderBadge({
      machines: [
        machine({ host: paused }),
        machine({
          host: makeHost({ status: "disconnected", type: "ephemeral" }),
        }),
      ],
    });
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
  });

  it("shows the outline download icon and distinct provider count across machines", () => {
    renderBadge({
      appUpdateAvailable: true,
      machines: [
        machine({
          host: host("host-1"),
          issues: [providerIssue("claude-code", "Claude Code")],
        }),
        machine({
          host: host("host-2"),
          issues: [
            providerIssue("claude-code", "Claude Code"),
            providerIssue("codex", "Codex"),
          ],
        }),
      ],
    });

    const providerChip = screen.getByTestId("sidebar-updates-badge-providers");
    expect(providerChip.getAttribute("aria-label")).toBe(
      "Claude Code and Codex updates available",
    );
    expect(providerChip.querySelector('[data-icon="Download"]')).not.toBeNull();
    expect(providerChip.querySelector("[data-provider-icon]")).toBeNull();
    expect(providerChip.textContent).toBe("2");
    expect(screen.getByTestId("sidebar-updates-badge-bb")).toBeTruthy();
  });
});
