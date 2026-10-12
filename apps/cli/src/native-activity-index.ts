import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import {
  readRecordField,
  type JsonlRecordLocation,
} from "./native-activity.js";

export class EvictedRecordIndex {
  private count = 0;
  private hashes = new BigUint64Array(8192);
  private offsets = new Float64Array(8192);
  private lengths = new Uint32Array(8192);

  constructor(private readonly recordIdField: string) {}

  get byteLength(): number {
    return (
      this.hashes.byteLength + this.offsets.byteLength + this.lengths.byteLength
    );
  }

  add(id: string, location: JsonlRecordLocation): void {
    if (this.count >= this.hashes.length * 0.75) this.grow();
    this.insert(this.hash(id), location);
  }

  has(id: string, file: string): boolean {
    const hash = this.hash(id);
    const mask = this.hashes.length - 1;
    let slot = Number(hash & BigInt(mask));
    while (this.lengths[slot] !== 0) {
      if (this.hashes[slot] === hash && this.matches(id, file, slot))
        return true;
      slot = (slot + 1) & mask;
    }
    return false;
  }

  private hash(id: string): bigint {
    return createHash("sha256").update(id).digest().readBigUInt64LE(0);
  }

  private insert(hash: bigint, location: JsonlRecordLocation): void {
    const mask = this.hashes.length - 1;
    let slot = Number(hash & BigInt(mask));
    while (this.lengths[slot] !== 0) slot = (slot + 1) & mask;
    this.hashes[slot] = hash;
    this.offsets[slot] = location.offset;
    this.lengths[slot] = location.length;
    this.count += 1;
  }

  private grow(): void {
    const hashes = this.hashes;
    const offsets = this.offsets;
    const lengths = this.lengths;
    this.hashes = new BigUint64Array(hashes.length * 2);
    this.offsets = new Float64Array(hashes.length * 2);
    this.lengths = new Uint32Array(hashes.length * 2);
    this.count = 0;
    for (let slot = 0; slot < hashes.length; slot += 1) {
      if (lengths[slot] !== 0) {
        this.insert(hashes[slot], {
          offset: offsets[slot],
          length: lengths[slot],
        });
      }
    }
  }

  private matches(id: string, file: string, slot: number): boolean {
    const buffer = Buffer.alloc(this.lengths[slot]);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(file, "r");
      const read = readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        this.offsets[slot],
      );
      if (read !== buffer.length) return true;
      const record: unknown = JSON.parse(buffer.toString("utf8"));
      return readRecordField(record, this.recordIdField) === id;
    } catch {
      return true;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
}
