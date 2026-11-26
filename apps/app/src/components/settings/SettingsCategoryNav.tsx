import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  SectionSidebarIcon,
  SectionSidebarLabel,
} from "@/components/sidebar/SectionSidebar";
import { canOpenNativeScreen, shellOpenNative } from "@/lib/native-shell";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import type { SettingsNavState } from "./settings-nav";
import { getSettingsSectionRoutePath } from "./settings-sections";

export type SettingsCategoryNavigation = Pick<
  SettingsNavState,
  "activePluginId" | "activeSection" | "pluginEntries" | "sections"
>;

function SettingsCategoryRow({
  active,
  children,
  label,
  onSelect,
  to,
}: {
  active: boolean;
  children?: ReactNode;
  label: string;
  onSelect?: () => void;
  to: string;
}) {
  return (
    <Button
      asChild
      size="sm"
      variant="ghost"
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "w-full",
        active && "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      <Link
        to={to}
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
      >
        {children}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </Link>
    </Button>
  );
}

function SettingsCategoryActionRow({
  children,
  label,
  onClick,
  onSelect,
  testId,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  onSelect?: () => void;
  testId?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      data-testid={testId}
      className={cn(PROJECT_LIST_ACTION_BUTTON_CLASS, "w-full")}
      onClick={() => {
        onSelect?.();
        onClick();
      }}
    >
      {children}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </Button>
  );
}

export function SettingsCategoryList({
  navigation,
  nativeDeviceTestId = "settings-nav-native-device",
  onSelect,
}: {
  navigation: SettingsCategoryNavigation;
  nativeDeviceTestId?: string;
  onSelect?: () => void;
}) {
  const { activePluginId, activeSection, pluginEntries, sections } = navigation;
  const hasPlugins = pluginEntries.length > 0;
  const archivedSections = sections.filter(
    (section) => section.id === "archived",
  );

  return (
    <>
      <div className="mt-1 space-y-0.5">
        {sections
          .filter((section) => section.id !== "archived")
          .map((section) => (
            <SettingsCategoryRow
              key={section.id}
              active={activeSection === section.id}
              label={section.label}
              onSelect={onSelect}
              to={getSettingsSectionRoutePath(section.id)}
            >
              <SectionSidebarIcon name={section.icon} />
            </SettingsCategoryRow>
          ))}
      </div>
      {hasPlugins ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Plugins</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {pluginEntries.map((entry) => (
              <SettingsCategoryRow
                key={entry.id}
                active={activePluginId === entry.id}
                label={entry.label}
                onSelect={onSelect}
                to={getPluginConfigurationRoutePath({ pluginId: entry.id })}
              >
                <PluginIcon
                  pluginId={entry.id}
                  icon={entry.icon}
                  className="size-4 shrink-0"
                />
              </SettingsCategoryRow>
            ))}
          </div>
        </>
      ) : null}
      {canOpenNativeScreen() ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>This phone</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            <SettingsCategoryActionRow
              label="This device"
              onClick={() => shellOpenNative("device-settings")}
              onSelect={onSelect}
              testId={nativeDeviceTestId}
            >
              <SectionSidebarIcon name="Smartphone" />
            </SettingsCategoryActionRow>
          </div>
        </>
      ) : null}
      {archivedSections.length > 0 ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Archived</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {archivedSections.map((section) => (
              <SettingsCategoryRow
                key={section.id}
                active={activeSection === section.id}
                label={section.label}
                onSelect={onSelect}
                to={getSettingsSectionRoutePath(section.id)}
              >
                <SectionSidebarIcon name={section.icon} />
              </SettingsCategoryRow>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

export function MobileSettingsCategoryBar({
  className,
  navigation,
}: {
  className?: string;
  navigation: SettingsCategoryNavigation;
}) {
  const [open, setOpen] = useState(false);
  const activePlugin =
    navigation.activePluginId === null
      ? undefined
      : navigation.pluginEntries.find(
          (entry) => entry.id === navigation.activePluginId,
        );
  const activeSectionEntry =
    navigation.activeSection === null
      ? undefined
      : navigation.sections.find(
          (section) => section.id === navigation.activeSection,
        );
  const activeTitle =
    activePlugin?.label ?? activeSectionEntry?.label ?? "Settings";

  return (
    <>
      <div
        data-testid="mobile-settings-category-bar"
        className={cn(
          "flex items-center justify-between gap-3 border-b border-border-hairline pb-3 md:hidden",
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-2 text-foreground">
          {activePlugin ? (
            <PluginIcon
              pluginId={activePlugin.id}
              icon={activePlugin.icon}
              className="size-4 shrink-0"
            />
          ) : activeSectionEntry ? (
            <Icon
              name={activeSectionEntry.icon}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : null}
          <h2 className="min-w-0 truncate text-base font-semibold">
            {activeTitle}
          </h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 shrink-0 gap-1.5 border-border/60 bg-card px-3 text-xs font-medium text-foreground"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <span>Categories</span>
          <Icon
            name="ChevronDown"
            className="size-3.5 text-muted-foreground"
            aria-hidden
          />
        </Button>
      </div>
      <ResponsiveDrawerShell
        open={open}
        onOpenChange={setOpen}
        srLabel="Settings categories"
        contentClassName="max-h-[min(80dvh,42rem)]"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-border-hairline px-4 pb-2.5">
            <p className="text-sm font-semibold text-foreground">Categories</p>
          </div>
          <nav
            aria-label="Settings categories"
            className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          >
            <SettingsCategoryList
              navigation={navigation}
              nativeDeviceTestId="settings-mobile-nav-native-device"
              onSelect={() => setOpen(false)}
            />
          </nav>
        </div>
      </ResponsiveDrawerShell>
    </>
  );
}
