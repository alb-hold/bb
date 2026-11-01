import { expect, it } from "vitest";
import {
  normalizeUsageMeasurement,
  selectUsageResources,
} from "./usage-normalization.js";
import { usageMeasurementSchema } from "./usage-source-contract.js";

it("merges only matching provider-issued identities, preferring shared observations without summing limits", () => {
  const host = {
    id: "machine",
    providerId: "custom",
    accountKey: "issuer:account:1",
    scope: { kind: "host" as const },
    percent: 40,
  };
  const shared = {
    ...host,
    id: "pool",
    scope: { kind: "shared" as const },
    percent: 50,
  };
  const unknown = { ...host, id: "unknown", accountKey: null };
  const other = { ...host, id: "other", accountKey: "issuer:account:2" };
  const differentProvider = { ...shared, providerId: "different" };
  expect(
    selectUsageResources(
      [
        host,
        shared,
        unknown,
        { ...unknown, id: "unknown2" },
        other,
        differentProvider,
      ],
      (resource) => resource,
    ),
  ).toEqual([
    shared,
    unknown,
    { ...unknown, id: "unknown2" },
    other,
    differentProvider,
  ]);
  expect(selectUsageResources([host], (resource) => resource)).toEqual([host]);
});

it("normalizes structured plans and windows while retaining custom provider labels", () => {
  const raw = usageMeasurementSchema.parse({
    observedAt: 123,
    usage: {
      status: "ok",
      accountEmail: null,
      planLabel: null,
      plan: { id: "max", multiplier: 20 },
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "168 hour window",
          model: null,
          usedPercent: 50,
          resetsAt: null,
          cost: null,
        },
        {
          id: "fable",
          kind: "weekly",
          label: "Fable",
          model: "fable",
          usedPercent: 25,
          resetsAt: null,
          cost: null,
        },
        {
          id: "custom",
          label: "Monthly tokens",
          model: null,
          usedPercent: 5,
          resetsAt: null,
          cost: null,
        },
      ],
    },
  });
  expect(normalizeUsageMeasurement(raw, "claude-code")).toMatchObject({
    accountKey: null,
    usage: {
      planLabel: "Claude subscription",
      windows: [
        { label: "Weekly limit" },
        { label: "Weekly · Fable" },
        { label: "Monthly tokens" },
      ],
    },
  });
});

it("preserves provider plan names over legacy structured tiers", () => {
  const raw = usageMeasurementSchema.parse({
    observedAt: 123,
    usage: {
      status: "ok",
      accountEmail: null,
      planLabel: "Ultra",
      plan: { id: "max", multiplier: 20 },
      windows: [],
    },
  });
  expect(normalizeUsageMeasurement(raw, "claude-code").usage).toMatchObject({
    planLabel: "Ultra",
  });
});

it.each([
  {
    providerId: "claude-code",
    multiplier: 20,
    expected: "Claude subscription",
  },
  { providerId: "custom", multiplier: 5, expected: "Max (5x)" },
])(
  "scopes an unnamed Max plan to $providerId",
  ({ providerId, multiplier, expected }) => {
    const raw = usageMeasurementSchema.parse({
      observedAt: 123,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: null,
        plan: { id: "max", multiplier },
        windows: [],
      },
    });
    expect(normalizeUsageMeasurement(raw, providerId).usage).toMatchObject({
      planLabel: expected,
    });
  },
);
