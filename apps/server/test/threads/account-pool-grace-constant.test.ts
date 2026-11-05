import { ARCHIVE_UNDO_GRACE_MS } from "@bb/domain";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps Account Pooler's archive grace aligned with the domain contract", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../plugins/account-pool/src/server.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const matches = [
    ...source.matchAll(/const ARCHIVE_UNDO_GRACE_MS = ([\d_]+);/g),
  ];
  expect(matches).toHaveLength(1);
  expect(Number(matches[0]![1]!.replaceAll("_", ""))).toBe(
    ARCHIVE_UNDO_GRACE_MS,
  );
});
