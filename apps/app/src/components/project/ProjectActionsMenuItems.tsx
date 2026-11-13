import {
  ActionMenuItem,
  ActionMenuSeparator,
} from "@bb/shared-ui/action-menu-items";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import { useNavigate } from "react-router-dom";
import { usePathPickerHost } from "@/hooks/useLocalPathPicker";
import { getSettingsProjectRoutePath } from "@/lib/route-paths";
import { useProjectActions } from "./ProjectActionsProvider";
import type { ProjectActionsMenuItemsProps } from "./ProjectActionsMenu";

export function ProjectActionsMenuItems({
  project,
  surface,
  onRename,
  extraActions,
}: ProjectActionsMenuItemsProps) {
  const navigate = useNavigate();
  const { hostId: pickerHostId } = usePathPickerHost();
  const { requestRename, requestDelete, requestAddLocalPath } =
    useProjectActions();
  const showAddLocalPath =
    pickerHostId != null &&
    !findLocalPathProjectSourceForHost(project.sources, pickerHostId);

  return (
    <>
      <ActionMenuItem
        surface={surface}
        icon="Settings"
        onSelect={() => {
          void navigate(getSettingsProjectRoutePath(project.id));
        }}
      >
        Project settings
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon="Edit"
        onSelect={() => {
          if (onRename) onRename();
          else requestRename(project);
        }}
      >
        Rename
      </ActionMenuItem>
      {showAddLocalPath ? (
        <ActionMenuItem
          surface={surface}
          icon="FolderPlus"
          onSelect={() => {
            requestAddLocalPath(project);
          }}
        >
          Add local path
        </ActionMenuItem>
      ) : null}
      {extraActions?.(surface)}
      <ActionMenuSeparator surface={surface} />
      <ActionMenuItem
        surface={surface}
        icon="Trash2"
        variant="destructive"
        onSelect={() => {
          requestDelete(project);
        }}
      >
        Remove
      </ActionMenuItem>
    </>
  );
}
