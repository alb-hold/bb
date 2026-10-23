import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMigratedConnection } from "../src/testing.js";
import {
  closeEnvironmentRetention,
  deleteEnvironmentRetentionIntents,
  findOpenEnvironmentRetentionOverlapping,
  listEnvironmentRetentionTransitions,
  listEnvironmentRetentionTransitionsForEnvironment,
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

  it("appends a transition for every change and keeps the closure after the row is reopened", () => {
    const db = createMigratedConnection();
    const row = recordEnvironmentRetention(db, { ...base, state: "intent" });
    recordEnvironmentRetention(db, { ...base, state: "retained", message: "kept" });
    closeEnvironmentRetention(db, { id: row.id, proof: "lstat ENOENT on host_a" });
    recordEnvironmentRetention(db, { ...base, state: "intent", message: "again" });

    expect(
      listEnvironmentRetentionTransitions(db, row.id).map((entry) => [
        entry.fromState,
        entry.toState,
      ]),
    ).toEqual([
      [null, "intent"],
      ["intent", "retained"],
      ["retained", "closed"],
      ["closed", "intent"],
    ]);
    const closing = listEnvironmentRetentionTransitions(db, row.id)[2];
    expect(closing).toMatchObject({
      detail: "lstat ENOENT on host_a",
      hostId: "host_a",
      path: "/work/a",
    });
    expect(closing?.at).toBeGreaterThan(0);
  });

  it("logs a deleted intent and a merged path-less intent instead of dropping them silently", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, {
      ...base,
      originalPath: null,
      keptPath: null,
      state: "intent",
    });
    recordEnvironmentRetention(db, { ...base, state: "intent" });
    expect(db.select().from(environmentRetentions).all()).toHaveLength(1);
    deleteEnvironmentRetentionIntents(db, "env_a", "nothing kept");

    expect(
      listEnvironmentRetentionTransitionsForEnvironment(db, "env_a").map(
        (entry) => entry.toState,
      ),
    ).toEqual(["intent", "intent", "merged", "deleted"]);
  });

  it("merges a path-less intent into a path row when a create throws, and leaves a path-less unresolved row alone otherwise", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, {
      ...base,
      originalPath: null,
      keptPath: null,
      state: "unresolved",
    });
    recordEnvironmentRetention(db, {
      ...base,
      environmentId: "env_b",
      originalPath: null,
      keptPath: null,
      state: "intent",
    });
    markEnvironmentRetentionsUnresolved(db, "env_b", "threw");
    expect(
      db
        .select()
        .from(environmentRetentions)
        .all()
        .map((row) => [row.environmentId, row.keptPath, row.state])
        .sort(),
    ).toEqual([
      ["env_a", null, "unresolved"],
      ["env_b", null, "unresolved"],
    ]);
  });

  describe("atomicity", () => {
    const failTransitions = (db: ReturnType<typeof createMigratedConnection>) =>
      db.$client.exec(
        "CREATE TRIGGER fail_transition BEFORE INSERT ON environment_retention_transitions BEGIN SELECT RAISE(ABORT, 'transition insert failed'); END;",
      );

    it("rolls a new row back when its transition cannot be written", () => {
      const db = createMigratedConnection();
      failTransitions(db);
      expect(() =>
        recordEnvironmentRetention(db, { ...base, state: "retained" }),
      ).toThrow("transition insert failed");
      expect(db.select().from(environmentRetentions).all()).toEqual([]);
    });

    it("leaves a row open and unchanged when its closure transition cannot be written", () => {
      const db = createMigratedConnection();
      const row = recordEnvironmentRetention(db, { ...base, state: "retained" });
      failTransitions(db);
      expect(() =>
        closeEnvironmentRetention(db, { id: row.id, proof: "absent" }),
      ).toThrow("transition insert failed");
      expect(db.select().from(environmentRetentions).all()[0]).toMatchObject({
        state: "retained",
        closedProof: null,
      });
    });

    it("keeps an intent when the transition for deleting it cannot be written", () => {
      const db = createMigratedConnection();
      recordEnvironmentRetention(db, { ...base, state: "intent" });
      failTransitions(db);
      expect(() => deleteEnvironmentRetentionIntents(db, "env_a")).toThrow(
        "transition insert failed",
      );
      expect(db.select().from(environmentRetentions).all()).toHaveLength(1);
    });

    it("keeps an intent as it was when the transition for marking it unresolved cannot be written", () => {
      const db = createMigratedConnection();
      recordEnvironmentRetention(db, { ...base, state: "intent" });
      failTransitions(db);
      expect(() =>
        markEnvironmentRetentionsUnresolved(db, "env_a", "threw"),
      ).toThrow("transition insert failed");
      expect(db.select().from(environmentRetentions).all()[0]?.state).toBe(
        "intent",
      );
    });
  });

  describe("freshness of a re-recorded row", () => {
    it("refreshes the time of an intent that is recorded again, so it is not judged by its old age", () => {
      const db = createMigratedConnection();
      const first = recordEnvironmentRetention(db, {
        ...base,
        originalPath: null,
        keptPath: null,
        state: "intent",
      });
      db.update(environmentRetentions)
        .set({ updatedAt: 1000 })
        .where(eq(environmentRetentions.id, first.id))
        .run();

      const again = recordEnvironmentRetention(db, {
        ...base,
        originalPath: null,
        keptPath: null,
        state: "intent",
      });

      expect(again.id).toBe(first.id);
      expect(again.updatedAt).toBeGreaterThan(1000);
      expect(Date.now() - again.updatedAt).toBeLessThan(5_000);
    });

    it("refuses to close a row that changed after it was read, and closes it when it did not", () => {
      const db = createMigratedConnection();
      const read = recordEnvironmentRetention(db, { ...base, state: "retained" });
      db.update(environmentRetentions)
        .set({ updatedAt: read.updatedAt })
        .where(eq(environmentRetentions.id, read.id))
        .run();
      const reRecorded = recordEnvironmentRetention(db, {
        ...base,
        state: "retained",
      });
      expect(reRecorded.updatedAt).toBeGreaterThan(read.updatedAt);

      expect(
        closeEnvironmentRetention(db, {
          id: read.id,
          proof: "stale",
          expectedUpdatedAt: read.updatedAt,
        }),
      ).toBe(false);
      expect(db.select().from(environmentRetentions).all()[0]?.state).toBe(
        "retained",
      );
      expect(
        closeEnvironmentRetention(db, {
          id: read.id,
          proof: "fresh",
          expectedUpdatedAt: reRecorded.updatedAt,
        }),
      ).toBe(true);
    });
  });
});
