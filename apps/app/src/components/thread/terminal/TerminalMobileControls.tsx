import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { getNativeShell } from "@/lib/native-shell/native-shell";
import type { TerminalNavigationKey } from "./terminal-mobile-input";
import { mobileKeyboardDockBottom } from "./terminal-mobile-settings";

export type TerminalControlMode = "off" | "one-shot" | "locked";

interface TerminalMobileControlsProps {
  controlMode: TerminalControlMode;
  disabled: boolean;
  onArrow: (key: TerminalNavigationKey) => void;
  onControlChange: (mode: TerminalControlMode) => void;
  onInput: (data: string) => void;
  onKeyboardToggle: () => void;
  onPaste: () => void;
  onPreviousPrompt?: () => void;
  onNextPrompt?: () => void;
  onSearch: () => void;
  searchAvailable?: boolean;
  onSelectText: () => void;
  fontSize: number;
  onFontSizeChange: (delta: number) => void;
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
        "flex h-11 min-w-0 flex-1 touch-manipulation items-center justify-center rounded-md font-mono text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground active:bg-state-active active:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40",
        active && "bg-state-active text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TerminalMobileControls({
  controlMode,
  disabled,
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
  fontSize,
  onFontSizeChange,
}: TerminalMobileControlsProps) {
  const [expanded, setExpanded] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const pointerBackspace = useRef(false);
  const stopBackspaceRepeat = () => {
    if (repeatTimer.current !== null) clearTimeout(repeatTimer.current);
    if (repeatInterval.current !== null) clearInterval(repeatInterval.current);
    repeatTimer.current = null;
    repeatInterval.current = null;
  };
  useEffect(() => stopBackspaceRepeat, []);
  useEffect(() => {
    const clearTransientInput = () => {
      stopBackspaceRepeat();
      pointerBackspace.current = false;
      if (controlMode !== "off") onControlChange("off");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") clearTransientInput();
    };
    window.addEventListener("blur", clearTransientInput);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", clearTransientInput);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [controlMode, onControlChange]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !dockRef.current) return;
    const update = () => {
      const bottom = mobileKeyboardDockBottom(window.innerHeight, viewport.offsetTop, viewport.height);
      dockRef.current?.style.setProperty("--terminal-mobile-dock-bottom", `${bottom}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  const keyProps = { disabled };
  return (
    <div
      ref={dockRef}
      role="group"
      aria-label="Terminal keyboard controls"
      data-terminal-mobile-controls=""
      className="fixed inset-x-0 z-40 shrink-0 border-t border-border/50 bg-sidebar px-2 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
      style={{ bottom: "var(--terminal-mobile-dock-bottom, env(safe-area-inset-bottom))" }}
    >
      {expanded ? (
        <div className="mb-1 flex gap-1">
          {onPreviousPrompt ? (
            <Key
              {...keyProps}
              label="Previous prompt"
              onPress={onPreviousPrompt}
            >
              ↑ Prompt
            </Key>
          ) : null}
          {onNextPrompt ? (
            <Key {...keyProps} label="Next prompt" onPress={onNextPrompt}>
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
            label="Interrupt (Control C)"
            onPress={() => onInput("\x03")}
          >
            ^C
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
      ) : null}
      {expanded ? (
        <div className="mb-1 flex gap-1">
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
            disabled={false}
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
      ) : null}
      <div className="flex gap-1">
        <Key {...keyProps} label="Decrease terminal text size" onPress={() => onFontSizeChange(-1)}>
          A−
        </Key>
        <Key {...keyProps} label={`Terminal text size ${fontSize}`} onPress={() => undefined}>
          {fontSize}
        </Key>
        <Key {...keyProps} label="Increase terminal text size" onPress={() => onFontSizeChange(1)}>
          A+
        </Key>
        <Key {...keyProps} label="Escape" onPress={() => onInput("\x1b")}>
          Esc
        </Key>
        {searchAvailable ? (
          <Key {...keyProps} label="Search terminal output" onPress={onSearch}>
            <Icon name="Search" className="size-4" />
          </Key>
        ) : null}
        <Key {...keyProps} label="Tab" onPress={() => onInput("\t")}>
          Tab
        </Key>
        <Key
          {...keyProps}
          label={controlMode === "locked" ? "Control locked" : controlMode === "one-shot" ? "Control for next key, active" : "Control for next key"}
          toggle
          active={controlMode !== "off"}
          onPress={() => onControlChange(controlMode === "off" ? "one-shot" : controlMode === "one-shot" ? "locked" : "off")}
        >
          {controlMode === "locked" ? "Ctrl·" : "Ctrl"}
        </Key>
        <button
          type="button"
          aria-label="Backspace"
          disabled={disabled}
          onPointerDown={(event) => {
            event.preventDefault();
            pointerBackspace.current = true;
            onInput("\x7f");
            repeatTimer.current = setTimeout(() => {
              repeatInterval.current = setInterval(() => onInput("\x7f"), 70);
            }, 400);
          }}
          onPointerUp={() => {
            stopBackspaceRepeat();
            setTimeout(() => { pointerBackspace.current = false; }, 0);
          }}
          onPointerCancel={() => {
            stopBackspaceRepeat();
            pointerBackspace.current = false;
          }}
          onPointerLeave={() => {
            stopBackspaceRepeat();
            pointerBackspace.current = false;
          }}
          onClick={() => {
            if (!pointerBackspace.current) onInput("\x7f");
          }}
          className="flex h-11 min-w-0 flex-1 touch-manipulation items-center justify-center rounded-md font-mono text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground active:bg-state-active active:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        >
          ⌫
        </button>
        <div className="flex min-w-0 flex-[4] gap-1">
          <Key {...keyProps} label="Arrow left" onPress={() => onArrow("left")}>
            <Icon name="ArrowLeft" className="size-4" />
          </Key>
          <Key {...keyProps} label="Arrow down" onPress={() => onArrow("down")}>
            <Icon name="ArrowDown" className="size-4" />
          </Key>
          <Key {...keyProps} label="Arrow up" onPress={() => onArrow("up")}>
            <Icon name="ArrowUp" className="size-4" />
          </Key>
          <Key
            {...keyProps}
            label="Arrow right"
            onPress={() => onArrow("right")}
          >
            <Icon name="ArrowRight" className="size-4" />
          </Key>
        </div>
        <Key {...keyProps} label="Enter" onPress={() => onInput("\r")}>
          <Icon name="CornerDownLeft" className="size-4" />
        </Key>
        <Key
          {...keyProps}
          label="More terminal keys"
          toggle
          active={expanded}
          onPress={() => setExpanded(!expanded)}
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </Key>
      </div>
    </div>
  );
}
