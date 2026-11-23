const sidebarPaint = "bb:sidebar-first-row-painted";
const sidebarUsable = "bb:sidebar-usable";
const threadOpen = "bb:sidebar-thread-open";
const threadPaint = "bb:thread-first-content-painted";
const threadDuration = "bb:thread-open-to-content";

export const firstScreenMetrics = [
  ["Shell painted", "bb:shell-painted"],
  ["First sidebar row painted", sidebarPaint],
  ["Sidebar usable", sidebarUsable],
  ["Thread open to first content", threadDuration],
] as const;

export function observeFirstScreenPaint() {
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes.includes("element")
  )
    return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!("identifier" in entry) || typeof entry.identifier !== "string")
        continue;
      if (entry.identifier === "bb-sidebar-row") {
        if (performance.getEntriesByName(sidebarUsable).length > 0) continue;
        if (performance.getEntriesByName(sidebarPaint).length === 0)
          performance.mark(sidebarPaint, { startTime: entry.startTime });
        const title = "element" in entry ? entry.element : null;
        const row =
          title instanceof Element
            ? title.closest("[data-sidebar-rename-row]")
            : null;
        const link = row?.querySelector("a[data-sidebar-thread-id][href]");
        if (link && !link.closest('[inert], [aria-hidden="true"]'))
          performance.mark(sidebarUsable);
      } else if (entry.identifier.startsWith("bb-thread-content:")) {
        const open = performance.getEntriesByName(threadOpen).at(-1);
        if (
          !open ||
          !("detail" in open) ||
          entry.identifier !== `bb-thread-content:${open.detail}` ||
          entry.startTime < open.startTime
        )
          continue;
        performance.clearMarks(threadPaint);
        performance.clearMeasures(threadDuration);
        performance.mark(threadPaint, { startTime: entry.startTime });
        performance.measure(threadDuration, threadOpen, threadPaint);
        performance.clearMarks(threadOpen);
      }
    }
  });
  observer.observe({ type: "element", buffered: true });
}
