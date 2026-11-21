import { BbDiffSplit } from "@/components/code/BbDiffSplit";
import { BbSourceCodeSplit } from "@/components/code/BbSourceCodeSplit";
import { useEffect } from "react";
import {
  useDiffRendererReplacement,
  useSourceCodeRendererReplacement,
} from "@/components/code/codeRendererProvider";
import { usePluginFrontendBootComplete } from "@/lib/plugin-frontend-boot-state";
import { queueSplitPreload } from "@/lib/split-prefetch";

function preloadLazyPluginRenderers(
  warmDiff: boolean,
  warmSource: boolean,
): Promise<[false | void, false | void]> {
  return import("@/components/plugin/lazy-plugin-renderers").then(
    ({ LazyPluginDiff, LazyPluginSourceCode }) =>
      Promise.all([
        warmDiff && LazyPluginDiff.preload(),
        warmSource && LazyPluginSourceCode.preload(),
      ]),
  );
}

export function useCodeRendererPreloads(): void {
  const bootComplete = usePluginFrontendBootComplete();
  const warmDiff = useDiffRendererReplacement().kind === "owner";
  const warmSource = useSourceCodeRendererReplacement().kind === "owner";

  useEffect(() => {
    if (!bootComplete || (!warmDiff && !warmSource)) return;
    let cancelled = false;
    const onIntent = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest("[data-sidebar-thread-id]")) return;
      queueSplitPreload(async () => {
        if (cancelled) return;
        await Promise.all([
          warmDiff && BbDiffSplit.preload(),
          warmSource && BbSourceCodeSplit.preload(),
          preloadLazyPluginRenderers(warmDiff, warmSource),
        ]).catch(() => undefined);
      });
    };
    document.addEventListener("pointerover", onIntent);
    document.addEventListener("focusin", onIntent);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerover", onIntent);
      document.removeEventListener("focusin", onIntent);
    };
  }, [bootComplete, warmDiff, warmSource]);
}
