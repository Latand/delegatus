import { describe, expect, test } from "bun:test";

import { chooseAutoBalance, effectiveRemaining } from "./quotaPolicy";
import type { AutoBalancePolicy, MigrationEngine } from "./contracts";

const now = Date.parse("2026-07-10T12:00:00.000Z");
const policy = (): AutoBalancePolicy => ({ enabled: true, revision: 0, cooldownUntil: null, departed: {}, lastOutcome: null, lastTrigger: null, lastCheckAt: null, sustain: null, restartedAt: new Date(now).toISOString() });
const observation = (accountId: string, session: number, weekly: number, source: "live" | "cache" = "live") => ({ engine: "codex" as MigrationEngine, accountId, authenticated: true, limits: { session: { usedPercent: session, resetsAt: null }, weekly: { usedPercent: weekly, resetsAt: null }, plan: null, capturedAt: Math.floor(now / 1000) }, provenance: { source, reason: null, staleSince: null }, observedAt: now });

describe("quota migration policy", () => {
  test("uses the minimum remaining window and deterministic account id tie break", () => {
    expect(effectiveRemaining(observation("a", 20, 90), now)).toEqual({ percent: 10, window: "weekly" });
    const decision = chooseAutoBalance("codex", "a", [observation("a", 80, 90), observation("b-work", 30, 10), observation("c-work", 30, 10)], policy(), now);
    expect(decision?.targetId).toBe("b-work");
    expect(decision?.evidence.sourcePercent).toBe(10);
  });

  test("requires fresh live ownership and obeys strict threshold and hysteresis", () => {
    expect(chooseAutoBalance("codex", "a", [observation("a", 75, 75), observation("b", 74.999, 74.999)], policy(), now)).toBeNull();
    expect(chooseAutoBalance("codex", "a", [observation("a", 80, 80), observation("b", 10, 10, "cache")], policy(), now)).toBeNull();
    const blocked = policy(); blocked.departed.b = new Date(now - 1_000).toISOString();
    expect(chooseAutoBalance("codex", "a", [observation("a", 80, 80), observation("b", 70, 70)], blocked, now)).toBeNull();
  });

  test("rejects invalid percentages and timestamps before an automatic decision", () => {
    const invalidPercent = observation("a", 101, 10);
    const invalidTime = { ...observation("a", 80, 10), observedAt: Number.NaN };
    const invalidReset = { ...observation("a", 80, 10), limits: { ...observation("a", 80, 10).limits, session: { usedPercent: 80, resetsAt: -1 } } };
    expect(effectiveRemaining(invalidPercent, now)).toBeNull();
    expect(effectiveRemaining(invalidTime, now)).toBeNull();
    expect(effectiveRemaining(invalidReset, now)).toBeNull();
    expect(chooseAutoBalance("codex", "a", [invalidPercent, observation("b", 10, 10)], policy(), now)).toBeNull();
  });

  test("seeded policy cases preserve threshold, eligibility, and deterministic winner", () => {
    let state = 40;
    const next = () => { state = (state * 1103515245 + 12345) >>> 0; return state; };
    for (let index = 0; index < 250; index += 1) {
      const activeUsed = next() % 101;
      const leftUsed = next() % 101;
      const rightUsed = next() % 101;
      const decision = chooseAutoBalance("codex", "active", [
        observation("active", activeUsed, activeUsed),
        observation("left", leftUsed, leftUsed),
        observation("right", rightUsed, rightUsed),
      ], policy(), now);
      if (!decision) continue;
      const source = effectiveRemaining(observation("active", activeUsed, activeUsed), now)!;
      const target = effectiveRemaining(observation(decision.targetId, decision.targetId === "left" ? leftUsed : rightUsed, decision.targetId === "left" ? leftUsed : rightUsed), now)!;
      expect(source.percent).toBeLessThan(25);
      expect(target.percent).toBeGreaterThan(25);
      const eligible = ["left", "right"].filter((id) => {
        const used = id === "left" ? leftUsed : rightUsed;
        return 100 - used > 25;
      }).sort((a, b) => {
        const usedA = a === "left" ? leftUsed : rightUsed;
        const usedB = b === "left" ? leftUsed : rightUsed;
        return usedA - usedB || a.localeCompare(b);
      });
      expect(decision.targetId).toBe(eligible[0]);
    }
  });
});

describe("per-model tier gating (#1358, #1796, #1431)", () => {
  /* Invented readings. `tiers` is what the provider meters per model tier; the
     account below reports Fable and Opus and nothing for Sonnet or Haiku. */
  const claude = (session: number, weekly: number, tiers: { tier: string; usedPercent: number }[]) => ({
    engine: "claude" as MigrationEngine,
    accountId: "a",
    authenticated: true,
    limits: {
      session: { usedPercent: session, resetsAt: null },
      weekly: { usedPercent: weekly, resetsAt: null },
      tiers: tiers.map((entry) => ({ usedPercent: entry.usedPercent, resetsAt: null, windowMinutes: 10_080, tier: entry.tier })),
      plan: "max",
      capturedAt: Math.floor(now / 1000),
    },
    provenance: { source: "live" as const, reason: null, staleSince: null },
    observedAt: now,
  });
  const metered = claude(20, 40, [{ tier: "fable", usedPercent: 95 }, { tier: "opus", usedPercent: 90 }]);

  test("each model answers to its own tier window, and an unstated model to the launch default's", () => {
    expect(effectiveRemaining(metered, now, { model: "fable" })).toEqual({ percent: 5, window: "tier:fable" });
    expect(effectiveRemaining(metered, now, { model: "claude-fable-5-1" })).toEqual({ percent: 5, window: "tier:fable" });
    expect(effectiveRemaining(metered, now, { model: "claude-opus-5" })).toEqual({ percent: 10, window: "tier:opus" });
    // No model stated resolves to the launch default, which is Opus.
    expect(effectiveRemaining(metered, now)).toEqual({ percent: 10, window: "tier:opus" });
  });

  test("a model the provider meters no bucket for is gated by the general windows only (#1431)", () => {
    expect(effectiveRemaining(metered, now, { model: "sonnet" })).toEqual({ percent: 60, window: "weekly" });
    expect(effectiveRemaining(metered, now, { model: "claude-haiku-4-5-20251001" })).toEqual({ percent: 60, window: "weekly" });
  });

  test("a comfortable tier window never lifts the minimum, and no buckets at all changes nothing", () => {
    expect(effectiveRemaining(claude(20, 40, [{ tier: "opus", usedPercent: 5 }]), now)).toEqual({ percent: 60, window: "weekly" });
    expect(effectiveRemaining(claude(20, 40, []), now)).toEqual({ percent: 60, window: "weekly" });
  });

  test("codex observations ignore any tier windows", () => {
    const codex = { ...metered, engine: "codex" as MigrationEngine };
    expect(effectiveRemaining(codex, now)).toEqual({ percent: 60, window: "weekly" });
  });
});


test("auto-balance compares the chosen model's tier", () => {
  const make = (id: string, fable: number, opus: number) => ({ ...observation(id, 10, 20), engine: "claude" as const,
    limits: { ...observation(id, 10, 20).limits, tiers: [
      { tier: "fable", usedPercent: fable, resetsAt: null },
      { tier: "opus", usedPercent: opus, resetsAt: null },
    ] },
  });
  const samples = [make("a", 95, 10), make("b", 10, 100)];
  expect(chooseAutoBalance("claude", "a", samples, policy(), now, { model: "fable" })?.targetId).toBe("b");
  expect(chooseAutoBalance("claude", "a", samples, policy(), now, { model: "sonnet" })).toBeNull();
  expect(chooseAutoBalance("claude", "a", samples, policy(), now, { model: "opus" })).toBeNull();
});
