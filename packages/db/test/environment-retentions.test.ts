import { describe, expect, it } from "vitest";
import { createMigratedConnection } from "../src/testing.js";
import {
  closeEnvironmentRetention,
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

  it("never downgrades a retained or unresolved row to an intent, and reopens a closed one", () => {
    const db = createMigratedConnection();
    const retained = recordEnvironmentRetention(db, {
      ...base,
      state: "retained",
    });
    expect(
      recordEnvironmentRetention(db, { ...base, state: "intent" }).state,
    ).toBe("retained");
    recordEnvironmentRetention(db, { ...base, state: "unresolved" });
    expect(
      recordEnvironmentRetention(db, { ...base, state: "retained" }).state,
    ).toBe("unresolved");
    expect(
      closeEnvironmentRetention(db, { id: retained.id, proof: "absent" }),
    ).toBe(true);
    expect(listOpenEnvironmentRetentionsForHost(db, "host_a")).toEqual([]);
    expect(
      recordEnvironmentRetention(db, { ...base, state: "intent" }).state,
    ).toBe("intent");
  });

  it("keeps one pathless intent per environment and lets it be resolved or deleted", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, {
      ...base,
      originalPath: null,
      keptPath: null,
      state: "intent",
    });
    recordEnvironmentRetention(db, {
      ...base,
      originalPath: null,
      keptPath: null,
      state: "intent",
    });
    expect(db.select().from(environmentRetentions).all()).toHaveLength(1);
    markEnvironmentRetentionsUnresolved(db, "env_a", "no answer");
    expect(db.select().from(environmentRetentions).all()[0]?.state).toBe(
      "unresolved",
    );
    expect(
      findOpenEnvironmentRetentionOverlapping(db, {
        hostId: "host_a",
        path: "/work/a",
      }),
    ).toBeNull();
  });

  it("records the closure proof and time on the row and stops blocking", () => {
    const db = createMigratedConnection();
    const row = recordEnvironmentRetention(db, { ...base, state: "retained" });
    expect(
      closeEnvironmentRetention(db, { id: row.id, proof: "lstat ENOENT on host_a" }),
    ).toBe(true);
    const closed = db.select().from(environmentRetentions).all()[0];
    expect(closed).toMatchObject({
      state: "closed",
      closedProof: "lstat ENOENT on host_a",
    });
    expect(closed?.closedAt).toBeGreaterThan(0);
    expect(closeEnvironmentRetention(db, { id: row.id, proof: "again" })).toBe(
      false,
    );
  });
});
