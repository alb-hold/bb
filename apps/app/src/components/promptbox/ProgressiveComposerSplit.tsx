import { defineSplit } from "@/lib/define-split";
import { ComposerPlaceholder } from "./ComposerPlaceholder";

export const ProgressiveComposer = defineSplit({
  id: "progressive-composer",
  tier: "intent",
  load: () =>
    import("./ProgressiveComposer").then(
      (module) => module.ProgressiveComposer,
    ),
  loading: () => (
    <ComposerPlaceholder state={{ kind: "loading", shape: "new-thread" }} />
  ),
});
