import { SecondaryPanelMinimumContext } from "@/components/secondary-panel/secondaryPanelSizing";
import { SecondaryPanelWidthPercentAtomContext } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import type { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";

type RenderPanel = ComponentProps<typeof SecondaryPanelLayout>["renderPanel"];
export type NativePanelTarget = {
  node: HTMLDivElement;
  args: Parameters<RenderPanel>[0];
  width: React.ContextType<typeof SecondaryPanelWidthPercentAtomContext>;
  minimum: React.ContextType<typeof SecondaryPanelMinimumContext>;
  setReady: (ready: boolean) => void;
};
export const NativeThreadFrameContext = createContext<{
  panelTarget: NativePanelTarget | null;
  setPanelTarget: (target: NativePanelTarget | null) => void;
  setOpenLink: (handler: MarkdownPreviewLinkHandler | undefined) => void;
} | null>(null);
export const useNativeThreadFrame = () => useContext(NativeThreadFrameContext);
export function NativeThreadDeferredPanel({
  renderPanel,
}: {
  renderPanel: RenderPanel;
}) {
  const target = useNativeThreadFrame()?.panelTarget;
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    target?.setReady(true);
    setReady(target != null);
    return () => target?.setReady(false);
  }, [target]);
  return target && ready
    ? createPortal(
        <SecondaryPanelWidthPercentAtomContext.Provider value={target.width}>
          <SecondaryPanelMinimumContext.Provider value={target.minimum}>
            {renderPanel(target.args)}
          </SecondaryPanelMinimumContext.Provider>
        </SecondaryPanelWidthPercentAtomContext.Provider>,
        target.node,
      )
    : null;
}
export function NativeThreadLinkPublisher({
  onOpenLink,
}: {
  onOpenLink: MarkdownPreviewLinkHandler;
}) {
  const frame = useNativeThreadFrame();
  const setOpenLink = frame?.setOpenLink;
  useLayoutEffect(() => {
    setOpenLink?.(onOpenLink);
    return () => setOpenLink?.(undefined);
  }, [setOpenLink, onOpenLink]);
  return null;
}
