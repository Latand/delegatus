import { expect, test } from "bun:test";

import { ROLE_DEFAULTS } from "./defaults";
import { costClass, costWeight, tightestHeadroom } from "./costHints";

test("cost classes of the shipped defaults match the design's worked examples", () => {
  const byRole = Object.fromEntries(ROLE_DEFAULTS.map((role) => [role.id, costClass(role.config)]));
  expect(costWeight({ model: "gpt-6-astra", effort: "xhigh" })).toBe(9);
  expect(byRole.reviewer).toBe("very-heavy");
  expect(byRole.builder).toBe("heavy");
  expect(byRole.orchestrator).toBe("heavy");
  expect(byRole.cleaner).toBe("moderate");
  expect(costClass({ model: "haiku", effort: "low" })).toBe("light");
  /* An uncatalogued model counts as large. */
  expect(costWeight({ model: "gpt-9-unknown", effort: "low" })).toBe(6);
});

test("headroom reads the tightest window the model draws on", () => {
  const limits = { session: { usedPercent: 20 }, weekly: { usedPercent: 38 }, tiers: [{ tier: "seven_day_opus", usedPercent: 71 }, { tier: "seven_day_sonnet", usedPercent: 95 }] };
  expect(tightestHeadroom("claude", "opus", limits)).toEqual({ window: "weekly", percentLeft: 29 });
  expect(tightestHeadroom("claude", "haiku", limits)).toEqual({ window: "weekly", percentLeft: 62 });
  expect(tightestHeadroom("codex", "gpt-6-astra", null)).toBeNull();
});
