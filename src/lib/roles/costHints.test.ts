import { expect, test } from "bun:test";

import { ROLE_DEFAULTS } from "./defaults";
import { costClass, costWeight, modelSizeClass, tightestHeadroom } from "./costHints";

test("cost classes of the shipped defaults reflect the selected model and effort", () => {
  const byRole = Object.fromEntries(ROLE_DEFAULTS.map((role) => [role.id, costClass(role.config)]));
  expect(costWeight({ model: "gpt-6.1-sol", effort: "xhigh" })).toBe(9);
  expect(byRole.reviewer).toBe("very-heavy");
  expect(byRole.builder).toBe("heavy");
  expect(byRole.orchestrator).toBe("heavy");
  expect(byRole.cleaner).toBe("light");
  expect(byRole.architect).toBe("very-heavy");
  expect(byRole["prod-auditor"]).toBe("very-heavy");
  expect(costClass({ model: "haiku", effort: "low" })).toBe("light");
  /* An uncatalogued model counts as large. */
  expect(costWeight({ model: "gpt-9-unknown", effort: "low" })).toBe(6);
});

test("GPT-6-Sol weighs as large and GPT-6-Luna as small, like their 5.6 namesakes", () => {
  expect(modelSizeClass("gpt-6-sol")).toBe(3);
  expect(modelSizeClass("gpt-6-luna")).toBe(1);
  expect(modelSizeClass("gpt-6.1-sol")).toBe(3);
  expect(modelSizeClass("gpt-6-sol")).toBe(modelSizeClass("gpt-5.6-sol"));
  expect(modelSizeClass("gpt-6-luna")).toBe(modelSizeClass("gpt-5.6-luna"));
});

test("headroom reads the tightest window the model draws on", () => {
  const limits = { session: { usedPercent: 20 }, weekly: { usedPercent: 38 }, tiers: [{ tier: "seven_day_opus", usedPercent: 71 }, { tier: "seven_day_sonnet", usedPercent: 95 }] };
  expect(tightestHeadroom("claude", "opus", limits)).toEqual({ window: "weekly", percentLeft: 29 });
  expect(tightestHeadroom("claude", "haiku", limits)).toEqual({ window: "weekly", percentLeft: 62 });
  expect(tightestHeadroom("codex", "gpt-6-astra", null)).toBeNull();
});

test("a pinned Claude id with the claude- prefix lands on its family's size class", () => {
  expect(modelSizeClass("claude-sonnet-5-5")).toBe(2);
  expect(modelSizeClass("claude-sonnet-5")).toBe(2);
  expect(modelSizeClass("claude-haiku-4-5")).toBe(1);
  expect(modelSizeClass("claude-opus-5-5")).toBe(3);
  expect(modelSizeClass("claude-fable-5-1")).toBe(3);
  expect(costClass({ model: "claude-sonnet-5-5", effort: "high" })).toBe(costClass({ model: "sonnet", effort: "high" }));
  const limits = { weekly: { usedPercent: 10 }, tiers: [{ tier: "seven_day_sonnet", usedPercent: 80 }] };
  expect(tightestHeadroom("claude", "claude-sonnet-5-5", limits)).toEqual(tightestHeadroom("claude", "sonnet", limits));
});
