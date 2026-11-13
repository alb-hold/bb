import { defineSplit } from "@/lib/define-split";
import { Icon } from "@bb/shared-ui/icon";
import type { ProjectResponse } from "@bb/server-contract";
import type { MouseEvent, ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";

import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { cn } from "@bb/shared-ui/lib/utils";

interface ProjectActionsMenuBaseProps {
  project: ProjectResponse;
  onRename?: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  extraActions?: (surface: ProjectActionsMenuSurface) => ReactNode;
}

interface ProjectActionsMenuProps extends ProjectActionsMenuBaseProps {
  triggerClassName?: string;
}

type ProjectActionsMenuSurface = "context" | "dropdown";

export interface ProjectActionsMenuItemsProps extends ProjectActionsMenuBaseProps {
  surface: ProjectActionsMenuSurface;
}

function stopProjectActionsMenuClickPropagation(event: MouseEvent) {
  event.stopPropagation();
}

const ProjectActionsMenuItems = defineSplit<ProjectActionsMenuItemsProps>({
  id: "project-actions-menu-items",
  tier: "intent",
  load: () =>
    import("./ProjectActionsMenuItems").then(
      (module) => module.ProjectActionsMenuItems,
    ),
  loading: () => null,
});

export function ProjectActionsMenu({
  project,
  triggerClassName,
  onRename,
  onCloseAutoFocus,
  extraActions,
}: ProjectActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0 text-muted-foreground",
            triggerClassName,
            "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          )}
          {...ProjectActionsMenuItems.intentProps}
          aria-label={`${project.name} actions`}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon
            name="MoreHorizontal"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={onCloseAutoFocus}
        onClick={stopProjectActionsMenuClickPropagation}
      >
        <ProjectActionsMenuItems
          project={project}
          surface="dropdown"
          onRename={onRename}
          extraActions={extraActions}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
