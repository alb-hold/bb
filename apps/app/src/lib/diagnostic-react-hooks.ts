import * as React from "react";

type Dispatcher = Record<string, (...args: any[]) => any>;

export function traceStartupReactUpdates() {
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
    if (count++ < 1200) performance.mark(`p41-cb:${kind}`, { detail });
  };
  const stack = () =>
    new Error().stack?.split("\n").slice(2, 12).join("\n") ?? "";
  const setter = (dispatch: Function, owner: string) => {
    let traced = setters.get(dispatch);
    if (!traced) {
      traced = (...args: unknown[]) => {
        mark("state", `${owner}\nCALL\n${stack()}`);
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
        if (seen && !Object.is(previous, next))
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
          mark("store-emit", `${owner}\nEMIT\n${stack()}`);
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
        return [state, setter(dispatch, stack())];
      };
    }
    if (typeof original.useSyncExternalStore === "function")
      traced.useSyncExternalStore = (
        subscribe: Function,
        read: Function,
        server: Function | undefined,
      ) => {
        const owner = stack();
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
          mark("use-throw", stack());
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
