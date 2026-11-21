import { createContext, useContext } from "react";
import type {
  ExperimentalThreadContextCardProps,
  ExperimentalThreadContextKind,
} from "@get-bb/plugin-sdk";
import type {
  CoreThreadContextCardRow,
  CoreThreadContextCardSection,
  ThreadContextCardLayout,
} from "./PluginThreadContextCard";
import type {
  PluginThreadContextCardRowSlot,
  PluginThreadContextCardSectionSlot,
} from "@/lib/plugin-slots";

type ThreadContextCardRowEntry =
  | { owner: "core"; slot: CoreThreadContextCardRow }
  | { owner: "plugin"; slot: PluginThreadContextCardRowSlot };
type ThreadContextCardSectionEntry =
  | { owner: "core"; slot: CoreThreadContextCardSection }
  | { owner: "plugin"; slot: PluginThreadContextCardSectionSlot };

export interface ThreadContextCardPaneState {
  props: ExperimentalThreadContextCardProps;
  rows: readonly ThreadContextCardRowEntry[];
  sections: readonly ThreadContextCardSectionEntry[];
  layout: ThreadContextCardLayout;
  setLayout(layout: ThreadContextCardLayout): void;
  popoverOpen: boolean;
  setPopoverOpen(open: boolean): void;
  cardHasContent: boolean;
  setCardHasContent(hasContent: boolean): void;
  cardRevealed: boolean;
  setCardRevealedForThreadId(threadId: string | null): void;
}

export const ThreadContextCardPaneContext =
  createContext<ThreadContextCardPaneState | null>(null);

export function useThreadContextCardPaneState(): ThreadContextCardPaneState | null {
  const state = useContext(ThreadContextCardPaneContext);
  return state !== null && state.rows.length + state.sections.length > 0
    ? state
    : null;
}

export function useThreadContextKind(): ExperimentalThreadContextKind {
  const state = useThreadContextCardPaneState();
  return state === null || state.layout === "banner" ? "banner" : "card";
}
