import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  SIDEBAR_CONTENT_SELECTOR,
  useSidebarContentElementRef,
} from "../ui/sidebar.js";
import {
  encodeSidebarWindowedNavigationEntries,
  SIDEBAR_WINDOWED_NAV_ATTRIBUTE,
  type SidebarWindowedNavigationEntry,
} from "./sidebarThreadShortcuts.js";
import { observeSharedResize } from "@/lib/shared-resize-observer";

const WINDOW_VIEWPORT_MARGIN_PX = 240;
const DEFAULT_ROW_HEIGHT_PX = 30;

interface MeasuredItemHeight {
  height: number;
  rows: number;
}

interface SidebarWindowedItemsProps {
  itemKeys: readonly string[];
  focusItemKey?: string;
  estimateRows: (index: number) => number;
  alwaysMountedKeys?: ReadonlySet<string>;
  getNavigationEntries?: (
    index: number,
  ) => readonly SidebarWindowedNavigationEntry[];
  renderItem: (index: number) => ReactNode;
}

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

function hasLayoutBox(rect: DOMRectReadOnly): boolean {
  return rect.width > 0 || rect.height > 0;
}

function createWindowedItemRefCallback(
  key: string,
  wrapperByKeyRef: { current: Map<string, HTMLDivElement> },
  keyByWrapperRef: { current: Map<Element, string> },
  observerRef: { current: IntersectionObserver | null },
): (node: HTMLDivElement | null) => void {
  return (node) => {
    const previous = wrapperByKeyRef.current.get(key);
    if (previous && previous !== node) {
      keyByWrapperRef.current.delete(previous);
      observerRef.current?.unobserve(previous);
    }
    if (node) {
      wrapperByKeyRef.current.set(key, node);
      keyByWrapperRef.current.set(node, key);
      observerRef.current?.observe(node);
    } else {
      wrapperByKeyRef.current.delete(key);
    }
  };
}

function mergeRealizedKeys(
  previous: ReadonlySet<string>,
  {
    add,
    remove,
    retain,
  }: {
    add?: ReadonlySet<string> | readonly string[];
    remove?: ReadonlySet<string> | readonly string[];
    retain?: ReadonlySet<string>;
  },
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  const current = () => next ?? previous;
  if (retain) {
    for (const key of previous) {
      if (!retain.has(key)) {
        next ??= new Set(previous);
        next.delete(key);
      }
    }
  }
  for (const key of remove ?? EMPTY_KEY_SET) {
    if (current().has(key)) {
      next ??= new Set(previous);
      next.delete(key);
    }
  }
  for (const key of add ?? EMPTY_KEY_SET) {
    if (!current().has(key)) {
      next ??= new Set(previous);
      next.add(key);
    }
  }
  return next ?? previous;
}

export function SidebarWindowedItems({
  itemKeys,
  focusItemKey,
  estimateRows,
  alwaysMountedKeys = EMPTY_KEY_SET,
  getNavigationEntries,
  renderItem,
}: SidebarWindowedItemsProps) {
  "use no memo";
  const scrollElementRef = useSidebarContentElementRef();
  const windowingEnabled = itemKeys.length > 0 && scrollElementRef !== null;

  const [realizedKeys, setRealizedKeys] =
    useState<ReadonlySet<string>>(EMPTY_KEY_SET);
  const [measuredHeights, setMeasuredHeights] = useState<
    ReadonlyMap<string, MeasuredItemHeight>
  >(() => new Map());
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT_PX);
  const wrapperByKeyRef = useRef(new Map<string, HTMLDivElement>());
  const keyByWrapperRef = useRef(new Map<Element, string>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const rowsByKeyRef = useRef(new Map<string, number>());
  const [wrapperRefCallbacks, setWrapperRefCallbacks] = useState(() =>
    new Map(
      itemKeys.map((key) => [
        key,
        createWindowedItemRefCallback(
          key,
          wrapperByKeyRef,
          keyByWrapperRef,
          observerRef,
        ),
      ]),
    ),
  );

  const keySignature = useMemo(() => itemKeys.join("\u0000"), [itemKeys]);

  useLayoutEffect(() => {
    if (!focusItemKey) return;
    const wrapper = wrapperByKeyRef.current.get(focusItemKey);
    const target = wrapper?.querySelector<HTMLElement>(
      "a[data-sidebar-thread-id], button[aria-expanded]",
    );
    target?.focus();
  }, [focusItemKey]);

  useLayoutEffect(() => {
    setWrapperRefCallbacks((previous) => {
      const next = new Map(previous);
      const keys = new Set(itemKeys);
      for (const key of next.keys()) {
        if (!keys.has(key)) next.delete(key);
      }
      for (const key of itemKeys) {
        if (!next.has(key)) {
          next.set(
            key,
            createWindowedItemRefCallback(
              key,
              wrapperByKeyRef,
              keyByWrapperRef,
              observerRef,
            ),
          );
        }
      }
      return next;
    });
  }, [itemKeys]);

  const resolveScrollElement = useCallback((): Element | null => {
    const fromRef = scrollElementRef?.current ?? null;
    if (fromRef) {
      return fromRef;
    }
    const firstWrapper = wrapperByKeyRef.current.values().next();
    return firstWrapper.done
      ? null
      : firstWrapper.value.closest(SIDEBAR_CONTENT_SELECTOR);
  }, [scrollElementRef]);

  const recordMeasuredHeight = useCallback((key: string, height: number) => {
    if (height <= 0) {
      return;
    }
    const rows = rowsByKeyRef.current.get(key) ?? 0;
    setMeasuredHeights((previous) => {
      const next = new Map(previous);
      next.set(key, { height, rows });
      return next;
    });
    if (rows > 0) {
      const perRow = height / rows;
      if (perRow >= 20 && perRow <= 80) {
        setRowHeight(perRow);
      }
    }
  }, []);

  useLayoutEffect(() => {
    if (!windowingEnabled) {
      setRealizedKeys((previous) =>
        previous.size > 0 ? EMPTY_KEY_SET : previous,
      );
      return;
    }

    const keySet = new Set(itemKeys);
    for (const staleMap of [rowsByKeyRef.current] as const) {
      for (const key of staleMap.keys()) {
        if (!keySet.has(key)) {
          staleMap.delete(key);
        }
      }
    }
    const measuredKeys = new Set(itemKeys);
    setMeasuredHeights((previous) => {
      const next = new Map(previous);
      let changed = false;
      for (const key of next.keys()) {
        if (!measuredKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    rowsByKeyRef.current = new Map(
      itemKeys.map((key, index) => [key, Math.max(1, estimateRows(index))]),
    );

    const scrollElement = resolveScrollElement();
    const promoteAll =
      !scrollElement || typeof IntersectionObserver === "undefined";

    const promoteVisible = () => {
      const promoted = new Set<string>();
      if (promoteAll) {
        for (const key of itemKeys) {
          promoted.add(key);
        }
      } else if (scrollElement) {
        const viewport = scrollElement.getBoundingClientRect();
        const viewportTop = viewport.top - WINDOW_VIEWPORT_MARGIN_PX;
        const viewportBottom = viewport.bottom + WINDOW_VIEWPORT_MARGIN_PX;
        for (const [key, element] of wrapperByKeyRef.current) {
          if (realizedKeys.has(key) || !keySet.has(key)) {
            continue;
          }
          const rect = element.getBoundingClientRect();
          if (rect.bottom >= viewportTop && rect.top <= viewportBottom) {
            promoted.add(key);
          }
        }
      }

      setRealizedKeys((previous) =>
        mergeRealizedKeys(previous, { add: promoted, retain: keySet }),
      );
    };

    let unobserveResize: (() => void) | null = null;
    let frame: number | null = null;
    if (promoteAll) {
      promoteVisible();
    } else if (scrollElement && typeof ResizeObserver !== "undefined") {
      unobserveResize = observeSharedResize(scrollElement, {
        read: (entry) => entry !== undefined && entry.contentRect.height > 0,
        write: (hasSize) => {
          if (hasSize) promoteVisible();
        },
      });
    } else {
      frame = requestAnimationFrame(() => {
        if (!scrollElement || scrollElement.clientHeight > 0) {
          promoteVisible();
        }
      });
    }

    const observer = observerRef.current;
    if (observer) {
      for (const element of wrapperByKeyRef.current.values()) {
        observer.observe(element);
      }
    }
    return () => {
      unobserveResize?.();
      if (frame !== null) cancelAnimationFrame(frame);
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, [windowingEnabled, keySignature, itemKeys, estimateRows]);

  useEffect(() => {
    if (!windowingEnabled || typeof IntersectionObserver === "undefined") {
      return;
    }
    const scrollElement = resolveScrollElement();
    if (!scrollElement) {
      return;
    }

    let observer: IntersectionObserver | null = null;

    const connect = () => {
      if (observer) {
        return;
      }
      observer = new IntersectionObserver(
        (entries) => {
          const intended = new Map<string, boolean>();
          for (const entry of entries) {
            const key = keyByWrapperRef.current.get(entry.target);
            if (key === undefined) {
              continue;
            }
            if (entry.isIntersecting) {
              intended.set(key, true);
            } else if (
              !alwaysMountedKeys.has(key) &&
              hasLayoutBox(entry.boundingClientRect)
            ) {
              intended.set(key, false);
              recordMeasuredHeight(key, entry.boundingClientRect.height);
            }
          }
          if (intended.size === 0) {
            return;
          }
          const entering: string[] = [];
          const leaving: string[] = [];
          for (const [key, isEntering] of intended) {
            (isEntering ? entering : leaving).push(key);
          }
          startTransition(() =>
            setRealizedKeys((previous) =>
              mergeRealizedKeys(previous, { add: entering, remove: leaving }),
            ),
          );
        },
        {
          root: scrollElement,
          rootMargin: `${WINDOW_VIEWPORT_MARGIN_PX}px 0px`,
        },
      );
      observerRef.current = observer;
      for (const element of wrapperByKeyRef.current.values()) {
        observer.observe(element);
      }
    };

    connect();

    return () => {
      observerRef.current = null;
      observer?.disconnect();
    };
  }, [windowingEnabled, resolveScrollElement, recordMeasuredHeight, alwaysMountedKeys]);

  return (
    <>
      {itemKeys.map((key, index) => {
        const isRealized =
          !windowingEnabled ||
          realizedKeys.has(key) ||
          alwaysMountedKeys.has(key) ||
          focusItemKey === key;
        const rows = Math.max(1, estimateRows(index));
        let placeholderHeight: number | undefined;
        let navigationValue: string | undefined;
        if (!isRealized) {
          const measured = measuredHeights.get(key);
          placeholderHeight =
            measured && measured.rows === rows
              ? measured.height
              : rows * rowHeight;
          const entries = getNavigationEntries?.(index);
          navigationValue =
            entries && entries.length > 0
              ? encodeSidebarWindowedNavigationEntries(entries)
              : undefined;
        }
        return (
          <div
            key={key}
            ref={wrapperRefCallbacks.get(key)}
            data-sidebar-windowed-item=""
            {...(navigationValue !== undefined
              ? { [SIDEBAR_WINDOWED_NAV_ATTRIBUTE]: navigationValue }
              : undefined)}
            style={isRealized ? undefined : { height: placeholderHeight }}
          >
            {isRealized ? renderItem(index) : null}
          </div>
        );
      })}
    </>
  );
}
