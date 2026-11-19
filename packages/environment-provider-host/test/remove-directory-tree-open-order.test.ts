import { tmpdir } from "node:os";
import path from "node:path";
import { fstatSync } from "node:fs";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TIMESTAMP_LAG_MS,
  removeDirectoryTree,
} from "../src/remove-directory-tree.js";
import {
  asyncRemoveTreeIo,
  installRemoveTreeIo,
  removeTreeIo,
  type RemoveTreeIo,
} from "../src/remove-tree-io.js";
import { syncRemoveTreeIo } from "../src/remove-tree-sync-io.js";

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

const events: OpenEvent[] = [];
const descriptor = /^\/proc\/self\/fd\/(\d+)$/u;

function recording(base: RemoveTreeIo): RemoveTreeIo {
  return {
    ...base,
    open: async (target, flags, mode) => {
      const fd = await base.open(target, flags, mode);
      if (typeof flags !== "number") return fd;
      const opened = fstatSync(fd);
      events.push({
        kind: "open",
        path: target,
        flags,
        dev: opened.dev,
        ino: opened.ino,
        fd,
      });
      return fd;
    },
    fstat: async (fd) => {
      events.push({ kind: "stat", fd });
      return await base.fstat(fd);
    },
    fstatBigint: async (fd) => {
      events.push({ kind: "stat", fd });
      return await base.fstatBigint(fd);
    },
    stat: async (target) => {
      const match = descriptor.exec(target);
      if (match?.[1] !== undefined)
        events.push({ kind: "stat", fd: Number(match[1]) });
      return await base.stat(target);
    },
  };
}

const LINUX_O_PATH = 0o10000000;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function settledTree(): Promise<string> {
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
    describe.each([
      ["synchronous", syncRemoveTreeIo],
      ["asynchronous", asyncRemoveTreeIo],
    ] as const)("on the %s backend", (_backend, base) => {
      it.each([
        ["a directory", "nested", "the inspection pass", false],
        ["a directory", "nested", "the removal pass", true],
        ["a file", "top.txt", "the per-file check", false],
      ] as const)(
        "opens %s named %s on another mount only with O_PATH, and reads its mount id before any fstat, at %s",
        async (_kind, name, _phase, afterRemovalStarts) => {
          const root = await settledTree();
          const target = path.join(root, name);
          const identity = await fs.stat(target);
          let removing = false;
          const shifted = new Set<number>();
          events.splice(0);
          const realRoot = await fs.realpath(root);
          const previous = removeTreeIo();
          installRemoveTreeIo(recording(base));
          const result = await removeDirectoryTree(root, {
            startedAt: Number.MAX_SAFE_INTEGER,
            beforeEntryRemoval: async () => {
              removing = true;
            },
            readMountTable: async () =>
              `36 1 0:51 / ${realRoot}/elsewhere rw - tmpfs none rw\n`,
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
          }).finally(() => installRemoveTreeIo(previous));
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
    });
  },
);
