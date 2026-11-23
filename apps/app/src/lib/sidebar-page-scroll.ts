export function observeSidebarPageScroll(scroller: HTMLElement, loadMore: () => void) {
  const onScroll = () => {
    if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 240) {
      loadMore();
    }
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  return () => scroller.removeEventListener("scroll", onScroll);
}
