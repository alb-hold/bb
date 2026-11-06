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

function replayIdentity(args: ReplayInput): string {
  return [args.terminalId, args.daemonSessionId, args.cols, args.rows].join(
    ":",
  );
}

function replayKey(args: ReplayInput): string {
  return `${replayIdentity(args)}:${args.replayStartSeq}:${args.nextSeq}`;
}

export class TerminalBoundedReplay {
  private readonly snapshots = new Map<string, Replay>();
  private readonly pending = new Map<string, Promise<Replay>>();
  private bytes = 0;
  private buildTail: Promise<void> = Promise.resolve();
  private generation = 0;

  forAttach(args: ReplayInput): Replay {
    const key = replayKey(args);
    const cached = this.snapshots.get(key);
    if (cached !== undefined) return cached;
    const generation = this.generation;
    setImmediate(() => {
      if (generation === this.generation) void this.compact(args);
    });
    const prefix = `${replayIdentity(args)}:`;
    let earlier: Replay | undefined;
    for (const [snapshotKey, snapshot] of this.snapshots) {
      if (
        snapshotKey.startsWith(prefix) &&
        snapshot.nextSeq < args.nextSeq &&
        snapshot.nextSeq >= args.replayStartSeq &&
        snapshot.replayStartSeq > Number(snapshotKey.split(":").at(-2)) &&
        (!earlier || snapshot.nextSeq > earlier.nextSeq)
      )
        earlier = snapshot;
    }
    if (earlier && args.nextSeq === args.replayStartSeq + args.chunks.length) {
      const suffix = args.chunks.slice(earlier.nextSeq - args.replayStartSeq);
      if (suffix.every((chunk, index) => chunk.seq === earlier.nextSeq + index))
        return {
          replayStartSeq: earlier.replayStartSeq,
          nextSeq: args.nextSeq,
          chunks: [...earlier.chunks, ...suffix],
        };
    }
    return args;
  }

  compact(args: ReplayInput): Promise<Replay> {
    if (
      args.nextSeq !== args.replayStartSeq + args.chunks.length ||
      args.chunks.some(
        (chunk, index) => chunk.seq !== args.replayStartSeq + index,
      )
    )
      return Promise.resolve(args);
    const key = replayKey(args);
    const cached = this.snapshots.get(key);
    if (cached !== undefined) {
      this.snapshots.delete(key);
      this.snapshots.set(key, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending;
    const generation = this.generation;
    const work = this.buildTail
      .then(() => this.build(args, key, generation))
      .catch(() => args)
      .finally(() => {
        if (this.pending.get(key) === work) this.pending.delete(key);
      });
    this.buildTail = work.then(() => undefined);
    this.pending.set(key, work);
    return work;
  }

  private async build(
    args: ReplayInput,
    key: string,
    generation: number,
  ): Promise<Replay> {
    if (generation !== this.generation) return args;
    const rawBytes = args.chunks.reduce(
      (sum, chunk) => sum + Buffer.byteLength(chunk.dataBase64, "base64"),
      0,
    );
    const fallback = (): Replay => {
      if (generation === this.generation) this.remember(key, args, rawBytes);
      return args;
    };
    if (rawBytes < TERMINAL_DATA_MAX_BYTES * 2) return fallback();
    const state = new TerminalScreenState(args.cols, args.rows, true);
    try {
      for (const [seq, chunk] of args.chunks.entries()) {
        state.pushBase64(seq, chunk.dataBase64);
      }
      const snapshot = await state.replaySnapshot();
      if (snapshot === null || generation !== this.generation)
        return fallback();
      const data = Buffer.from(snapshot.dataBase64, "base64");
      const count = Math.ceil(data.length / TERMINAL_DATA_MAX_BYTES);
      const replayStartSeq = args.nextSeq - count;
      if (data.length >= rawBytes || replayStartSeq < args.replayStartSeq)
        return fallback();
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
      this.remember(key, replay, data.length);
      return replay;
    } finally {
      state.dispose();
    }
  }

  private remember(key: string, replay: Replay, bytes: number): void {
    this.snapshots.set(key, replay);
    this.bytes += bytes;
    while (this.snapshots.size > 16 || this.bytes > 8 * 1024 * 1024) {
      const oldest = this.snapshots.entries().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest[0]);
      this.bytes -= oldest[1].chunks.reduce(
        (sum, chunk) => sum + Buffer.byteLength(chunk.dataBase64, "base64"),
        0,
      );
    }
  }

  clear(): void {
    this.generation += 1;
    this.snapshots.clear();
    this.pending.clear();
    this.bytes = 0;
  }
}
