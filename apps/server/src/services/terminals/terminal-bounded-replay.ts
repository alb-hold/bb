import { Buffer } from "node:buffer";
import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import type { TerminalOutputChunk } from "@bb/server-contract";
import { TerminalScreenState } from "./terminal-screen-state.js";

interface Replay {
  replayStartSeq: number;
  nextSeq: number;
  chunks: TerminalOutputChunk[];
}

interface ReplayInput extends Replay {
  terminalId: string;
  daemonSessionId: string;
  cols: number;
  rows: number;
}

export class TerminalBoundedReplay {
  private readonly snapshots = new Map<string, Replay>();
  private readonly pending = new Map<string, Promise<Replay>>();
  private bytes = 0;
  private generation = 0;

  compact(args: ReplayInput): Promise<Replay> {
    if (
      args.nextSeq !== args.replayStartSeq + args.chunks.length ||
      args.chunks.some(
        (chunk, index) => chunk.seq !== args.replayStartSeq + index,
      )
    )
      return Promise.resolve(args);
    const key = [
      args.terminalId,
      args.daemonSessionId,
      args.cols,
      args.rows,
      args.replayStartSeq,
      args.nextSeq,
    ].join(":");
    const cached = this.snapshots.get(key);
    if (cached !== undefined) {
      this.snapshots.delete(key);
      this.snapshots.set(key, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending;
    const generation = this.generation;
    const work = this.build(args, key, generation)
      .catch(() => args)
      .finally(() => {
        if (this.pending.get(key) === work) this.pending.delete(key);
      });
    this.pending.set(key, work);
    return work;
  }

  private async build(
    args: ReplayInput,
    key: string,
    generation: number,
  ): Promise<Replay> {
    const raw = Buffer.concat(
      args.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
    );
    if (raw.length < TERMINAL_DATA_MAX_BYTES * 2) return args;
    const state = new TerminalScreenState(args.cols, args.rows, true);
    try {
      state.push(0, raw);
      const snapshot = await state.replaySnapshot();
      if (snapshot === null || generation !== this.generation) return args;
      const data = Buffer.from(snapshot.dataBase64, "base64");
      const count = Math.ceil(data.length / TERMINAL_DATA_MAX_BYTES);
      const replayStartSeq = args.nextSeq - count;
      if (data.length >= raw.length || replayStartSeq < args.replayStartSeq)
        return args;
      const replay = {
        replayStartSeq,
        nextSeq: args.nextSeq,
        chunks: Array.from({ length: count }, (_, index) => ({
          seq: replayStartSeq + index,
          dataBase64: data
            .subarray(
              index * TERMINAL_DATA_MAX_BYTES,
              (index + 1) * TERMINAL_DATA_MAX_BYTES,
            )
            .toString("base64"),
        })),
      };
      this.snapshots.set(key, replay);
      this.bytes += data.length;
      while (this.snapshots.size > 16 || this.bytes > 8 * 1024 * 1024) {
        const oldest = this.snapshots.entries().next().value;
        if (oldest === undefined) break;
        this.snapshots.delete(oldest[0]);
        this.bytes -= oldest[1].chunks.reduce(
          (sum, chunk) => sum + Buffer.byteLength(chunk.dataBase64, "base64"),
          0,
        );
      }
      return replay;
    } finally {
      state.dispose();
    }
  }

  clear(): void {
    this.generation += 1;
    this.snapshots.clear();
    this.pending.clear();
    this.bytes = 0;
  }
}
