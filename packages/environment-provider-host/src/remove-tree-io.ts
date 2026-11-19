import {
  close,
  fchmod,
  fstat,
  open,
  read,
  write,
  type BigIntStats,
  type Stats,
} from "node:fs";
import * as fsPromises from "node:fs/promises";

export interface RemoveTreeIo {
  open(target: string, flags: string | number, mode?: number): Promise<number>;
  fstat(fd: number): Promise<Stats>;
  fstatBigint(fd: number): Promise<BigIntStats>;
  fchmod(fd: number, mode: number): Promise<void>;
  read(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<number>;
  write(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<number>;
  close(fd: number): Promise<void>;
  lstat(target: string): Promise<Stats>;
  lstatBigint(target: string): Promise<BigIntStats>;
  stat(target: string): Promise<Stats>;
  statfs(target: string): Promise<{ type: number }>;
  readFile(target: string): Promise<string>;
  readdir(target: string): Promise<string[]>;
  readlink(target: string): Promise<string>;
  realpath(target: string): Promise<string>;
  link(existing: string, created: string): Promise<void>;
  symlink(target: string, created: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(target: string): Promise<void>;
  rmdir(target: string): Promise<void>;
}

function settled<T>(
  start: (done: (error: Error | null, value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    start((error, value) => {
      if (error === null) resolve(value);
      else reject(error);
    });
  });
}

export const asyncRemoveTreeIo: RemoveTreeIo = {
  open: (target, flags, mode) =>
    settled((done) => open(target, flags, mode, done)),
  fstat: (fd) => settled((done) => fstat(fd, done)),
  fstatBigint: (fd) => settled((done) => fstat(fd, { bigint: true }, done)),
  fchmod: (fd, mode) =>
    settled<void>((done) =>
      fchmod(fd, mode, (error) => done(error, undefined)),
    ),
  read: (fd, buffer, offset, length, position) =>
    settled((done) => read(fd, buffer, offset, length, position, done)),
  write: (fd, buffer, offset, length, position) =>
    settled((done) => write(fd, buffer, offset, length, position, done)),
  close: (fd) =>
    settled<void>((done) =>
      close(fd, (error) => done(error ?? null, undefined)),
    ),
  lstat: (target) => fsPromises.lstat(target),
  lstatBigint: (target) => fsPromises.lstat(target, { bigint: true }),
  stat: (target) => fsPromises.stat(target),
  statfs: (target) => fsPromises.statfs(target),
  readFile: (target) => fsPromises.readFile(target, "utf8"),
  readdir: (target) => fsPromises.readdir(target),
  readlink: (target) => fsPromises.readlink(target),
  realpath: (target) => fsPromises.realpath(target),
  link: (existing, created) => fsPromises.link(existing, created),
  symlink: (target, created) => fsPromises.symlink(target, created),
  rename: (source, destination) => fsPromises.rename(source, destination),
  unlink: (target) => fsPromises.unlink(target),
  rmdir: (target) => fsPromises.rmdir(target),
};

let current: RemoveTreeIo = asyncRemoveTreeIo;

export function removeTreeIo(): RemoveTreeIo {
  return current;
}

export function installRemoveTreeIo(io: RemoveTreeIo): void {
  current = io;
}
