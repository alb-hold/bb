import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const ActionsTargetContext = createContext<{
  target: HTMLElement | null;
  activeTerminalId: string | null;
} | null>(null);
export const SecondaryPanelActionsTargetProvider =
  ActionsTargetContext.Provider;

const ActionsRefContext = createContext<
  ((target: HTMLDivElement | null) => void) | null
>(null);

export function SecondaryPanelActionsProvider({
  children,
  activeTerminalId,
}: {
  children: ReactNode;
  activeTerminalId: string | null;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(
    () => ({ target, activeTerminalId }),
    [target, activeTerminalId],
  );
  return (
    <ActionsRefContext.Provider value={setTarget}>
      <ActionsTargetContext.Provider value={value}>
        {children}
      </ActionsTargetContext.Provider>
    </ActionsRefContext.Provider>
  );
}

export function SecondaryPanelActions() {
  const ref = useContext(ActionsRefContext);
  return (
    <div
      ref={ref}
      className="flex shrink-0 items-center gap-1 empty:hidden"
      data-secondary-panel-actions=""
    />
  );
}

export function useSecondaryPanelActionsTarget() {
  return useContext(ActionsTargetContext);
}
