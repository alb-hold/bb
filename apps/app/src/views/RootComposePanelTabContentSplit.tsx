import { SecondaryPanelContentSkeleton } from "@/components/secondary-panel/SecondaryPanelContentSkeleton";
import { defineSplit } from "@/lib/define-split";
export const RootComposePanelTabContent = defineSplit({
  id: "root-compose-panel-tab-content",
  tier: "intent",
  load: () =>
    import("./RootComposePanelTabContent").then(
      (module) => module.RootComposePanelTabContent,
    ),
  loading: SecondaryPanelContentSkeleton,
});
