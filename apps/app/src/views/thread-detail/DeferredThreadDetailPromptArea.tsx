import { useEffect, useState, type ComponentProps } from "react";
import { defineSplit } from "@/lib/define-split";
import { requestBrowserIdle } from "@/lib/plugin-frontend-boot-schedule";
import type { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";

const PromptArea = defineSplit({
  id: "thread-detail-prompt-area",
  tier: "intent",
  load: () =>
    import("./ThreadDetailPromptArea").then(
      (module) => module.ThreadDetailPromptArea,
    ),
  loading: () => null,
});

export function DeferredThreadDetailPromptArea(
  props: ComponentProps<typeof ThreadDetailPromptArea>,
) {
  const [ready, setReady] = useState(PromptArea.isLoaded);
  useEffect(() => {
    if (ready) return;
    let cancelIdle: (() => void) | null = null;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        cancelIdle = requestBrowserIdle(() => setReady(true));
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelIdle?.();
    };
  }, [ready]);
  return ready ? <PromptArea {...props} /> : null;
}
