import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  coarseFileTimestamp,
  untrustedTimestampFilesystem,
} from "../src/remove-directory-tree.js";

const tree = "/work/tree";

function types(tree: number, root = 0x1a) {
  return async (target: string) => ({ type: target === "/" ? root : tree });
}

describe("filesystems whose timestamps removal trusts", () => {
  it.each([
    ["ext4", 0xef53],
    ["xfs", 0x58465342],
    ["btrfs", 0x9123683e],
    ["tmpfs", 0x01021994],
  ])("trusts %s on Linux", async (_name, type) => {
    await expect(
      untrustedTimestampFilesystem(tree, {
        platform: "linux",
        statfs: types(type),
      }),
    ).resolves.toBeNull();
  });

  it("keeps WSL's 9p mount of a Windows drive on Linux", async () => {
    await expect(
      untrustedTimestampFilesystem(tree, {
        platform: "linux",
        statfs: types(0x01021997),
      }),
    ).resolves.toContain("type 0x1021997");
  });

  it("keeps an unknown filesystem type on Linux", async () => {
    await expect(
      untrustedTimestampFilesystem(tree, {
        platform: "linux",
        statfs: types(0x12345678),
      }),
    ).resolves.toContain("type 0x12345678");
  });

  it("trusts a macOS tree on the system volume's filesystem type", async () => {
    await expect(
      untrustedTimestampFilesystem(tree, {
        platform: "darwin",
        statfs: types(0x1a, 0x1a),
      }),
    ).resolves.toBeNull();
  });

  it("keeps a macOS tree on a different filesystem type than the system volume", async () => {
    await expect(
      untrustedTimestampFilesystem(tree, {
        platform: "darwin",
        statfs: types(0x11, 0x1a),
      }),
    ).resolves.toContain("type 0x11");
  });

  it("keeps a tree whose filesystem cannot be read", async () => {
    await expect(
      untrustedTimestampFilesystem(tree, {
        platform: "linux",
        statfs: async () => {
          throw new Error("EACCES: statfs denied");
        },
      }),
    ).resolves.toContain("EACCES: statfs denied");
  });

  it("keeps a tree on any other platform", async () => {
    await expect(
      untrustedTimestampFilesystem(tree, {
        platform: "win32",
        statfs: types(0xef53),
      }),
    ).resolves.toContain("win32");
  });

  it("trusts this host's temporary directory", async () => {
    await expect(untrustedTimestampFilesystem(tmpdir())).resolves.toBeNull();
  });
});

describe("whole-second file timestamps", () => {
  it("treats a ctime with no nanoseconds as coarse", () => {
    expect(coarseFileTimestamp(1_763_000_000_000_000_000n)).toBe(true);
  });

  it("treats a ctime with nanoseconds as fine", () => {
    expect(coarseFileTimestamp(1_763_000_000_732_434_237n)).toBe(false);
  });
});
