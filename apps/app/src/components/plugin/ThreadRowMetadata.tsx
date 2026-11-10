import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  ExperimentalThreadRowMetadataLineProps,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { compareGroupedPlacement } from "@/lib/grouped-placement";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import {
  readThreadRowMetadataChrome,
  rememberThreadRowMetadataChrome,
} from "@/lib/thread-row-metadata-chrome";
import {
  collectedStore,
  slotKey,
  useRegisterLineThread,
} from "@/lib/thread-row-metadata-store";
import {
  usePluginSlots,
  type PluginThreadRowMetadataSlot,
} from "@/lib/plugin-slots";

function sortThreadRowMetadata(
  slots: readonly PluginThreadRowMetadataSlot[],
): PluginThreadRowMetadataSlot[] {
  return slots
    .map((slot, index) => ({ slot, index }))
    .sort((left, right) =>
      compareGroupedPlacement(
        { group: "", order: left.slot.order },
        left.index,
        { group: "", order: right.slot.order },
        right.index,
      ),
    )
    .map(({ slot }) => slot);
}

function recordItemContent(
  container: HTMLElement,
  threadId: string,
  resolved: boolean,
): void {
  const roots = container.querySelectorAll(":scope > [data-bb-plugin-root]");
  const hasItems = [...roots].some((root) => root.hasChildNodes());
  container.toggleAttribute("data-has-items", hasItems);
  if (hasItems || resolved) {
    container.toggleAttribute("data-reserve-line", hasItems);
    rememberThreadRowMetadataChrome(threadId, hasItems);
  }
}

function MountedThreadRowMetadata({
  thread,
  slots,
}: {
  thread: PluginSidebarThread;
  slots: readonly PluginThreadRowMetadataSlot[];
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const settled = usePluginFrontendsSettled();
  const remembered = useMemo(
    () => readThreadRowMetadataChrome(thread.id),
    [thread.id],
  );
  useRegisterLineThread(thread);
  const collected = useSyncExternalStore(
    collectedStore.subscribe,
    collectedStore.getSnapshot,
  );
  const resolved =
    slots.length === 0
      ? settled
      : slots.every(
          (slot) =>
            slot.useData === undefined ||
            collected.get(slotKey(slot))?.data !== undefined,
        );
  useLayoutEffect(() => {
    if (anchor.current !== null)
      recordItemContent(anchor.current, thread.id, resolved);
  });
  useLayoutEffect(() => {
    const container = anchor.current;
    if (container === null) return;
    const observer = new MutationObserver(() =>
      recordItemContent(container, thread.id, resolved),
    );
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [thread.id, resolved]);
  return (
    <span
      ref={anchor}
      data-thread-row-metadata=""
      data-reserve-line={remembered ? "" : undefined}
      className="pointer-events-auto relative z-[31] hidden min-w-0 flex-1 items-center gap-2 overflow-hidden data-[has-items]:flex"
    >
      {slots.map((slot) => {
        const entry = collected.get(slotKey(slot));
        if (slot.useData !== undefined && entry === undefined) return null;
        const Component = slot.component;
        return (
          <PluginSlotMount
            key={slotKey(slot)}
            pluginId={slot.pluginId}
            slotKind="threadRowMetadata"
            slotId={slot.id}
            instanceId={thread.id}
            crashFallback={null}
          >
            <Component thread={thread} data={entry?.data} />
          </PluginSlotMount>
        );
      })}
    </span>
  );
}

export const ThreadRowMetadata = memo(function ThreadRowMetadata({
  thread,
}: ExperimentalThreadRowMetadataLineProps) {
  const { threadRowMetadata } = usePluginSlots();
  return (
    <MountedThreadRowMetadata
      key={thread.id}
      thread={thread}
      slots={sortThreadRowMetadata(threadRowMetadata)}
    />
  );
});
