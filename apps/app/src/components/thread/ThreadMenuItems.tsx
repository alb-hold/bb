import type {
  PluginThreadActionTarget,
  PluginThreadActionsInlineItem,
} from "@get-bb/plugin-sdk";
import { ContextMenuLabel } from "@bb/shared-ui/context-menu";
import { DropdownMenuLabel } from "@bb/shared-ui/dropdown-menu";
import { ActionMenuSeparator } from "@bb/shared-ui/action-menu-items";
import {
  ThreadActionMenuRows,
  useThreadActionMenuGroups,
  useThreadBulkActionMenuGroups,
  type ThreadActionMenuSurface,
} from "./ThreadActionMenuItems";
interface MenuItemsRenderProps {
  surface: ThreadActionMenuSurface;
  isDrawer: boolean;
  drawerStep: string | null;
  onDrawerStepChange: (key: string | null) => void;
}
function describeThreadCount(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}
export function ThreadActionsMenuItems({
  thread,
  inline,
  requestRename,
  surface,
  isDrawer,
  drawerStep,
  onDrawerStepChange,
}: {
  thread: PluginThreadActionTarget;
  inline?: readonly PluginThreadActionsInlineItem[];
  requestRename?: (threadId: string) => void;
  surface: ThreadActionMenuSurface;
  isDrawer: boolean;
  drawerStep: string | null;
  onDrawerStepChange: (key: string | null) => void;
}) {
  const groups = useThreadActionMenuGroups({ thread, inline, requestRename });
  return (
    <ThreadActionMenuRows
      groups={groups}
      surface={surface}
      isDrawer={isDrawer}
      drawerStep={drawerStep}
      onDrawerStepChange={onDrawerStepChange}
    />
  );
}

export function ThreadBulkMenuItems({
  threads,
  inline,
  surface,
  isDrawer,
  drawerStep,
  onDrawerStepChange,
}: {
  threads: readonly PluginThreadActionTarget[];
  inline?: readonly PluginThreadActionsInlineItem[];
} & MenuItemsRenderProps) {
  const groups = useThreadBulkActionMenuGroups({ threads, inline });
  const Label = surface === "context" ? ContextMenuLabel : DropdownMenuLabel;
  return (
    <>
      {drawerStep === null ? (
        <>
          <Label className="text-muted-foreground">
            {describeThreadCount(threads.length)} selected
          </Label>
          {groups.length > 0 ? <ActionMenuSeparator surface={surface} /> : null}
        </>
      ) : null}
      <ThreadActionMenuRows
        groups={groups}
        surface={surface}
        isDrawer={isDrawer}
        drawerStep={drawerStep}
        onDrawerStepChange={onDrawerStepChange}
      />
    </>
  );
}
