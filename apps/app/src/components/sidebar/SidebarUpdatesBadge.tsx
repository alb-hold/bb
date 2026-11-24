import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ProviderCliKey } from "@bb/host-daemon-contract";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import {
  isProviderCliUpdateIssue,
  useProviderCliInstallRunner,
} from "@/components/provider-cli/provider-cli-install";
import { providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar.js";
import { useAppUpdateStatus } from "@/hooks/queries/app-update-queries";
import { usePluginUpdateJobs } from "@/hooks/queries/plugin-update-job-queries";
import { useMachineAttention } from "@/hooks/useMachineAttention";
import { useUpdateInventory } from "@/hooks/useUpdateInventory";
import { getSettingsRoutePath } from "@/lib/route-paths";

interface SidebarUpdatesBadgeProps {
  onNavigate?: () => void;
}

interface UpdateChip {
  kind: "bb" | "providers" | "plugins";
  label: string;
  content: ReactNode;
  icon: "Download" | "Plug02";
  updating: boolean;
}

const CHIP_CLASS =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent";

function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function SidebarUpdatesBadge({ onNavigate }: SidebarUpdatesBadgeProps) {
  const inventory = useUpdateInventory();
  const appUpdate = useAppUpdateStatus().data;
  const providerJobs = useProviderCliInstallRunner();
  const pluginJobs = usePluginUpdateJobs().data ?? [];
  const machineAttention = useMachineAttention(
    inventory.machines.map((machine) => machine.host),
    inventory.isLoading,
  );

  const serverCanApply =
    appUpdate !== undefined &&
    appUpdate.available !== null &&
    appUpdate.blocked === null &&
    (appUpdate.support.kind === "supported" ||
      appUpdate.desktopUpdateSupported === true);
  const bbNeedsAttention =
    inventory.appUpdateAvailable || inventory.desktopUpdateReady;

  const visibleMachines = inventory.machines.filter(
    (machine) =>
      machine.host.status === "connected" &&
      !machine.canRetryDaemonUpdate &&
      !machine.statusError &&
      !machine.statusPending,
  );
  const staleProvidersByKey = new Map<ProviderCliKey, string>();
  let providerUpdateRunning = false;
  for (const machine of visibleMachines) {
    for (const issue of machine.issues) {
      if (!isProviderCliUpdateIssue(issue)) {
        continue;
      }
      if (!staleProvidersByKey.has(issue.provider)) {
        staleProvidersByKey.set(issue.provider, issue.status.displayName);
      }
      const jobKey = providerCliJobKey(machine.host.id, issue.provider);
      if (
        providerJobs.runningJobKey === jobKey ||
        providerJobs.queuedJobKeys.has(jobKey)
      ) {
        providerUpdateRunning = true;
      }
    }
  }
  const staleProviderNames = [...staleProvidersByKey.values()];

  const pluginUpdateItems =
    inventory.plugins?.items.filter((item) => item.kind === "update") ?? [];
  const pluginUpdateRunning = pluginUpdateItems.some((item) => {
    const latestJob = pluginJobs
      .filter((job) => job.pluginId === item.plugin.id)
      .at(-1);
    return latestJob?.state === "queued" || latestJob?.state === "running";
  });

  const chips: UpdateChip[] = [];
  if (bbNeedsAttention || serverCanApply) {
    chips.push({
      kind: "bb",
      label:
        inventory.appUpdateAvailable && inventory.desktopUpdateReady
          ? "bb updates available"
          : "bb update available",
      content: <>bb</>,
      icon: "Download",
      updating: appUpdate !== undefined && appUpdate.activity.phase !== "idle",
    });
  }
  if (staleProviderNames.length > 0) {
    chips.push({
      kind: "providers",
      label: `${joinNames(staleProviderNames)} ${staleProviderNames.length === 1 ? "update" : "updates"} available`,
      content: (
        <span className="tabular-nums">{staleProviderNames.length}</span>
      ),
      icon: "Download",
      updating: providerUpdateRunning,
    });
  }
  if (pluginUpdateItems.length > 0) {
    chips.push({
      kind: "plugins",
      label: `${pluginUpdateItems.length} plugin update${pluginUpdateItems.length === 1 ? "" : "s"} available`,
      content: <>{pluginUpdateItems.length}</>,
      icon: "Plug02",
      updating: pluginUpdateRunning,
    });
  }

  if (chips.length === 0 && machineAttention.label === null) {
    return null;
  }

  const updatesRoutePath = getSettingsRoutePath("updates");

  return (
    <>
      {machineAttention.label !== null ? (
        <SidebarMenuItem className="ml-auto shrink-0">
          <SidebarMenuButton
            asChild
            aria-label={machineAttention.label}
            tooltip={{
              children: machineAttention.label,
              hidden: false,
              side: "top",
            }}
            className={cn(
              SIDEBAR_FOOTER_ACTION_CLASS,
              "text-warning-text hover:text-warning-text",
            )}
          >
            <Link
              to={getSettingsRoutePath("machines")}
              onClick={() => {
                machineAttention.acknowledge();
                onNavigate?.();
              }}
              data-testid="sidebar-machines-attention-badge"
            >
              <Icon name="AlertTriangle" className="size-4" />
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      {chips.length > 0 ? (
        <SidebarMenuItem
          className={cn(
            "flex min-w-0 shrink-0 items-center gap-1",
            machineAttention.label === null && "ml-auto",
          )}
        >
          {chips.map((chip) => (
            <SidebarMenuButton
              key={chip.kind}
              asChild
              tooltip={{
                children: chip.label,
                hidden: false,
                side: "top",
              }}
              className={CHIP_CLASS}
            >
              <Link
                to={updatesRoutePath}
                onClick={onNavigate}
                aria-label={chip.label}
                data-testid={`sidebar-updates-badge-${chip.kind}`}
                data-updating={chip.updating || undefined}
              >
                <Icon
                  name={chip.updating ? "Loading" : chip.icon}
                  className={cn(
                    "size-4 text-muted-foreground",
                    chip.updating && "animate-spin",
                  )}
                />
                {chip.content}
              </Link>
            </SidebarMenuButton>
          ))}
        </SidebarMenuItem>
      ) : null}
    </>
  );
}
