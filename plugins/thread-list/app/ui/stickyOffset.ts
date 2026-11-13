import { createContext, useContext } from "react";

export interface StickyOffset {
  growingRowsHeightPx: number;
  growingRowCount: number;
}

const NO_STICKY_OFFSET: StickyOffset = {
  growingRowsHeightPx: 0,
  growingRowCount: 0,
};

const StickyOffsetContext = createContext<StickyOffset>(NO_STICKY_OFFSET);

export interface StickyRowStateReporter {
  report(id: string, rowHeightPx: number): void;
  remove(id: string): void;
}

const StickyRowStateReportContext =
  createContext<StickyRowStateReporter | null>(null);

export const StickyOffsetProvider = StickyOffsetContext.Provider;

export const StickyRowStateReportProvider =
  StickyRowStateReportContext.Provider;

export function useStickyOffset(): StickyOffset {
  return useContext(StickyOffsetContext);
}

export function useStickyRowStateReport(): StickyRowStateReporter | null {
  return useContext(StickyRowStateReportContext);
}

export function createStickyRowStateReporter(
  rowHeights: Map<string, number>,
  setHeight: (rowHeightPx: number) => void,
): StickyRowStateReporter {
  return {
    report(id, rowHeightPx) {
      if (rowHeightPx > 0) rowHeights.set(id, rowHeightPx);
      else rowHeights.delete(id);
      setHeight(Math.max(0, ...rowHeights.values()));
    },
    remove(id) {
      rowHeights.delete(id);
      setHeight(Math.max(0, ...rowHeights.values()));
    },
  };
}

export function addGrowingRow(
  inherited: StickyOffset,
  rowHeightPx: number,
): StickyOffset {
  if (rowHeightPx <= 0) return inherited;
  return {
    growingRowsHeightPx: inherited.growingRowsHeightPx + rowHeightPx,
    growingRowCount: inherited.growingRowCount + 1,
  };
}

export function stickyOffsetCss(offset: StickyOffset): string {
  if (offset.growingRowCount === 0) return "0px";
  return `calc(${offset.growingRowsHeightPx}px - ${offset.growingRowCount} * var(--bb-sidebar-sticky-row-height))`;
}
