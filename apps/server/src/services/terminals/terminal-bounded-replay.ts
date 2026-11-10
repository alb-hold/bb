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
  return JSON.stringify([
    args.terminalId,
    args.daemonSessionId,
    args.cols,
    args.rows,
  ]);
}

function replayBytes(args: Replay): number {
  return args.chunks.reduce(
    (sum, chunk) => sum + Buffer.byteLength(chunk.dataBase64, "base64"),
    0,
  );
}

interface PendingBuild {
  args: ReplayInput;
  promise: Promise<Replay>;
  resolve: (replay: Replay) => void;
}

export class TerminalBoundedReplay {
  private readonly snapshots = new Map<string, Replay>();
  private readonly incompatible = new Map<string, true>();
  private readonly pending = new Map<string, PendingBuild>();
  private bytes = 0;
  private building = false;
  private generation = 0;

  forAttach(args: ReplayInput): Replay {
    const identity = replayIdentity(args);
    const cached = this.cached(args, identity);
    if (cached?.nextSeq === args.nextSeq && cached.chunks.length === 1)
      return cached;
    if (
      this.incompatible.has(identity) ||
      replayBytes(args) < TERMINAL_DATA_MAX_BYTES * 2
    )
      return args;
    void this.compact(args);
    return cached ?? args;
  }

  private cached(args: ReplayInput, identity: string): Replay | undefined {
    const snapshot = this.snapshots.get(identity);
    if (
      !snapshot ||
      snapshot.nextSeq > args.nextSeq ||
      snapshot.nextSeq < args.replayStartSeq
    )
      return undefined;
    const suffix = args.chunks.slice(snapshot.nextSeq - args.replayStartSeq);
    if (
      suffix.some((chunk, i) => chunk.seq !== snapshot.nextSeq + i) ||
      snapshot.nextSeq + suffix.length !== args.nextSeq
    )
      return undefined;
    this.snapshots.delete(identity);
    this.snapshots.set(identity, snapshot);
    return suffix.length === 0
      ? snapshot
      : {
          replayStartSeq: snapshot.replayStartSeq,
          nextSeq: args.nextSeq,
          chunks: [...snapshot.chunks, ...suffix],
        };
  }

  compact(args: ReplayInput): Promise<Replay> {
    if (
      args.nextSeq !== args.replayStartSeq + args.chunks.length ||
      args.chunks.some((chunk, i) => chunk.seq !== args.replayStartSeq + i)
    )
      return Promise.resolve(args);
    const identity = replayIdentity(args);
    const cached = this.cached(args, identity);
    if (cached && cached.chunks.length === 1) return Promise.resolve(cached);
    if (
      this.incompatible.has(identity) ||
      replayBytes(args) < TERMINAL_DATA_MAX_BYTES * 2
    )
      return Promise.resolve(args);
    const queued = this.pending.get(identity);
    if (queued) {
      queued.args = args;
      return queued.promise.then((result) =>
        result.nextSeq === args.nextSeq ? result : args,
      );
    }
    let resolve: (replay: Replay) => void = () => {};
    const promise = new Promise<Replay>((done) => {
      resolve = done;
    });
    this.pending.set(identity, { args, promise, resolve });
    if (!this.building) {
      this.building = true;
      setImmediate(() => void this.drain());
    }
    return promise.then((result) =>
      result.nextSeq === args.nextSeq ? result : args,
    );
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const next = this.pending.entries().next().value;
        if (!next) break;
        const [identity, work] = next;
        this.pending.delete(identity);
        try {
          work.resolve(await this.build(work.args, identity, this.generation));
        } catch {
          work.resolve(work.args);
        }
      }
    } finally {
      this.building = false;
    }
  }

  private async build(
    args: ReplayInput,
    identity: string,
    generation: number,
  ): Promise<Replay> {
    const cached = this.cached(args, identity);
    if (cached?.chunks.length === 1) return cached;
    const input = cached ?? args;
    const rawBytes = replayBytes(args);
    const state = new TerminalScreenState(args.cols, args.rows, true);
    try {
      for (const [seq, chunk] of input.chunks.entries())
        state.pushBase64(seq, chunk.dataBase64);
      const snapshot = await state.replaySnapshot(
        Math.min(rawBytes, TERMINAL_DATA_MAX_BYTES + 1),
      );
      if (generation !== this.generation) return args;
      if (snapshot === null) {
        this.incompatible.set(identity, true);
        if (this.incompatible.size > 256) {
          const oldest = this.incompatible.keys().next().value;
          if (oldest !== undefined) this.incompatible.delete(oldest);
        }
        return args;
      }
      const bytes = Buffer.byteLength(snapshot.dataBase64, "base64");
      if (bytes >= rawBytes || bytes > TERMINAL_DATA_MAX_BYTES) return args;
      const replay = {
        replayStartSeq: args.nextSeq - 1,
        nextSeq: args.nextSeq,
        chunks: [{ seq: args.nextSeq - 1, dataBase64: snapshot.dataBase64 }],
      };
      const previous = this.snapshots.get(identity);
      if (previous) this.bytes -= replayBytes(previous);
      this.snapshots.delete(identity);
      this.snapshots.set(identity, replay);
      this.bytes += bytes;
      while (this.snapshots.size > 16 || this.bytes > 8 * 1024 * 1024) {
        const oldest = this.snapshots.entries().next().value;
        if (!oldest) break;
        this.snapshots.delete(oldest[0]);
        this.bytes -= replayBytes(oldest[1]);
      }
      return replay;
    } finally {
      state.dispose();
    }
  }

  clear(): void {
    this.generation += 1;
    this.snapshots.clear();
    this.incompatible.clear();
    for (const work of this.pending.values()) work.resolve(work.args);
    this.pending.clear();
    this.bytes = 0;
  }
}
