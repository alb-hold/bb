import { useAppCommandRunner } from "@/components/commands/AppCommandProvider";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";

export function CompactHomeHeader({ title }: { title: string }) {
  const commands = useAppCommandRunner();
  return (
    <div className="fixed left-14 right-[calc(3.5rem+env(safe-area-inset-right))] top-(--bb-window-frame-top) z-30 flex h-12 min-w-0 items-center gap-2">
      <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="New thread"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) =>
              commands.dispatch("thread.new", event.currentTarget)
            }
          >
            <Icon name="Plus" className="size-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>New thread</TooltipContent>
      </Tooltip>
    </div>
  );
}
