import { useCallback } from "react";

export function usePanelToggle({
  isOpen,
  hasActiveTab,
  close,
  openNewTab,
  reveal,
}: {
  isOpen: boolean;
  hasActiveTab: boolean;
  close: () => void;
  openNewTab: () => void;
  reveal: () => void;
}): () => void {
  return useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    if (!hasActiveTab) openNewTab();
    else reveal();
  }, [close, hasActiveTab, isOpen, openNewTab, reveal]);
}
