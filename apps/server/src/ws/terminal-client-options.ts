import {
  TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL,
  TERMINAL_REPLAY_BATCH_WEBSOCKET_PROTOCOL,
} from "@bb/server-contract";

export function terminalClientProtocolOptions(
  origin: string | undefined,
  protocol: string | undefined,
): { rawReplay: boolean; resizeSeqEcho: boolean } {
  return {
    rawReplay: origin === undefined,
    resizeSeqEcho:
      protocol === TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL ||
      protocol === TERMINAL_REPLAY_BATCH_WEBSOCKET_PROTOCOL,
  };
}
