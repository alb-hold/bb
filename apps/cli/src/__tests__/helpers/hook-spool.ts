import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export function publishHooks(directory: string, jsonl: string): void {
  mkdirSync(directory, { recursive: true });
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    const numbers = readdirSync(directory)
      .filter((name) => /^\d{12}$/u.test(name))
      .map(Number);
    const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
    const descriptor = openSync(
      path.join(directory, String(next).padStart(12, "0")),
      "wx",
      0o600,
    );
    try {
      writeSync(descriptor, line);
    } finally {
      closeSync(descriptor);
    }
  }
}
