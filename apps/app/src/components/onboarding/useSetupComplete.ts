import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import {
  useSidebarNavigation,
  useSidebarNavigationPreview,
} from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";

export function useSetupComplete(): boolean {
  const settings = useSystemConfig().data?.generalSettings;
  const onboarded =
    settings !== undefined && settings.onboardingCompletedAt !== null;
  const navigationQuery = useSidebarNavigation({ enabled: onboarded });
  const preview = useSidebarNavigationPreview();
  const complete = navigationQuery.isPlaceholderData
    ? undefined
    : navigationQuery.data;
  const navigation = complete ?? preview ?? navigationQuery.data;
  return (
    onboarded &&
    navigation !== undefined &&
    listSidebarNavigationThreads(navigation).length > 0
  );
}
