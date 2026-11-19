import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { OverflowFade } from "@bb/shared-ui/overflow-fade";
import { observeSharedResize } from "@bb/shared-ui/lib/shared-resize-observer";
import { cn } from "@bb/shared-ui/lib/utils";
import { PAGE_SHELL_CONTENT_STYLE } from "@/components/ui/page-shell-content-style.js";
import { ComposerMaxHeightContext } from "@/components/promptbox/composer-max-height";
import { composerRootWithin } from "@/lib/pane-composer-focus";
import {
  MOBILE_RECENT_LABEL_HEIGHT_PX,
  MOBILE_RECENT_ROW_HEIGHT_PX,
} from "./RootComposeMobileRecents";
const COMPACT_HOME_CHROME_OFFSET_PX = 56;
const COMPACT_HOME_COLUMN_CLASS = "mx-auto w-full max-w-[760px] px-4";
const ROOT_COMPOSE_MAX_WIDTH_CLASS = "max-w-[760px]";
const COMPACT_HOME_REST_BAND_PX =
  4.5 * MOBILE_RECENT_ROW_HEIGHT_PX + MOBILE_RECENT_LABEL_HEIGHT_PX;

export function getCompactHomeLeadingSpace({
  regionHeight,
  composerHeight,
}: {
  regionHeight: number;
  composerHeight: number;
}): number {
  return Math.max(
    MOBILE_RECENT_ROW_HEIGHT_PX,
    regionHeight -
      composerHeight -
      COMPACT_HOME_REST_BAND_PX -
      COMPACT_HOME_CHROME_OFFSET_PX,
  );
}

interface RootComposeHomeProps {
  isCompact: boolean;
  composer: ReactNode;
  compactScrollContent: ReactNode;
  homepageSections: ReactNode;
  wideContentClassName?: string;
}

function useCompactHomeMetrics(isCompact: boolean) {
  const regionRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const leadingSpacerRef = useRef<HTMLDivElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);
  const composerFadeRef = useRef<HTMLDivElement>(null);
  const [composerMaxHeight, setComposerMaxHeight] = useState<number>();

  useLayoutEffect(() => {
    if (!isCompact) return;
    const region = regionRef.current;
    const composer = composerRef.current;
    const scrollViewport = scrollViewportRef.current;
    const scrollContent = scrollContentRef.current;
    const leadingSpacer = leadingSpacerRef.current;
    const bottomSpacer = bottomSpacerRef.current;
    const composerFade = composerFadeRef.current;
    if (
      !region ||
      !composer ||
      !scrollViewport ||
      !scrollContent ||
      !leadingSpacer ||
      !bottomSpacer ||
      !composerFade
    ) {
      return;
    }
    const updateScrollCue = () => {
      scrollViewport.toggleAttribute(
        "data-more-above",
        scrollViewport.scrollTop > 1,
      );
      scrollViewport.toggleAttribute(
        "data-more-below",
        scrollViewport.scrollTop + scrollViewport.clientHeight <
          scrollViewport.scrollHeight - 1,
      );
    };
    const measure = () => {
      updateScrollCue();
      const composerRoot = composerRootWithin(composer);
      if (composerRoot) {
        const surroundingHeight =
          composer.offsetHeight - composerRoot.offsetHeight;
        setComposerMaxHeight(
          region.offsetHeight -
            COMPACT_HOME_CHROME_OFFSET_PX -
            surroundingHeight,
        );
      }
      const composerHeight = composer.offsetHeight;
      leadingSpacer.style.height = `${getCompactHomeLeadingSpace({
        regionHeight: region.offsetHeight,
        composerHeight,
      })}px`;
      bottomSpacer.style.height = `${composerHeight}px`;
      composerFade.hidden =
        scrollViewport.scrollHeight <= scrollViewport.clientHeight;
    };
    measure();
    scrollViewport.addEventListener("scroll", updateScrollCue, { passive: true });
    const unobserve =
      typeof ResizeObserver === "undefined"
        ? undefined
        : observeSharedResize([region, composer, scrollContent], {
            read: () => undefined,
            write: measure,
          });
    return () => {
      scrollViewport.removeEventListener("scroll", updateScrollCue);
      unobserve?.();
    };
  }, [isCompact]);

  return {
    regionRef,
    composerRef,
    scrollViewportRef,
    scrollContentRef,
    leadingSpacerRef,
    bottomSpacerRef,
    composerFadeRef,
    composerMaxHeight,
  };
}

export function RootComposeHome({
  isCompact,
  composer,
  compactScrollContent,
  homepageSections,
  wideContentClassName,
}: RootComposeHomeProps) {
  const {
    regionRef,
    composerRef,
    scrollViewportRef,
    scrollContentRef,
    leadingSpacerRef,
    bottomSpacerRef,
    composerFadeRef,
    composerMaxHeight,
  } = useCompactHomeMetrics(isCompact);

  return (
    <div
      className={
        isCompact
          ? "flex min-h-0 flex-1 flex-col"
          : "grid min-h-0 flex-1 grid-rows-[minmax(0,0.38fr)_auto_minmax(0,0.62fr)] overflow-y-auto"
      }
      style={isCompact ? PAGE_SHELL_CONTENT_STYLE : undefined}
    >
      <div
        className={
          isCompact
            ? "@container/page flex min-h-0 flex-1 flex-col"
            : "@container/page grid grid-rows-[minmax(0,0.38fr)_auto_minmax(0,0.62fr)]"
        }
      >
      <div
        ref={regionRef}
        data-testid="root-compose-compact-home"
        className={
          isCompact
            ? "relative min-h-0 flex-1"
            : cn(
                "row-start-2 mx-auto flex w-full shrink-0 flex-col px-4 py-8",
                ROOT_COMPOSE_MAX_WIDTH_CLASS,
                wideContentClassName,
              )
        }
        style={isCompact ? undefined : PAGE_SHELL_CONTENT_STYLE}
      >
        {isCompact ? (
          <div
            ref={scrollViewportRef}
            data-testid="root-compose-compact-scroll-viewport"
            data-page-scroll-viewport=""
            className="absolute inset-x-0 bottom-0 overflow-y-auto overscroll-contain"
            style={{ top: COMPACT_HOME_CHROME_OFFSET_PX }}
          >
            <div
              ref={scrollContentRef}
              data-testid="root-compose-compact-scroll-content"
              className="flex min-h-full flex-col justify-end"
            >
              <div
                ref={leadingSpacerRef}
                aria-hidden
                data-testid="root-compose-compact-leading-spacer"
              />
              <div className={COMPACT_HOME_COLUMN_CLASS}>
                {compactScrollContent}
                {homepageSections}
              </div>
              <div
                ref={bottomSpacerRef}
                aria-hidden
                data-testid="root-compose-compact-bottom-spacer"
              />
            </div>
          </div>
        ) : null}
        <div
          ref={composerRef}
          data-testid="root-compose-compact-composer"
          className={
            isCompact ? "absolute inset-x-0 bottom-0 z-10" : undefined
          }
        >
          {!isCompact ? (
            <p className="mb-6 text-center text-xl font-medium text-foreground">
              Start a new thread
            </p>
          ) : null}
          <div ref={composerFadeRef} data-testid="root-compose-compact-fade">
            {isCompact ? (
              <OverflowFade placement="above" tone="background" size="lg" />
            ) : null}
          </div>
          <div className={isCompact ? "bg-background pb-4" : undefined}>
            <div className={isCompact ? COMPACT_HOME_COLUMN_CLASS : undefined}>
              <ComposerMaxHeightContext.Provider
                value={isCompact ? composerMaxHeight : undefined}
              >
                {composer}
              </ComposerMaxHeightContext.Provider>
            </div>
          </div>
        </div>
        {!isCompact ? (
          <div
            className="mt-6 empty:hidden"
            data-testid="root-compose-desktop-recents"
          >
            {compactScrollContent}
          </div>
        ) : null}
        {isCompact ? null : homepageSections}
      </div>
      </div>
    </div>
  );
}
