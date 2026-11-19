import type {
  OwnWrite,
  RemoveDirectoryTreeResult,
  TreeMoveInspection,
} from "./remove-directory-tree-core.js";

export interface ChildRemovalOptions {
  startedAt: number;
  rootMetadataBaseline?: { ctimeMs: number; mtimeMs: number };
  ownWrites?: ReadonlyMap<string, OwnWrite>;
  expectedEntries?: ReadonlyMap<string, string>;
  allowQuarantinedRoot?: true;
}

export interface ChildInspectionOptions {
  startedAt: number;
  rootMetadata: { ctimeMs: number; mtimeMs: number };
}

export interface EncodedOwnWrite {
  dev: string;
  ino: string;
  size: string;
  ctimeNs: string;
  mtimeNs: string;
  sha256: string;
}

export interface EncodedChildRemovalOptions {
  startedAt: number;
  rootMetadataBaseline: { ctimeMs: number; mtimeMs: number } | null;
  ownWrites: [string, EncodedOwnWrite][];
  expectedEntries: [string, string][] | null;
  allowQuarantinedRoot: boolean;
}

export type ParentMessage =
  | { type: "start"; root: string; options: EncodedChildRemovalOptions }
  | { type: "inspect"; root: string; options: ChildInspectionOptions }
  | { type: "stop" };

export type ChildMessage =
  | { type: "ready" }
  | {
      type: "heartbeat";
      ops: number;
      entry: string;
      removalStarted: boolean;
      directory: boolean;
    }
  | {
      type: "result";
      result: RemoveDirectoryTreeResult;
      ops: number;
      voluntaryContextSwitches: number;
    }
  | {
      type: "inspection";
      inspection: TreeMoveInspection;
      ops: number;
      voluntaryContextSwitches: number;
    }
  | {
      type: "error";
      name: string;
      message: string;
      retainedPaths: string[];
    };

export function encodeChildRemovalOptions(
  options: ChildRemovalOptions,
): EncodedChildRemovalOptions {
  return {
    startedAt: options.startedAt,
    rootMetadataBaseline: options.rootMetadataBaseline ?? null,
    ownWrites: [...(options.ownWrites ?? new Map<string, OwnWrite>())].map(
      ([entry, write]) => [
        entry,
        {
          dev: write.dev.toString(),
          ino: write.ino.toString(),
          size: write.size.toString(),
          ctimeNs: write.ctimeNs.toString(),
          mtimeNs: write.mtimeNs.toString(),
          sha256: write.sha256,
        },
      ],
    ),
    expectedEntries:
      options.expectedEntries === undefined
        ? null
        : [...options.expectedEntries],
    allowQuarantinedRoot: options.allowQuarantinedRoot === true,
  };
}

export function decodeChildRemovalOptions(
  encoded: EncodedChildRemovalOptions,
): ChildRemovalOptions {
  return {
    startedAt: encoded.startedAt,
    ...(encoded.rootMetadataBaseline === null
      ? {}
      : { rootMetadataBaseline: encoded.rootMetadataBaseline }),
    ...(encoded.ownWrites.length === 0
      ? {}
      : {
          ownWrites: new Map(
            encoded.ownWrites.map(([entry, write]) => [
              entry,
              {
                dev: BigInt(write.dev),
                ino: BigInt(write.ino),
                size: BigInt(write.size),
                ctimeNs: BigInt(write.ctimeNs),
                mtimeNs: BigInt(write.mtimeNs),
                sha256: write.sha256,
              },
            ]),
          ),
        }),
    ...(encoded.expectedEntries === null
      ? {}
      : { expectedEntries: new Map(encoded.expectedEntries) }),
    ...(encoded.allowQuarantinedRoot ? { allowQuarantinedRoot: true } : {}),
  };
}
