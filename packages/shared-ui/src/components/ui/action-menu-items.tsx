import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon, type IconName } from "./icon";
import { Input } from "./input";
import { usePointerCoarse } from "./hooks/use-pointer-coarse";
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

export const ACTION_MENU_CHOICE_FILTER_MIN_ITEMS = 8;

const ACTION_MENU_CHOICE_FILTER_PASSTHROUGH_KEYS = new Set(["Escape", "Tab"]);

function isFilterCharacter(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key.length === 1 &&
    event.key !== " " &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

function focusFirstChoiceAfter(input: HTMLElement): boolean {
  const menu = input.closest('[role="menu"]');
  if (menu === null) return false;
  const choices = menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not([data-disabled])',
  );
  for (const choice of choices) {
    if (
      input.compareDocumentPosition(choice) & Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      choice.focus();
      return true;
    }
  }
  return false;
}

export function useActionMenuChoiceFilter<Choice extends { label: string }>(
  items: readonly Choice[],
) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const enabled = items.length >= ACTION_MENU_CHOICE_FILTER_MIN_ITEMS;
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!enabled || normalized === "") return items;
    return items.filter((item) =>
      item.label.toLocaleLowerCase().includes(normalized),
    );
  }, [enabled, items, query]);
  const onChoiceKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!enabled || !isFilterCharacter(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setQuery((current) => current + event.key);
      inputRef.current?.focus();
    },
    [enabled],
  );
  return { enabled, query, setQuery, visible, inputRef, onChoiceKeyDown };
}

interface ActionMenuChoiceFilterProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  matchCount: number;
  surface: ActionMenuSurface;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function ActionMenuChoiceFilter({
  label,
  value,
  onChange,
  matchCount,
  surface,
  inputRef,
}: ActionMenuChoiceFilterProps) {
  const isPointerCoarse = usePointerCoarse();
  useEffect(() => {
    if (isPointerCoarse) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [inputRef, isPointerCoarse]);
  return (
    <>
      <div className="p-1">
        <Input
          ref={inputRef}
          aria-label={label}
          placeholder="Filter"
          value={value}
          className="h-7"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "ArrowDown" &&
              focusFirstChoiceAfter(event.currentTarget)
            ) {
              event.preventDefault();
            }
            if (!ACTION_MENU_CHOICE_FILTER_PASSTHROUGH_KEYS.has(event.key)) {
              event.stopPropagation();
            }
          }}
        />
      </div>
      {matchCount === 0 ? (
        <ActionMenuNotice surface={surface}>No matches</ActionMenuNotice>
      ) : null}
    </>
  );
}
