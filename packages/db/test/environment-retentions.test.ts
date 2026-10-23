import { describe, expect, it } from "vitest";
import { createMigratedConnection } from "../src/testing.js";
import {
  deleteEnvironmentRetentionIntents,
  findOpenEnvironmentRetentionOverlapping,
  listOpenEnvironmentRetentionsForHost,
  listOpenEnvironmentRetentionsForProject,
  markEnvironmentRetentionsUnresolved,
  recordEnvironmentRetention,
} from "../src/data/index.js";
import { environmentRetentions } from "../src/schema.js";

const base = {
  environmentId: "env_a",
  projectId: "proj_a",
  hostId: "host_a",
  ownerThreadId: "thr_a",
  providerId: "provider",
  originalPath: "/work/a",
  keptPath: "/work/a",
  message: "kept",
} as const;

describe("environment retentions", () => {
  it("outlives the environment and project rows, because it has no foreign keys", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, { ...base, state: "retained" });
    expect(listOpenEnvironmentRetentionsForHost(db, "host_a")).toHaveLength(1);
    expect(listOpenEnvironmentRetentionsForProject(db, "proj_a")).toHaveLength(
      1,
    );
  });

  it("updates the row for the same environment and path instead of adding another", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, { ...base, state: "intent" });
    recordEnvironmentRetention(db, { ...base, state: "retained" });
    const rows = db.select().from(environmentRetentions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("retained");
  });

  it("turns an intent unresolved and deletes only intents", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, { ...base, state: "intent" });
    recordEnvironmentRetention(db, {
      ...base,
      keptPath: "/work/b",
      state: "retained",
    });
    markEnvironmentRetentionsUnresolved(db, "env_a", "no result");
    expect(
      db
        .select()
        .from(environmentRetentions)
        .all()
        .map((row) => [row.keptPath, row.state])
        .sort(),
    ).toEqual([
      ["/work/a", "unresolved"],
      ["/work/b", "retained"],
    ]);
    recordEnvironmentRetention(db, {
      ...base,
      environmentId: "env_b",
      keptPath: "/work/c",
      state: "intent",
    });
    deleteEnvironmentRetentionIntents(db, "env_b");
    expect(db.select().from(environmentRetentions).all()).toHaveLength(2);
  });

  it("finds a retention at, above or below a path and none elsewhere", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, { ...base, state: "retained" });
    for (const path of ["/work/a", "/work/a/src/x.ts", "/work"]) {
      expect(
        findOpenEnvironmentRetentionOverlapping(db, { hostId: "host_a", path }),
        path,
      ).not.toBeNull();
    }
    expect(
      findOpenEnvironmentRetentionOverlapping(db, {
        hostId: "host_a",
        path: "/work/ab",
      }),
    ).toBeNull();
    expect(
      findOpenEnvironmentRetentionOverlapping(db, {
        hostId: "other",
        path: "/work/a",
      }),
    ).toBeNull();
  });
});
