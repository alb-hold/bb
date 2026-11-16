import { fstatSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

type OpenEvent =
  | {
      kind: "open";
      path: string;
      flags: number;
      dev: number;
      ino: number;
      fd: number;
    }
  | { kind: "stat"; fd: number }
  | { kind: "fdinfo"; fd: number };

const events = vi.hoisted(() => [] as OpenEvent[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const descriptor = /^\/proc\/self\/fd\/(\d+)$/u;
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (typeof args[1] !== "number") return handle;
      const fd = handle.fd;
      const opened = fstatSync(fd);
      events.push({
        kind: "open",
        path: String(args[0]),
        flags: args[1],
        dev: opened.dev,
        ino: opened.ino,
        fd,
      });
      const original = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: (async (...options: Parameters<FileHandle["stat"]>) => {
          events.push({ kind: "stat", fd });
          return await original(...options);
        }) as FileHandle["stat"],
      });
      return handle;
    },
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const match = descriptor.exec(String(args[0]));
      if (match?.[1] !== undefined)
        events.push({ kind: "stat", fd: Number(match[1]) });
      return await fs.stat(...args);
    },
  };
});

import {
  FILE_TIMESTAMP_LAG_MS,
  removeDirectoryTree,
} from "../src/remove-directory-tree.js";

const LINUX_O_PATH = 0o10000000;
const roots: string[] = [];

async function actualFs() {
  return await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
}

afterEach(async () => {
  const fs = await actualFs();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function settledTree(): Promise<string> {
  const fs = await actualFs();
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-open-order-"));
  roots.push(parent);
  const root = path.join(parent, "tree");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "nested", "kept.txt"), "kept\n");
  await fs.writeFile(path.join(root, "top.txt"), "top\n");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return root;
}

describe.runIf(process.platform === "linux")(
  "the order of checks after each open",
  () => {
    it.each([
      ["a directory", "nested", "the inspection pass", false],
      ["a directory", "nested", "the removal pass", true],
      ["a file", "top.txt", "the per-file check", false],
    ] as const)(
      "opens %s named %s on another mount only with O_PATH, and reads its mount id before any fstat, at %s",
      async (_kind, name, _phase, afterRemovalStarts) => {
        const fs = await actualFs();
        const root = await settledTree();
        const target = path.join(root, name);
        const identity = await fs.stat(target);
        let removing = false;
        const shifted = new Set<number>();
        events.splice(0);
        const result = await removeDirectoryTree(root, {
          startedAt: Number.MAX_SAFE_INTEGER,
          beforeEntryRemoval: async () => {
            removing = true;
          },
          readDescriptorInfo: async (_entry, fd) => {
            events.push({ kind: "fdinfo", fd });
            const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
            const opened = fstatSync(fd);
            const isTarget =
              opened.dev === identity.dev && opened.ino === identity.ino;
            if (!isTarget || (afterRemovalStarts && !removing)) return info;
            shifted.add(fd);
            return info.replace(
              /^mnt_id:\s*(\d+)$/mu,
              (_line, id: string) => `mnt_id:\t${Number(id) + 1}`,
            );
          },
        });
        const recorded = events.splice(0);
        expect(shifted.size).toBeGreaterThan(0);
        expect(result).toMatchObject({ status: "retained" });
        expect(result.mountedPaths).toContain(target);
        const targetOpens = recorded.flatMap((event, index) =>
          event.kind === "open" &&
          !/^\/proc\/self\/fd\/\d+$/u.test(event.path) &&
          event.dev === identity.dev &&
          event.ino === identity.ino
            ? [{ ...event, index }]
            : [],
        );
        expect(targetOpens.length).toBeGreaterThan(0);
        for (const opened of targetOpens) {
          expect(opened.flags & LINUX_O_PATH).toBe(LINUX_O_PATH);
          const later = recorded.slice(opened.index + 1);
          const closedAt = later.findIndex(
            (event) => event.kind === "open" && event.fd === opened.fd,
          );
          const window = closedAt === -1 ? later : later.slice(0, closedAt);
          const firstCheck = window.find(
            (event) =>
              (event.kind === "stat" || event.kind === "fdinfo") &&
              event.fd === opened.fd,
          );
          expect(firstCheck?.kind).toBe("fdinfo");
        }
      },
    );
  },
);
