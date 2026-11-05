import { expect, it, vi } from "vitest";

it("imports without reading browser globals", async () => {
  vi.resetModules();
  const names = ["document", "window", "navigator"];
  const descriptors = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  const accessed = vi.fn(() => {
    throw new Error("Browser global read during import");
  });
  try {
    for (const name of names)
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get: accessed,
      });
    await import("./overlay-trigger");
    expect(accessed).not.toHaveBeenCalled();
  } finally {
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    });
  }
});

it("does not initialize the shared menu context until a menu renders", async () => {
  vi.resetModules();
  const key = Symbol.for("bb.menu-hover-context.v1");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  const accessed = vi.fn(() => {
    throw new Error("Menu global touched on import");
  });
  try {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get: accessed,
    });
    await import("./menu-item-hover");
    expect(accessed).not.toHaveBeenCalled();
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

it("does not initialize the shared responsive menu context on import", async () => {
  vi.resetModules();
  const key = Symbol.for("bb.responsive-menu-context.v1");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  const accessed = vi.fn(() => {
    throw new Error("Menu global touched on import");
  });
  try {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get: accessed,
    });
    await import("./dropdown-menu");
    expect(accessed).not.toHaveBeenCalled();
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});
