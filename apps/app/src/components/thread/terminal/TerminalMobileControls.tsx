import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { getNativeShell } from "@/lib/native-shell/native-shell";
import type { TerminalNavigationKey } from "./terminal-mobile-input";

interface TerminalMobileControlsProps {
  className?: string;
  controlActive: boolean;
  disabled: boolean;
  readOnlyDisabled?: boolean;
  onArrow: (key: TerminalNavigationKey) => void;
  onControlChange: (active: boolean) => void;
  onInput: (data: string) => void;
  onKeyboardToggle: () => void;
  onPaste: () => void;
  onPreviousPrompt?: () => void;
  onNextPrompt?: () => void;
  onSearch: () => void;
  searchAvailable?: boolean;
  onSelectText: () => void;
}

function Key({
  label,
  children,
  onPress,
  active = false,
  toggle = false,
  disabled,
  className,
}: {
  label: string;
  children: ReactNode;
  onPress: () => void;
  active?: boolean;
  toggle?: boolean;
  disabled: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={toggle ? active : undefined}
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        const shell = getNativeShell();
        if (shell?.has("haptic"))
          shell.post({ type: "haptic", kind: "selection" });
        onPress();
      }}
      className={cn(
        "flex h-11 w-max min-w-11 flex-none shrink-0 whitespace-nowrap touch-manipulation items-center justify-center gap-1 rounded-full bg-[image:var(--pill-surface)] px-1 font-mono text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground active:bg-none active:bg-state-active active:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40",
        active && "bg-none bg-state-active text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TerminalMobileControls({
  className,
  controlActive,
  disabled,
  readOnlyDisabled = disabled,
  onArrow,
  onControlChange,
  onInput,
  onKeyboardToggle,
  onPaste,
  onPreviousPrompt,
  onNextPrompt,
  onSearch,
  searchAvailable = true,
  onSelectText,
}: TerminalMobileControlsProps) {
  const [expanded, setExpanded] = useState(false);
  const [secondaryKeysInline, setSecondaryKeysInline] = useState(false);
  const [compactKeys, setCompactKeys] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const updateOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const width = controlsRef.current?.clientWidth ?? 0;
    setCompactKeys(width > 0 && width < 375);
    setSecondaryKeysInline(
      scroller.clientWidth >= (searchAvailable ? 9 : 8) * 48 - 4,
    );
    const left = scroller.scrollLeft > 1;
    const right =
      scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1;
    scroller.toggleAttribute("data-more-left", left);
    scroller.toggleAttribute("data-more-right", right);
    scroller.style.maskImage =
      left || right
        ? `linear-gradient(to right, ${left ? "transparent, var(--ink) 16px" : "var(--ink)"}, ${right ? "var(--ink) calc(100% - 16px), transparent" : "var(--ink)"})`
        : "none";
  }, [searchAvailable]);
  useLayoutEffect(() => {
    updateOverflow();
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(scroller);
    if (controlsRef.current) observer.observe(controlsRef.current);
    return () => observer.disconnect();
  }, [updateOverflow]);
  const keyProps = { disabled };
  const readOnlyKeyProps = { disabled: readOnlyDisabled };
  const readOnlyExited = disabled && !readOnlyDisabled;
  const secondaryKeys = (
    <>
      {searchAvailable ? (
        <Key
          {...readOnlyKeyProps}
          label="Search terminal output"
          onPress={onSearch}
        >
          <Icon name="Search" className="size-4" />
        </Key>
      ) : null}
      <Key
        {...keyProps}
        label="Control for next key"
        toggle
        active={controlActive}
        onPress={() => onControlChange(!controlActive)}
      >
        Ctrl
      </Key>
      <div className="flex flex-none gap-1">
        <Key {...keyProps} label="Arrow left" onPress={() => onArrow("left")}>
          <Icon name="ArrowLeft" className="size-4" />
        </Key>
        <Key {...keyProps} label="Arrow right" onPress={() => onArrow("right")}>
          <Icon name="ArrowRight" className="size-4" />
        </Key>
      </div>
    </>
  );
  return (
    <div
      role="group"
      aria-label="Terminal keyboard controls"
      data-terminal-mobile-controls=""
      ref={controlsRef}
      className={cn(
        "shrink-0 border-t border-border/50 bg-sidebar px-2 py-1",
        className,
      )}
    >
      {readOnlyExited && !secondaryKeysInline ? (
        <div className="mb-1 flex flex-wrap gap-1">{secondaryKeys}</div>
      ) : null}
      {expanded ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {!secondaryKeysInline ? secondaryKeys : null}
          {onPreviousPrompt ? (
            <Key
              {...readOnlyKeyProps}
              label="Previous prompt"
              onPress={onPreviousPrompt}
            >
              ↑ Prompt
            </Key>
          ) : null}
          {onNextPrompt ? (
            <Key
              {...readOnlyKeyProps}
              label="Next prompt"
              onPress={onNextPrompt}
            >
              ↓ Prompt
            </Key>
          ) : null}
          <Key
            {...keyProps}
            label="Shift Tab"
            onPress={() => onInput("\x1b[Z")}
          >
            ⇧Tab
          </Key>
          <Key
            {...keyProps}
            label="Function key F2"
            onPress={() => onInput("\x1bOQ")}
          >
            F2
          </Key>
          <Key
            {...keyProps}
            label="End of input (Control D)"
            onPress={() => onInput("\x04")}
          >
            ^D
          </Key>
          <Key {...keyProps} label="Page up" onPress={() => onInput("\x1b[5~")}>
            PgUp
          </Key>
          <Key
            {...keyProps}
            label="Page down"
            onPress={() => onInput("\x1b[6~")}
          >
            PgDn
          </Key>
        </div>
      ) : readOnlyExited && (onPreviousPrompt || onNextPrompt) ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {onPreviousPrompt ? (
            <Key
              {...readOnlyKeyProps}
              label="Previous prompt"
              onPress={onPreviousPrompt}
            >
              ↑ Prompt
            </Key>
          ) : null}
          {onNextPrompt ? (
            <Key
              {...readOnlyKeyProps}
              label="Next prompt"
              onPress={onNextPrompt}
            >
              ↓ Prompt
            </Key>
          ) : null}
        </div>
      ) : null}
      {expanded ? (
        <div className="mb-1 flex flex-wrap gap-1">
          <Key {...keyProps} label="Home" onPress={() => onInput("\x1b[H")}>
            Home
          </Key>
          <Key {...keyProps} label="End" onPress={() => onInput("\x1b[F")}>
            End
          </Key>
          <Key {...keyProps} label="Paste" onPress={onPaste}>
            Paste
          </Key>
          <Key
            {...readOnlyKeyProps}
            label="Select terminal text"
            onPress={onSelectText}
          >
            Select
          </Key>
          <Key
            {...keyProps}
            label="Show or hide keyboard"
            onPress={onKeyboardToggle}
          >
            <Icon name="Keyboard" className="size-4" />
          </Key>
        </div>
      ) : readOnlyExited ? (
        <div className="mb-1 flex gap-1">
          <Key
            {...readOnlyKeyProps}
            label="Select terminal text"
            onPress={onSelectText}
          >
            Select
          </Key>
        </div>
      ) : null}
      <div className="flex min-w-0 gap-1">
        <div className="relative min-w-0 shrink">
          <div
            ref={scrollerRef}
            onScroll={updateOverflow}
            data-terminal-key-scroller=""
            className="flex flex-nowrap gap-1 overflow-x-auto touch-pan-x"
          >
            <Key
              {...keyProps}
              label="Interrupt (Control C)"
              onPress={() => onInput("\x03")}
            >
              ^C
            </Key>
            <Key {...keyProps} label="Escape" onPress={() => onInput("\x1b")}>
              Esc
            </Key>
            <Key {...keyProps} label="Arrow up" onPress={() => onArrow("up")}>
              <Icon name="ArrowUp" className="size-4" />
            </Key>
            <Key
              {...keyProps}
              label="Arrow down"
              onPress={() => onArrow("down")}
            >
              <Icon name="ArrowDown" className="size-4" />
            </Key>
            <Key {...keyProps} label="Tab" onPress={() => onInput("\t")}>
              Tab
            </Key>
            {secondaryKeysInline ? secondaryKeys : null}
          </div>
        </div>
        <Key
          {...keyProps}
          label="Enter"
          className={compactKeys ? "w-11 px-1.5 text-2xs" : undefined}
          onPress={() => onInput("\r")}
        >
          Enter
        </Key>
        <Key
          {...keyProps}
          label="More terminal keys"
          toggle
          active={expanded}
          className={compactKeys ? "w-11 px-1.5 text-2xs" : undefined}
          onPress={() => setExpanded(!expanded)}
        >
          <Icon
            name="MoreHorizontal"
            className={compactKeys ? "hidden" : "size-4"}
          />
          Keys
          <Icon
            name={expanded ? "ChevronUp" : "ChevronDown"}
            className={compactKeys ? "hidden" : "size-3"}
          />
        </Key>
      </div>
    </div>
  );
}
