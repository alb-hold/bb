// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  createTerminalViewportPersistence,
  readTerminalViewportAnchor,
  terminalViewportStorageForClient,
  terminalViewportStorageKey,
} from "./terminal-viewport";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options: { url: string },
  ) => { window: Window & { close: () => void } };
};

const openWindows: Array<{ close: () => void }> = [];

function createSameOriginClients() {
  const clientA = new JSDOM("", { url: "https://bb.test/" });
  const clientB = new JSDOM("", { url: "https://bb.test/" });
  openWindows.push(clientA.window, clientB.window);
  Object.defineProperty(clientB.window, "localStorage", {
    configurable: true,
    value: clientA.window.localStorage,
  });
  return { clientA, clientB };
}

afterEach(() => {
  for (const clientWindow of openWindows.splice(0)) {
    clientWindow.close();
  }
});

describe("terminal viewport tab storage", () => {
  it("restores each same-origin client's own position after reload", () => {
    const { clientA, clientB } = createSameOriginClients();
    const key = terminalViewportStorageKey("terminal-a");
    const anchorA = {
      distanceFromTail: 70,
      lineOffset: 11,
      outputSequence: 42,
    };
    const anchorB = {
      distanceFromTail: 310,
      lineOffset: 3,
      outputSequence: 91,
    };
    const storageA = terminalViewportStorageForClient(
      clientA.window as unknown as Window,
    );
    const storageB = terminalViewportStorageForClient(
      clientB.window as unknown as Window,
    );
    expect(clientA.window.localStorage).toBe(clientB.window.localStorage);
    expect(storageA).not.toBe(storageB);
    const persistenceA = createTerminalViewportPersistence({
      storage: storageA,
      key,
    });
    const persistenceB = createTerminalViewportPersistence({
      storage: storageB,
      key,
    });

    persistenceA.schedule(anchorA);
    persistenceA.flush();
    persistenceB.schedule(anchorB);
    persistenceB.flush();
    persistenceA.dispose();
    persistenceB.dispose();

    const reloadedPersistenceA = createTerminalViewportPersistence({
      storage: storageA,
      key,
    });
    const reloadedPersistenceB = createTerminalViewportPersistence({
      storage: storageB,
      key,
    });

    expect(readTerminalViewportAnchor(storageA, key)).toEqual(anchorA);
    expect(readTerminalViewportAnchor(storageB, key)).toEqual(anchorB);
    reloadedPersistenceA.dispose();
    reloadedPersistenceB.dispose();
  });

  it("keeps the other client's position when one client reloads and saves", () => {
    const { clientA, clientB } = createSameOriginClients();
    const key = terminalViewportStorageKey("terminal-a");
    const anchorA = { distanceFromTail: 70, outputSequence: 42 };
    const anchorB = { distanceFromTail: 310, outputSequence: 91 };
    const storageA = terminalViewportStorageForClient(
      clientA.window as unknown as Window,
    );
    const storageB = terminalViewportStorageForClient(
      clientB.window as unknown as Window,
    );
    const persistenceA = createTerminalViewportPersistence({
      storage: storageA,
      key,
    });
    const persistenceB = createTerminalViewportPersistence({
      storage: storageB,
      key,
    });

    persistenceA.schedule(anchorA);
    persistenceA.flush();
    persistenceB.schedule(anchorB);
    persistenceB.flush();
    persistenceA.dispose();
    persistenceB.dispose();

    const reloadedClientAPersistence = createTerminalViewportPersistence({
      storage: storageA,
      key,
    });
    reloadedClientAPersistence.schedule({
      distanceFromTail: 22,
      outputSequence: 55,
    });
    reloadedClientAPersistence.flush();

    expect(readTerminalViewportAnchor(storageA, key)).toEqual({
      distanceFromTail: 22,
      outputSequence: 55,
    });
    expect(readTerminalViewportAnchor(storageB, key)).toEqual(anchorB);
    expect(clientA.window.localStorage.getItem(key)).toBeNull();
    reloadedClientAPersistence.dispose();
  });
});
