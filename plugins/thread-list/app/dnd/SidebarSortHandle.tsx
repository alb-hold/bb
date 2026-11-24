import type { KeyboardEventHandler } from "react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { Icon } from "@/components/ui/icon";
import type { SidebarSortableDragBindings } from "@/components/ui/sortable-motion";
import { cn } from "@/lib/utils";

export function getSidebarPointerDragListeners(
  listeners: DraggableSyntheticListeners,
): DraggableSyntheticListeners {
  if (!listeners) {
    return undefined;
  }
  const { onKeyDown: _onKeyDown, ...pointerListeners } = listeners;
  return pointerListeners;
}

interface SidebarSortHandleProps {
  dragBindings?: SidebarSortableDragBindings;
  label: string;
  className?: string;
}

export function SidebarSortHandle({
  dragBindings,
  label,
  className,
}: SidebarSortHandleProps) {
  if (!dragBindings || dragBindings.disabled) {
    return null;
  }

  const onKeyDown = dragBindings.listeners?.onKeyDown as
    | KeyboardEventHandler<HTMLButtonElement>
    | undefined;

  return (
    <button
      type="button"
      ref={dragBindings.setActivatorNodeRef}
      {...dragBindings.attributes}
      onKeyDown={onKeyDown}
      aria-label={`Move ${label}`}
      data-sidebar-sort-handle=""
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "pointer-events-none absolute left-0.5 top-1/2 z-40 inline-flex size-6 -translate-y-1/2 shrink-0 items-center justify-center rounded-md opacity-0 outline-none ring-sidebar-ring",
        "focus:pointer-events-auto focus:bg-sidebar-accent focus:text-sidebar-foreground focus:opacity-100 focus:ring-2 focus:ring-inset",
        className,
      )}
    >
      <Icon name="DragDropVertical" className="size-3.5" aria-hidden="true" />
    </button>
  );
}
