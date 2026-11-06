import {
  definePluginApp,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PreferencesSync } from "./app/preferences/PreferencesSync.js";
import { SidebarListVisibleContext } from "./app/list/useSidebarListShown.js";
import { ProjectList } from "./app/list/ProjectList.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";
import { moveThreadAction } from "./app/rows/moveThreadAction.js";
import { ThreadSelectionProvider } from "./app/selection/threadSelection.js";
import { SidebarRowMetadataExperiment } from "./app/list/SidebarRowMetadataExperiment.js";

function ThreadList({
  activeThreadId,
  isCompactViewport,
  experimental_isVisible = true,
  onNavigate,
}: PluginThreadListProps) {
  useSidebarThreadReveal();
  return (
    <SidebarListVisibleContext.Provider value={experimental_isVisible}>
      <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
        <TooltipProvider>
          <PreferencesSync />
          <SidebarRowMetadataExperiment>
            <ThreadSelectionProvider activeThreadId={activeThreadId}>
              <ProjectList
                activeThreadId={activeThreadId}
                onProjectSelect={onNavigate}
              />
            </ThreadSelectionProvider>
          </SidebarRowMetadataExperiment>
        </TooltipProvider>
      </CompactViewportOverrideProvider>
    </SidebarListVisibleContext.Provider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "thread-list",
    title: "Thread list",
    description:
      "Pinned threads, custom sections, projects, machines, and nested threads.",
    component: ThreadList,
  });
  app.slots.experimental_threadAction(moveThreadAction);
});
