import {
  createContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export function createRetainedTerminalMount() {
  let host: ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => host,
    show(next: ReactNode) {
      if (host === next) return;
      host = next;
      listeners.forEach((listener) => listener());
    },
  };
}

export type RetainedTerminalMount = ReturnType<
  typeof createRetainedTerminalMount
>;

export const RetainedTerminalViewsContext = createContext<{
  mount: RetainedTerminalMount;
  projectId: string | undefined;
} | null>(null);

export function RetainedTerminalViewsProvider({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId?: string;
}) {
  const [mount] = useState(createRetainedTerminalMount);
  const context = useMemo(() => ({ mount, projectId }), [mount, projectId]);
  const host = useSyncExternalStore(mount.subscribe, mount.getSnapshot);
  return (
    <RetainedTerminalViewsContext.Provider value={context}>
      {children}
      {host}
    </RetainedTerminalViewsContext.Provider>
  );
}
