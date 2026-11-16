import { describe, expect, it } from "vitest";
import {
  keptForChangedData,
  keptTreeReasons,
  PARTIALLY_REMOVED_REASON,
  type RemoveDirectoryTreeResult,
  UNANCHORED_DIRECTORY_REASON,
} from "../src/remove-directory-tree.js";

const changed = "new or changed data was found during removal";

function kept(
  fields: Partial<RemoveDirectoryTreeResult>,
): RemoveDirectoryTreeResult {
  return {
    status: "retained",
    retainedPaths: [],
    mountedPaths: [],
    unanchoredPaths: [],
    removalStarted: false,
    ...fields,
  };
}

describe("the reasons given for a kept tree", () => {
  const rows: Array<{
    name: string;
    result: RemoveDirectoryTreeResult;
    reasons: string[];
  }> = [
    {
      name: "a keep at the parent names only the anchor failure",
      result: kept({
        unanchoredPaths: ["/work"],
        retainedPaths: ["/work/tree"],
      }),
      reasons: [`${UNANCHORED_DIRECTORY_REASON}: /work`],
    },
    {
      name: "a keep mid-removal adds that the tree may be partially removed",
      result: kept({
        unanchoredPaths: ["/work/tree/b"],
        retainedPaths: ["/work/tree/b", "/work/tree"],
        removalStarted: true,
      }),
      reasons: [
        `${UNANCHORED_DIRECTORY_REASON}: /work/tree/b`,
        PARTIALLY_REMOVED_REASON,
      ],
    },
    {
      name: "a mixed keep names the anchor failure and the changed data",
      result: kept({
        unanchoredPaths: ["/work/tree/b"],
        retainedPaths: ["/work/tree/b", "/work/tree/late.txt", "/work/tree"],
        removalStarted: true,
      }),
      reasons: [
        `${UNANCHORED_DIRECTORY_REASON}: /work/tree/b`,
        changed,
        PARTIALLY_REMOVED_REASON,
      ],
    },
    {
      name: "a mounted child names only the mount",
      result: kept({
        mountedPaths: ["/work/tree/mnt"],
        retainedPaths: ["/work/tree/mnt", "/work/tree"],
      }),
      reasons: ["a different filesystem is mounted here: /work/tree/mnt"],
    },
    {
      name: "a keep with no specific cause names the changed data",
      result: kept({ retainedPaths: ["/work/tree"] }),
      reasons: [changed],
    },
    {
      name: "a keep with no specific cause after removal began says both",
      result: kept({
        retainedPaths: ["/work/tree/late.txt", "/work/tree"],
        removalStarted: true,
      }),
      reasons: [changed, PARTIALLY_REMOVED_REASON],
    },
    {
      name: "a sibling whose name starts with the anchor failure's name is not explained by it",
      result: kept({
        unanchoredPaths: ["/work/tree/b"],
        retainedPaths: ["/work/tree/b", "/work/tree/bb"],
      }),
      reasons: [`${UNANCHORED_DIRECTORY_REASON}: /work/tree/b`, changed],
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      expect(keptTreeReasons(row.result, (entry) => entry, changed)).toEqual(
        row.reasons,
      );
      expect(keptForChangedData(row.result)).toBe(
        row.reasons.includes(changed),
      );
    });
  }
});
