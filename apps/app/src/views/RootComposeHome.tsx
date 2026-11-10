import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { PAGE_SHELL_CONTENT_STYLE } from "@/components/ui/page-shell-content-style.js";
import { CONTENT_MEASURE_MAX_WIDTH_CLASS } from "@/lib/content-measure";
import { ComposerMaxHeightContext } from "@/components/promptbox/composer-max-height";
import { composerRootWithin } from "@/lib/pane-composer-focus";
const COMPACT_HOME_CHROME_OFFSET_PX = 56;
const COMPACT_HOME_COLUMN_CLASS = `mx-auto w-full ${CONTENT_MEASURE_MAX_WIDTH_CLASS} px-4`;
const ROOT_COMPOSE_MAX_WIDTH_CLASS = CONTENT_MEASURE_MAX_WIDTH_CLASS;
const COMPACT_HOME_SCROLL_CLEARANCE_CLASS =
  "pb-[calc(1rem+env(safe-area-inset-bottom))]";

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
  const [composerMaxHeight, setComposerMaxHeight] = useState<number>();

  useLayoutEffect(() => {
    if (!isCompact) return;
    const region = regionRef.current;
    const composer = composerRef.current;
    const scrollViewport = scrollViewportRef.current;
    const scrollContent = scrollContentRef.current;
    if (!region || !composer || !scrollViewport || !scrollContent) {
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
      scrollViewport.style.bottom = `${composerHeight}px`;
      updateScrollCue();
    };
    measure();
    scrollViewport.addEventListener("scroll", updateScrollCue, {
      passive: true,
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(region);
    observer?.observe(composer);
    observer?.observe(scrollContent);
    return () => {
      observer?.disconnect();
      scrollViewport.removeEventListener("scroll", updateScrollCue);
    };
  }, [isCompact]);

  return {
    regionRef,
    composerRef,
    scrollViewportRef,
    scrollContentRef,
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
    composerMaxHeight,
  } = useCompactHomeMetrics(isCompact);

  return (
    <div
      className={
        isCompact
          ? "@container/page flex min-h-0 flex-1 flex-col"
          : "@container/page grid min-h-0 flex-1 grid-rows-[minmax(0,0.38fr)_auto_minmax(0,0.62fr)] overflow-y-auto"
      }
      style={isCompact ? PAGE_SHELL_CONTENT_STYLE : undefined}
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
              className="flex min-h-full flex-col"
            >
              <div
                data-testid="root-compose-compact-scroll-column"
                className={cn(
                  COMPACT_HOME_COLUMN_CLASS,
                  COMPACT_HOME_SCROLL_CLEARANCE_CLASS,
                )}
              >
                {compactScrollContent}
                {homepageSections}
              </div>
            </div>
          </div>
        ) : null}
        <div
          ref={composerRef}
          data-testid="root-compose-compact-composer"
          className={
            isCompact
              ? "absolute inset-x-0 bottom-0 z-10 flex max-h-[calc(100%-3.5rem)] flex-col"
              : undefined
          }
        >
          {!isCompact ? (
            <p className="mb-6 text-center text-xl font-medium text-foreground">
              Start a new thread
            </p>
          ) : null}
          <div
            className={
              isCompact
                ? "min-h-0 overflow-y-auto bg-background pb-4"
                : undefined
            }
          >
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
  );
}
