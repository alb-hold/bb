import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { TerminalSession } from "@bb/server-contract";
import {
  AppNavigationHostProvider,
  useAppNavigationHost,
} from "@/lib/app-navigation-host";
import { wsManager } from "@/lib/ws";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import type { ThreadTerminalViewProps } from "./ThreadTerminalView";

type Navigation = ReturnType<typeof useAppNavigationHost>;
type View = ComponentType<ThreadTerminalViewProps>;
type RetainedProps = Pick<
  ThreadTerminalViewProps,
  "session" | "retainNativeOutput" | "attentionShownAsBanner"
>;
interface Attachment {
  props: ThreadTerminalViewProps;
  navigation: Navigation;
}
interface Snapshot {
  attachment: Attachment | null;
  retained: RetainedProps;
}
interface Entry {
  id: number;
  key: string;
  paneId: string;
  projectId: string | undefined;
  View: View;
  container: HTMLDivElement;
  invalid: boolean;
  snapshot: Snapshot;
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Snapshot;
}

export function createRetainedTerminalViews() {
  let entries: readonly Entry[] = [];
  let nextId = 0;
  let host: HTMLDivElement | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let prunePending = false;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const update = (entry: Entry, snapshot: Snapshot) => {
    entry.snapshot = snapshot;
    entry.listeners.forEach((listener) => listener());
  };
  const remove = (entry: Entry) => {
    entries = entries.filter((candidate) => candidate !== entry);
    publish();
    entry.container.remove();
  };
  const invalidate = (predicate: (entry: Entry) => boolean) => {
    for (const entry of entries) {
      if (!predicate(entry)) continue;
      entry.invalid = true;
      if (entry.snapshot.attachment === null) remove(entry);
    }
  };
  const prune = () => {
    const detached = entries.filter(
      (entry) => entry.snapshot.attachment === null,
    );
    for (const entry of detached.slice(0, Math.max(0, detached.length - 1)))
      remove(entry);
  };
  const schedulePrune = () => {
    if (prunePending) return;
    prunePending = true;
    queueMicrotask(() => {
      prunePending = false;
      prune();
    });
  };
  const retain = (props: ThreadTerminalViewProps): RetainedProps => ({
    session: props.session,
    retainNativeOutput: props.retainNativeOutput,
    attentionShownAsBanner: props.attentionShownAsBanner,
  });
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => entries,
    setHost(value: HTMLDivElement | null) {
      host = value;
    },
    attach(
      key: string,
      slot: HTMLElement,
      View: View,
      attachment: Attachment,
      projectId?: string,
      paneId = "page",
    ) {
      let entry = entries.find(
        (candidate) =>
          candidate.key === key &&
          !candidate.invalid &&
          candidate.snapshot.attachment === null,
      );
      if (entry === undefined) {
        const container = slot.ownerDocument.createElement("div");
        container.className = "h-full min-h-0 min-w-0";
        const entryListeners = new Set<() => void>();
        const created: Entry = {
          id: ++nextId,
          key,
          paneId,
          projectId,
          View,
          container,
          invalid: false,
          snapshot: { attachment, retained: retain(attachment.props) },
          listeners: entryListeners,
          subscribe: (listener) => {
            entryListeners.add(listener);
            return () => {
              entryListeners.delete(listener);
            };
          },
          getSnapshot: () => created.snapshot,
        };
        entry = created;
        entries = [...entries, entry];
      }
      entry.container.style.width = "";
      entry.container.style.height = "";
      slot.append(entry.container);
      update(entry, { attachment, retained: retain(attachment.props) });
      publish();
      return entry;
    },
    update(entry: Entry, attachment: Attachment) {
      update(entry, { attachment, retained: retain(attachment.props) });
      if (attachment.props.session.status !== "running") entry.invalid = true;
    },
    detach(entry: Entry) {
      if (!entries.includes(entry)) return;
      if (host === null) {
        update(entry, { attachment: null, retained: entry.snapshot.retained });
        remove(entry);
        return;
      }
      const rect = entry.container.getBoundingClientRect();
      entry.container.style.width = `${rect.width}px`;
      entry.container.style.height = `${rect.height}px`;
      update(entry, { attachment: null, retained: entry.snapshot.retained });
      if (
        entry.invalid ||
        entry.snapshot.retained.session.status !== "running"
      ) {
        remove(entry);
        return;
      }
      host.append(entry.container);
      entries = [...entries.filter((candidate) => candidate !== entry), entry];
      schedulePrune();
      publish();
    },
    invalidate,
    sessionChanged(entry: Entry, session: TerminalSession) {
      update(entry, {
        ...entry.snapshot,
        retained: { ...entry.snapshot.retained, session },
      });
      if (session.status !== "running")
        invalidate((candidate) => candidate === entry);
    },
    setDocumentHidden(hidden: boolean) {
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      hiddenTimer = hidden
        ? setTimeout(() => {
            hiddenTimer = null;
            invalidate((entry) => entry.snapshot.attachment === null);
          }, 5 * 60_000)
        : null;
    },
    dispose() {
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      hiddenTimer = null;
      entries = [];
      publish();
    },
  };
}

type Registry = ReturnType<typeof createRetainedTerminalViews>;
const RetainedTerminalViewsContext = createContext<{
  registry: Registry;
  projectId: string | undefined;
} | null>(null);

function RetainedView({
  entry,
  registry,
}: {
  entry: Entry;
  registry: Registry;
}) {
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
  const [onRetentionInvalidated] = useState(
    () => () => registry.invalidate((candidate) => candidate === entry),
  );
  const [onSessionChange] = useState(() => (session: TerminalSession) => {
    entry.snapshot.attachment?.props.onSessionChange?.(session);
    registry.sessionChanged(entry, session);
  });
  const props = snapshot.attachment?.props ?? {
    ...snapshot.retained,
    autoFocus: false,
    isPanelOpen: false,
  };
  return createPortal(
    <AppNavigationHostProvider
      capabilities={snapshot.attachment?.navigation ?? {}}
    >
      <entry.View
        {...props}
        parked={snapshot.attachment === null}
        onSessionChange={onSessionChange}
        onRetentionInvalidated={onRetentionInvalidated}
      />
    </AppNavigationHostProvider>,
    entry.container,
  );
}

export function RetainedTerminalViewsProvider({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId?: string;
}) {
  const [registry] = useState(createRetainedTerminalViews);
  const context = useMemo(
    () => ({ registry, projectId }),
    [registry, projectId],
  );
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
  );
  useEffect(() => {
    const visibility = () =>
      registry.setDocumentHidden(document.visibilityState !== "visible");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const changed = wsManager.onChanged((message) => {
      if (
        message.entity === "thread" &&
        message.changes.some((kind) =>
          [
            "thread-deleted",
            "archived-changed",
            "environment-changed",
          ].includes(kind),
        )
      ) {
        registry.invalidate(
          (entry) =>
            message.id === undefined ||
            entry.snapshot.retained.session.threadId === message.id,
        );
      } else if (
        message.entity === "environment" &&
        message.changes.includes("environment-deleted")
      ) {
        registry.invalidate(
          (entry) =>
            message.id === undefined ||
            entry.snapshot.retained.session.environmentId === message.id,
        );
      } else if (
        message.entity === "project" &&
        message.changes.includes("project-deleted")
      ) {
        registry.invalidate(
          (entry) => message.id === undefined || entry.projectId === message.id,
        );
      } else if (
        message.entity === "system" &&
        message.changes.includes("server-move-changed")
      )
        registry.invalidate(() => true);
    });
    const connected = wsManager.onConnected((event) => {
      if (event.reconnected) registry.invalidate(() => true);
    });
    const connectionState = wsManager.onConnectionStateChange(() => {
      if (wsManager.getConnectionState() !== "connected")
        registry.invalidate(() => true);
    });
    let token = wsManager.getDeviceHandoffClientToken();
    const identity = wsManager.onDeviceHandoffClientToken((next) => {
      if (token !== null && next !== token) registry.invalidate(() => true);
      token = next;
    });
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      changed();
      connected();
      connectionState();
      identity();
      registry.dispose();
    };
  }, [registry]);
  return (
    <RetainedTerminalViewsContext.Provider value={context}>
      {children}
      <div
        ref={registry.setHost}
        aria-hidden="true"
        inert
        data-retained-terminal-host=""
        style={{
          position: "fixed",
          left: -100_000,
          top: 0,
          visibility: "hidden",
          pointerEvents: "none",
          contain: "strict",
        }}
      >
        {entries.map((entry) => (
          <RetainedView key={entry.id} entry={entry} registry={registry} />
        ))}
      </div>
    </RetainedTerminalViewsContext.Provider>
  );
}

export function useRetainedTerminalPanelState(
  sessionId: string | undefined,
  open: boolean,
) {
  const registry = useContext(RetainedTerminalViewsContext)?.registry;
  const paneId = useOptionalPaneContext()?.paneId ?? "page";
  const lastSessionId = useRef(sessionId);
  if (sessionId !== undefined) lastSessionId.current = sessionId;
  useLayoutEffect(() => {
    if (!open)
      registry?.invalidate(
        (entry) =>
          entry.paneId === paneId &&
          entry.snapshot.retained.session.id === lastSessionId.current,
      );
  }, [open, paneId, registry, sessionId]);
}

export function RetainedTerminalViewSlot({
  View,
  ...props
}: ThreadTerminalViewProps & { View: View }) {
  const context = useContext(RetainedTerminalViewsContext);
  const navigation = useAppNavigationHost();
  const paneId = useOptionalPaneContext()?.paneId ?? "page";
  const slot = useRef<HTMLDivElement>(null);
  const entry = useRef<Entry | null>(null);
  const current = useRef({ props, navigation });
  current.current = { props, navigation };
  const registry = context?.registry;
  const projectId = context?.projectId;
  useLayoutEffect(() => {
    if (registry === undefined || slot.current === null) return;
    const native =
      slot.current.closest("[data-native-terminal-thread]") !== null;
    const key = JSON.stringify([
      paneId,
      props.session.threadId,
      props.session.id,
      native,
    ]);
    const acquired = registry.attach(
      key,
      slot.current,
      View,
      current.current,
      projectId,
      paneId,
    );
    entry.current = acquired;
    return () => {
      entry.current = null;
      registry.detach(acquired);
    };
  }, [
    View,
    paneId,
    projectId,
    props.session.id,
    props.session.threadId,
    registry,
  ]);
  useLayoutEffect(() => {
    if (entry.current !== null)
      registry?.update(entry.current, current.current);
  });
  return registry === undefined ? (
    <View {...props} />
  ) : (
    <div ref={slot} className="h-full min-h-0 min-w-0" />
  );
}
