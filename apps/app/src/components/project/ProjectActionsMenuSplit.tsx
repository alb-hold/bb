import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { defineSplit } from "@/lib/define-split";

type ProjectActionsMenuProps = Parameters<
  typeof import("./ProjectActionsMenu").ProjectActionsMenu
>[0];

function ProjectActionsMenuPlaceholder({
  project,
  triggerClassName,
}: ProjectActionsMenuProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("rounded-md p-0 text-muted-foreground", triggerClassName)}
      aria-label={`${project.name} actions`}
      aria-haspopup="menu"
    >
      <Icon name="MoreHorizontal" className={COARSE_POINTER_ICON_SIZE_CLASS} />
    </Button>
  );
}

export const ProjectActionsMenu = defineSplit<ProjectActionsMenuProps>({
  id: "project-actions-menu",
  load: () =>
    import("./ProjectActionsMenu").then((module) => module.ProjectActionsMenu),
  loading: ProjectActionsMenuPlaceholder,
  tier: "intent",
});
