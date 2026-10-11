import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "./context-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./dropdown-menu";
import { cn } from "../../lib/utils";

export type ActionMenuSurface = "context" | "dropdown";

interface ActionMenuItemProps {
  children: ReactNode;
  variant?: "default" | "destructive";
  disabled?: boolean;
  icon: IconName;
  href?: string;
  onSelect?: (event: Event) => void;
  shortcut?: string;
  surface: ActionMenuSurface;
}

interface ActionMenuSeparatorProps {
  surface: ActionMenuSurface;
}

export function ActionMenuItem({
  children,
  variant,
  disabled,
  icon,
  href,
  onSelect,
  shortcut,
  surface,
}: ActionMenuItemProps) {
  const content = (
    <>
      <Icon name={icon} aria-hidden="true" />
      {children}
      {shortcut === undefined ? null : (
        <span className="ml-auto pl-3 text-subtle-foreground">{shortcut}</span>
      )}
    </>
  );
  const body = href === undefined ? content : <a href={href}>{content}</a>;

  if (surface === "context") {
    return (
      <ContextMenuItem
        asChild={href !== undefined}
        className={cn(
          variant === "destructive" &&
            "text-destructive focus:bg-destructive/15 focus:text-destructive data-[last-hovered]:bg-destructive/15 data-[last-hovered]:text-destructive",
        )}
        disabled={disabled}
        onSelect={onSelect}
      >
        {body}
      </ContextMenuItem>
    );
  }

  return (
    <DropdownMenuItem
      asChild={href !== undefined}
      variant={variant}
      disabled={disabled}
      onSelect={onSelect}
    >
      {body}
    </DropdownMenuItem>
  );
}

export function ActionMenuSeparator({ surface }: ActionMenuSeparatorProps) {
  return surface === "context" ? (
    <ContextMenuSeparator />
  ) : (
    <DropdownMenuSeparator />
  );
}

interface ActionMenuSubProps {
  children: ReactNode;
  icon: IconName;
  label: ReactNode;
  surface: ActionMenuSurface;
}

export function ActionMenuSub({
  children,
  icon,
  label,
  surface,
}: ActionMenuSubProps) {
  const trigger = (
    <>
      <Icon name={icon} aria-hidden="true" />
      {label}
    </>
  );

  if (surface === "context") {
    return (
      <ContextMenuSub>
        <ContextMenuSubTrigger>{trigger}</ContextMenuSubTrigger>
        <ContextMenuSubContent>{children}</ContextMenuSubContent>
      </ContextMenuSub>
    );
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{trigger}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

interface ActionMenuNoticeProps {
  children: ReactNode;
  surface: ActionMenuSurface;
}

export function ActionMenuNotice({ children, surface }: ActionMenuNoticeProps) {
  const className = "max-w-56 font-normal text-subtle-foreground text-wrap";
  return surface === "context" ? (
    <ContextMenuLabel className={className}>{children}</ContextMenuLabel>
  ) : (
    <DropdownMenuLabel className={className}>{children}</DropdownMenuLabel>
  );
}
