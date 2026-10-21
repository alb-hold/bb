import { describe, expect, it } from "vitest";
import {
  childThreadModel,
  assertRequestedModelAllowed,
} from "./child-thread-model.js";
import { withTestHarness } from "../../../test/helpers/test-app.js";

describe("childThreadModel", () => {
  it("runs a child on the model its provider declares for children", () => {
    expect(
      childThreadModel({
        parentThreadId: "thr_parent",
        declaredChildModel: "child-model",
      }),
    ).toBe("child-model");
  });

  it("leaves top-level threads, where orchestrators run, alone", () => {
    for (const parentThreadId of [null, undefined, ""]) {
      expect(
        childThreadModel({ parentThreadId, declaredChildModel: "child-model" }),
      ).toBeNull();
    }
  });

  it("leaves children of a provider that declares no child model alone", () => {
    for (const declaredChildModel of [null, undefined]) {
      expect(
        childThreadModel({ parentThreadId: "thr_parent", declaredChildModel }),
      ).toBeNull();
    }
  });

  it("waits for the real provider policy before allowing an explicit child model", async () => {
    await withTestHarness(async (harness) => {
      const registry = harness.deps.providerRegistry;
      const registeredProvider = registry.get.bind(registry);
      let registrationsReady = false;
      let releaseRegistrations: () => void = () => undefined;
      const registrations = new Promise<void>((resolve) => {
        releaseRegistrations = resolve;
      });
      registry.get = (providerId) =>
        registrationsReady ? registeredProvider(providerId) : null;
      registry.whenRegistrationsSettled = () => registrations;

      let completed = false;
      const result = assertRequestedModelAllowed(harness.deps, {
        childScope: "parent",
        model: "claude-opus-5-5",
        providerId: "claude-code",
        sources: { model: "explicit" },
      }).finally(() => {
        completed = true;
      });

      await Promise.resolve();
      expect(completed).toBe(false);
      registrationsReady = true;
      releaseRegistrations();
      await expect(result).rejects.toMatchObject({
        status: 400,
        body: { code: "child_model_conflict" },
      });
    });
  });

  it.each([
    {
      name: "a top-level thread",
      childScope: null,
      providerId: "claude-code",
    },
    {
      name: "a provider without a child model",
      childScope: "parent" as const,
      providerId: "codex",
    },
  ])(
    "allows an explicit model for $name",
    async ({ childScope, providerId }) => {
      await withTestHarness(async (harness) => {
        await expect(
          assertRequestedModelAllowed(harness.deps, {
            childScope,
            model: "claude-opus-5-5",
            providerId,
            sources: { model: "explicit" },
          }),
        ).resolves.toBeUndefined();
      });
    },
  );

  it("allows an implicit model when a present source object omits model", async () => {
    await withTestHarness(async (harness) => {
      await expect(
        assertRequestedModelAllowed(harness.deps, {
          childScope: "parent",
          model: "claude-opus-5-5",
          providerId: "claude-code",
          sources: { reasoningLevel: "explicit" },
        }),
      ).resolves.toBeUndefined();
    });
  });
});
