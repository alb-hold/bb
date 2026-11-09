import {
  NativeThreadDeferredPanel,
  useNativeThreadFrame,
} from "./NativeThreadFrameContext";
import type { ComponentProps } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";

export function ThreadFrameLayout({
  isBoundedPane,
  deferred = false,
  ...props
}: ComponentProps<typeof SecondaryPanelLayout> & {
  isBoundedPane: boolean;
  deferred?: boolean;
}) {
  const frame = useNativeThreadFrame();
  if (frame && deferred)
    return <NativeThreadDeferredPanel renderPanel={props.renderPanel} />;
  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip",
        !isBoundedPane && "-mx-4 -mb-4 -mt-4 md:-mx-5 md:-mb-5 md:-mt-5",
      )}
    >
      <SecondaryPanelLayout {...props} />
    </div>
  );
}
