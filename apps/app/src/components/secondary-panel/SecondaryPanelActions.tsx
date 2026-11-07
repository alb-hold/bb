import { createContext, useContext, useState, type ReactNode } from "react";

const ActionsTargetContext = createContext<HTMLElement | null>(null);
const ActionsRefContext = createContext<
  ((target: HTMLDivElement | null) => void) | null
>(null);

export function SecondaryPanelActionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <ActionsRefContext.Provider value={setTarget}>
      <ActionsTargetContext.Provider value={target}>
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
