import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";

type TerminalReplayMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.replay" }
>;

export class TerminalOutputSequenceRebase {
  private readonly bases = new Map<string, number>();

  setBase(terminalId: string, base: number): void {
    if (base <= 0) this.bases.delete(terminalId);
    else this.bases.set(terminalId, base);
  }

  toServer(terminalId: string, seq: number): number {
    return seq + (this.bases.get(terminalId) ?? 0);
  }

  toDaemon(terminalId: string, seq: number): number {
    return Math.max(0, seq - (this.bases.get(terminalId) ?? 0));
  }

  baseFor(terminalId: string): number {
    return this.bases.get(terminalId) ?? 0;
  }

  replayToServer(
    message: TerminalReplayMessage,
    offset = this.baseFor(message.terminalId),
  ): TerminalReplayMessage {
    return {
      ...message,
      replayStartSeq: message.replayStartSeq + offset,
      nextSeq: message.nextSeq + offset,
      chunks: message.chunks.map((chunk) => ({
        ...chunk,
        seq: chunk.seq + offset,
      })),
    };
  }
}
