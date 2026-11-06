import { defineSplit } from "@/lib/define-split";
import { ComposerPlaceholder } from "./ComposerPlaceholder";

export const ProgressiveComposer = defineSplit({
  id: "progressive-composer",
  tier: "intent",
  load: () => {
    performance.mark("p41-plain-import-start");
    return import("./ProgressiveComposer").then((module) => {
      performance.mark("p41-plain-import-resolve");
      return module.ProgressiveComposer;
    });
  },
  loading: () => (
    <ComposerPlaceholder state={{ kind: "loading", shape: "new-thread" }} />
  ),
});
