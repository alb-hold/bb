import {
  StaticPageShell,
  renderPageShellFooter,
  type PageShellBaseProps,
} from "./page-shell-static";
import { BottomAnchoredScrollBody } from "./bottom-anchored-scroll-body.js";
import { CONTENT_MEASURE_MAX_WIDTH_CLASS } from "@/lib/content-measure";
import { cn } from "@bb/shared-ui/lib/utils";

type PageShellScrollBehavior = "bottom-anchor" | "static";

interface PageShellProps extends PageShellBaseProps {
  scrollBehavior?: PageShellScrollBehavior;
  scrollAnchorThreadId?: string;
  scrollAnchorMode?: "restore" | "latest";
  scrollContentInsetEndPx?: number;
}

const SHELL_BLEED_CLASS =
  "-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5";
const ANCHORED_FOOTER_BOTTOM_PADDING_CLASS =
  "pb-[max(0px,calc(1rem-var(--bb-content-bottom-inset,0px)))]";
const DEFAULT_MAX_WIDTH_CLASS = CONTENT_MEASURE_MAX_WIDTH_CLASS;

export function PageShell({
  children,
  footer,
  scrollOverlay,
  shellClassName,
  scrollAreaClassName,
  contentClassName,
  footerClassName,
  maxWidthClassName = DEFAULT_MAX_WIDTH_CLASS,
  scrollBehavior = "static",
  scrollAnchorThreadId,
  scrollAnchorMode,
  scrollContentInsetEndPx,
}: PageShellProps) {
  if (scrollBehavior === "bottom-anchor") {
    const staticFooter = renderPageShellFooter(footer, {
      maxWidthClassName,
      bottomPaddingClassName: ANCHORED_FOOTER_BOTTOM_PADDING_CLASS,
      footerClassName,
    });
    return (
      <div className={cn(SHELL_BLEED_CLASS, shellClassName)}>
        <BottomAnchoredScrollBody
          scrollAreaClassName={scrollAreaClassName}
          contentClassName={contentClassName}
          maxWidthClassName={maxWidthClassName}
          footer={staticFooter}
          scrollOverlay={scrollOverlay}
          scrollAnchorThreadId={scrollAnchorThreadId}
          scrollAnchorMode={scrollAnchorMode}
          contentInsetEndPx={scrollContentInsetEndPx}
        >
          {children}
        </BottomAnchoredScrollBody>
      </div>
    );
  }

  return (
    <StaticPageShell
      footer={footer}
      shellClassName={shellClassName}
      scrollAreaClassName={scrollAreaClassName}
      contentClassName={contentClassName}
      footerClassName={footerClassName}
      maxWidthClassName={maxWidthClassName}
    >
      {children}
    </StaticPageShell>
  );
}
