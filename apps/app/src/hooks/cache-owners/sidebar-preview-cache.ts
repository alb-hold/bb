import type { QueryClient } from "@tanstack/react-query";
import type { SidebarBootstrapResponse } from "@bb/server-contract";

export const sidebarNavigationPreviewQueryKey = () =>
  ["sidebarNavigationPreview"] as const;

export function publishSidebarPreview(
  client: QueryClient,
  snapshot: SidebarBootstrapResponse,
) {
  return client.setQueryData<SidebarBootstrapResponse>(
    sidebarNavigationPreviewQueryKey(),
    snapshot,
  );
}

export function clearSidebarPreview(
  client: QueryClient,
  preview: SidebarBootstrapResponse,
) {
  const key = sidebarNavigationPreviewQueryKey();
  if (client.getQueryData(key) === preview) client.setQueryData(key, null);
}
