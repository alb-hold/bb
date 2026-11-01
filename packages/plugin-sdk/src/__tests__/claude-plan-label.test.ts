import { expect, it } from "vitest";
import {
  claudeLocalPlanLabel,
  claudeProfilePlanLabel,
} from "../claude-plan-label.js";

it.each([
  {
    name: "Max",
    subscriptionType: "max",
    rateLimitTier: "max_5x",
    expected: "Claude subscription",
  },
  {
    name: null,
    subscriptionType: "max",
    rateLimitTier: "max_5x",
    expected: "Claude subscription",
  },
  {
    name: "Ultra",
    subscriptionType: "max",
    rateLimitTier: "max_20x",
    expected: "Ultra",
  },
  {
    name: "Max",
    subscriptionType: "max",
    rateLimitTier: "max_20x",
    expected: "Ultra",
  },
  {
    name: "Max",
    subscriptionType: "max",
    rateLimitTier: null,
    expected: "Claude subscription",
  },
  {
    name: "Claude Ultra",
    subscriptionType: "max",
    rateLimitTier: "max_20x",
    expected: "Ultra",
  },
  {
    name: null,
    subscriptionType: "max",
    rateLimitTier: "max_20x",
    expected: "Ultra",
  },
  {
    name: null,
    subscriptionType: "claude_max",
    rateLimitTier: "max_20x",
    expected: "Ultra",
  },
  {
    name: null,
    subscriptionType: "pro",
    rateLimitTier: "max_20x",
    expected: "Ultra",
  },
  { name: null, subscriptionType: "pro", rateLimitTier: null, expected: "Pro" },
  {
    name: null,
    subscriptionType: null,
    rateLimitTier: null,
    expected: "Claude subscription",
  },
  {
    name: null,
    subscriptionType: "team",
    rateLimitTier: null,
    expected: "Team",
  },
])(
  "labels $name / $subscriptionType / $rateLimitTier as $expected",
  ({ name, subscriptionType, rateLimitTier, expected }) => {
    const profileLabel = claudeProfilePlanLabel({
      account: { rate_limit_tier: rateLimitTier },
      organization: { plan_display_name: name },
    });
    expect(profileLabel).toBe(
      name === null && rateLimitTier === null ? null : expected,
    );
    expect(
      profileLabel ?? claudeLocalPlanLabel({ subscriptionType, rateLimitTier }),
    ).toBe(expected);
  },
);
