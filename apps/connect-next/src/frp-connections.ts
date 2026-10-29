import type { Duplex } from "node:stream";

interface FrpConnection {
  id: number;
  sockets: Duplex[];
  label: string | null;
  runId: string;
  goodbye: (() => void) | null;
}

export interface FrpConnections {
  websocketOrigin(): string;
  track(clientAddress: string, sockets: Duplex[], goodbye?: () => void): void;
  loggedIn(clientAddress: string, label: string, runId: string): void;
  claim(label: string, runId: string): number | null;
  isOpen(connectionId: number): boolean;
  holds(label: string, runId: string): boolean;
  close(label: string): number;
  closeAll(): number;
  count(label: string): number;
}

export function createFrpConnections(): FrpConnections {
  let next = 0;
  let nextConnectionId = 0;
  const open = new Map<string, FrpConnection>();

  function end(connection: FrpConnection): void {
    if (connection.goodbye !== null) {
      connection.goodbye();
      return;
    }
    for (const socket of connection.sockets) socket.destroy();
  }

  function matching(label: string): [string, FrpConnection][] {
    return [...open].filter(([, connection]) => connection.label === label);
  }

  return {
    websocketOrigin() {
      next += 1;
      return `http://frpc-${next}.gate.invalid`;
    },
    track(clientAddress, sockets, goodbye) {
      nextConnectionId += 1;
      const connection: FrpConnection = {
        id: nextConnectionId,
        sockets,
        label: null,
        runId: "",
        goodbye: goodbye ?? null,
      };
      open.set(clientAddress, connection);
      for (const socket of sockets) {
        socket.once("close", () => {
          if (open.get(clientAddress) === connection)
            open.delete(clientAddress);
        });
      }
    },
    loggedIn(clientAddress, label, runId) {
      const connection = open.get(clientAddress);
      if (connection === undefined) return;
      connection.label = label;
      connection.runId = runId;
    },
    claim(label, runId) {
      if (runId === "") return null;
      const candidates = matching(label).filter(
        ([, connection]) =>
          connection.runId === "" || connection.runId === runId,
      );
      const only = candidates.length === 1 ? candidates[0]?.[1] : undefined;
      if (only === undefined) return null;
      only.runId = runId;
      return only.id;
    },
    isOpen(connectionId) {
      return [...open.values()].some(
        (connection) => connection.id === connectionId,
      );
    },
    holds(label, runId) {
      return [...open.values()].some(
        (connection) =>
          connection.label === label && connection.runId === runId,
      );
    },
    close(label) {
      const found = matching(label);
      for (const [clientAddress, connection] of found) {
        open.delete(clientAddress);
        end(connection);
      }
      return found.length;
    },
    closeAll() {
      const all = [...open.values()];
      open.clear();
      for (const connection of all) end(connection);
      return all.length;
    },
    count: (label) => matching(label).length,
  };
}
