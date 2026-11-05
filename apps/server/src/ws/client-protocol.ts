import {
  clientMessageSchema,
  realtimeSubscriptionTargetKey,
  type PongMessage,
} from "@bb/domain";
import { parseSocketMessage } from "./decode-payload.js";
import type { NotificationHub } from "./hub.js";

const PONG_MESSAGE: PongMessage = { type: "pong" };

interface ClientSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export function onClientSocketOpen(
  hub: NotificationHub,
  socket: ClientSocket,
  isAppClient = false,
): void {
  hub.registerClient(socket, isAppClient);
}

export function onClientSocketMessage(
  hub: NotificationHub,
  socket: ClientSocket,
  raw: unknown,
): void {
  const parsed = parseSocketMessage(socket, raw, clientMessageSchema);
  if (parsed === null) {
    return;
  }

  switch (parsed.type) {
    case "device-handoff-device":
      hub.issueDeviceHandoffClientToken(socket, parsed.token);
      break;
    case "subscribe":
      for (const target of parsed.targets ??
        (parsed.target ? [parsed.target] : [])) {
        hub.subscribe(
          socket,
          target,
          parsed.timelineTags === undefined
            ? undefined
            : (parsed.timelineTags[realtimeSubscriptionTargetKey(target)] ??
                null),
        );
      }
      break;
    case "unsubscribe":
      for (const target of parsed.targets ??
        (parsed.target ? [parsed.target] : [])) {
        hub.unsubscribe(socket, target);
      }
      break;
    case "ping":
      socket.send(JSON.stringify(PONG_MESSAGE));
      break;
    case "device-handoff-view":
      hub.setDeviceHandoffView(
        socket,
        parsed.threadId,
        parsed.terminalSessionId,
      );
      break;
    case "device-handoff-ack":
      hub.acknowledgeDeviceHandoff(socket, parsed.id);
      break;
    case "visibility":
      hub.setClientVisible(socket, parsed.visible);
      break;
    default: {
      const _exhaustive: never = parsed;
      throw new Error(`Unhandled client message: ${_exhaustive}`);
    }
  }
}

export function onClientSocketClose(
  hub: NotificationHub,
  socket: ClientSocket,
): void {
  hub.unregisterClient(socket);
}
