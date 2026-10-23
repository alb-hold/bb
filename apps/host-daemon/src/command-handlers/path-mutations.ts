import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import { isPathWithinDirectory } from "@bb/process-utils";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { refuseWhileHeld } from "./refuse-while-held.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";
import { resolveWriteTarget } from "./file-write.js";

function assertAbsolute(value: string, field: string): void {
  if (!path.isAbsolute(value)) {
    throw new CommandDispatchError("invalid_path", `${field} must be absolute`);
  }
}

async function requireRoot(
  rootPath: string | undefined,
): Promise<string | null> {
  if (rootPath === undefined) return null;
  assertAbsolute(rootPath, "rootPath");
  return resolveNonSymlinkDirectoryPath({
    description: "Root path",
    path: rootPath,
  });
}

function refuseOnWindows(action: string): void {
  if (process.platform === "win32") {
    throw new CommandDispatchError(
      "invalid_path",
      `Refusing to ${action}: this host cannot refuse links and aliases reliably on Windows, so the path cannot be proven to be what it names. Nothing was changed.`,
    );
  }
}

function refuseAlias(given: string, resolved: string): void {
  if (path.resolve(given) !== resolved) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${given}" reaches ${resolved} through a symbolic link or alias; pass the real path. Nothing was changed.`,
    );
  }
}

async function requireExistingWithin(
  targetPath: string,
  rootPath: string | undefined,
): Promise<{ target: string; root: string | null }> {
  assertAbsolute(targetPath, "Path");
  const targetInfo = await fs.lstat(targetPath);
  if (targetInfo.isSymbolicLink()) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${targetPath}" must not be a symbolic link`,
    );
  }
  const [target, root] = await Promise.all([
    fs.realpath(targetPath),
    requireRoot(rootPath),
  ]);
  refuseAlias(targetPath, target);
  if (root !== null && !isPathWithinDirectory(root, target)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${targetPath}" escapes root`,
    );
  }
  return { target, root };
}

async function requireDestinationWithin(
  destinationPath: string,
  rootPath: string | undefined,
): Promise<string> {
  assertAbsolute(destinationPath, "destinationPath");
  const [parent, root] = await Promise.all([
    fs.realpath(path.dirname(destinationPath)),
    requireRoot(rootPath),
  ]);
  refuseAlias(path.dirname(destinationPath), parent);
  const target = path.join(parent, path.basename(destinationPath));
  if (root !== null && !isPathWithinDirectory(root, target)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${destinationPath}" escapes root`,
    );
  }
  return target;
}

export async function mkdirHostPath(
  command: CommandOf<"host.mkdir">,
): Promise<HostDaemonOnlineRpcResult<"host.mkdir">> {
  assertAbsolute(command.path, "Path");
  const root = await requireRoot(command.rootPath);
  const target = await resolveWriteTarget(command.path, command.path);
  if (root !== null && !isPathWithinDirectory(root, target.writePath)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${command.path}" escapes root`,
    );
  }
  await fs.mkdir(target.writePath, { recursive: command.recursive });
  return { ok: true };
}

function refuseMove(sourcePath: string, reason: string): never {
  throw new CommandDispatchError(
    "invalid_path",
    `Refusing to move ${sourcePath}: ${reason}. Nothing was moved.`,
  );
}

export interface MoveHostFileHooks {
  afterOpen?: () => Promise<void>;
}

export async function moveHostFile(
  command: CommandOf<"host.move_file">,
  hooks: MoveHostFileHooks = {},
): Promise<HostDaemonOnlineRpcResult<"host.move_file">> {
  refuseOnWindows(`move ${command.sourcePath}`);
  const { target: source } = await requireExistingWithin(
    command.sourcePath,
    command.rootPath,
  );
  const destination = await requireDestinationWithin(
    command.destinationPath,
    command.rootPath,
  );
  let handle;
  try {
    handle = await fs.open(
      source,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      refuseMove(command.sourcePath, "it is a symbolic link or alias");
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      refuseMove(command.sourcePath, "it is not a single regular file");
    }
    await hooks.afterOpen?.();
    const existing = await fs.lstat(destination).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (existing !== null) {
      throw new CommandDispatchError(
        "path_exists",
        `Destination already exists: ${command.destinationPath}`,
      );
    }
    try {
      await fs.rename(source, destination);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "EXDEV") {
        refuseMove(
          command.sourcePath,
          "the destination is on another filesystem, and bb does not copy and delete",
        );
      }
      throw error;
    }
    const moved = await fs.lstat(destination);
    if (!moved.isFile() || moved.dev !== opened.dev || moved.ino !== opened.ino) {
      const sourceFree = await fs.lstat(source).then(
        () => false,
        () => true,
      );
      if (sourceFree) await fs.rename(destination, source);
      refuseMove(
        command.sourcePath,
        sourceFree
          ? "it changed while it was being moved, and it was put back"
          : "it changed while it was being moved, and it could not be put back because something new now occupies its place",
      );
    }
    return { ok: true };
  } finally {
    await handle.close();
  }
}

export async function removeHostPath(
  command: CommandOf<"host.remove_path">,
): Promise<HostDaemonOnlineRpcResult<"host.remove_path">> {
  refuseOnWindows(`remove ${command.path}`);
  const { target, root } = await requireExistingWithin(
    command.path,
    command.rootPath,
  );
  if (root !== null && target === root) {
    throw new CommandDispatchError(
      "invalid_path",
      "Cannot remove the declared root",
    );
  }
  const targetInfo = await fs.lstat(target);
  if (targetInfo.isDirectory() && command.recursive) {
    await refuseWhileHeld({ directory: target, action: "remove" });
  }
  if (targetInfo.isDirectory() && !command.recursive) {
    await fs.rmdir(target);
  } else {
    await fs.rm(target, { recursive: command.recursive, force: false });
  }
  return { ok: true };
}
