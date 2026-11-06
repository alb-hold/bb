import * as React from "react";

type Dispatcher = Record<string, (...args: any[]) => any>;

let recording = false;
let finished = false;
let root: object | null = null;

export function traceStartupRoot(value: object, container: HTMLElement) {
  const internal: unknown = Reflect.get(value, "_internalRoot");
  if (typeof internal === "object" && internal !== null) root = internal;
  let previous = 0;
  const observer = new MutationObserver(() => {
    const total = container.querySelectorAll("[data-sidebar-thread-id]").length;
    if (recording && previous !== total)
      performance.mark("p41-sidebar-rows-commit", {
        detail: { previous, total },
      });
    previous = total;
    if (finished) observer.disconnect();
  });
  observer.observe(container, { childList: true, subtree: true });
}

export function markStartupReactWork(label: string) {
  const internals: unknown = Reflect.get(
    React,
    "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
  );
  performance.mark(`p41-react-work:${label}`, {
    detail: {
      transition:
        typeof internals === "object" && internals !== null
          ? Reflect.get(internals, "T") !== null
          : null,
      pendingLanes: root && Reflect.get(root, "pendingLanes"),
      callbackPriority: root && Reflect.get(root, "callbackPriority"),
      suspendedLanes: root && Reflect.get(root, "suspendedLanes"),
      pingedLanes: root && Reflect.get(root, "pingedLanes"),
    },
  });
}

export function beginStartupComposerTrace() {
  if (!recording && !finished) {
    recording = true;
    performance.mark("p41-cb:window-start");
  }
  markStartupReactWork("composer-box");
}

export function finishStartupComposerTrace() {
  markStartupReactWork("plain-commit");
  recording = false;
  finished = true;
  performance.mark("p41-cb:window-end");
}

export function traceStartupReactUpdates() {
  Error.stackTraceLimit = 80;
  const internals: unknown = Reflect.get(
    React,
    "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
  );
  if (typeof internals !== "object" || internals === null) return;
  const dispatchers = new WeakMap<object, Dispatcher>();
  const setters = new WeakMap<Function, Function>();
  const getters = new WeakMap<Function, Function>();
  const subscribers = new WeakMap<Function, Function>();
  let dispatcher: unknown = Reflect.get(internals, "H");
  let count = 0;
  const mark = (kind: string, detail: string) => {
    if (recording && count++ < 2400)
      performance.mark(`p41-cb:${kind}`, { detail });
  };
  const stack = () =>
    new Error().stack?.split("\n").slice(2, 82).join("\n") ?? "";
  const setter = (dispatch: Function, owner: string) => {
    let traced = setters.get(dispatch);
    if (!traced) {
      const creation = new Error();
      traced = (...args: unknown[]) => {
        if (recording)
          mark("state", `${owner}\nOWNER\n${creation.stack}\nCALL\n${stack()}`);
        return dispatch(...args);
      };
      setters.set(dispatch, traced);
    }
    return traced;
  };
  const getter = (read: Function, owner: string) => {
    let traced = getters.get(read);
    if (!traced) {
      let seen = false;
      let previous: unknown;
      traced = () => {
        const next = read();
        if (recording && seen && !Object.is(previous, next))
          mark("snapshot-change", `${owner}\nREAD\n${stack()}`);
        seen = true;
        previous = next;
        return next;
      };
      getters.set(read, traced);
    }
    return traced;
  };
  const subscriber = (subscribe: Function, owner: string) => {
    let traced = subscribers.get(subscribe);
    if (!traced) {
      traced = (notify: () => void) =>
        subscribe(() => {
          if (recording) mark("store-emit", `${owner}\nEMIT\n${stack()}`);
          notify();
        });
      subscribers.set(subscribe, traced);
    }
    return traced;
  };
  const wrap = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const cached = dispatchers.get(value);
    if (cached) return cached;
    const original = value as Dispatcher;
    const traced: Dispatcher = { ...original };
    for (const name of ["useState", "useReducer"]) {
      if (typeof original[name] !== "function") continue;
      traced[name] = (...args: unknown[]) => {
        const [state, dispatch] = original[name](...args);
        return [state, setter(dispatch, name)];
      };
    }
    if (typeof original.useSyncExternalStore === "function")
      traced.useSyncExternalStore = (
        subscribe: Function,
        read: Function,
        server: Function | undefined,
      ) => {
        const owner = read.toString().slice(0, 400);
        return original.useSyncExternalStore(
          subscriber(subscribe, owner),
          getter(read, owner),
          server,
        );
      };
    if (typeof original.use === "function")
      traced.use = (...args: unknown[]) => {
        try {
          return original.use(...args);
        } catch (error) {
          if (recording) mark("use-throw", stack());
          throw error;
        }
      };
    dispatchers.set(value, traced);
    dispatchers.set(traced, traced);
    return traced;
  };
  Object.defineProperty(internals, "H", {
    configurable: true,
    get: () => wrap(dispatcher),
    set: (next) => {
      dispatcher = next;
    },
  });
  performance.mark("p41-cb:installed");
}
