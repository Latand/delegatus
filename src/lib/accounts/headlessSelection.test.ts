import { expect, test } from "bun:test";

import type { DurableQuotaObservation } from "./migration/contracts";
import { accountQuotaVerdict, selectHeadlessAccount } from "./headlessSelection";

const NOW = Date.parse("2026-07-12T10:00:00.000Z");

function observation(accountId: string, usedPercent: number, resetsAt: number | null = null): DurableQuotaObservation {
  return {
    engine: "codex",
    accountId,
    authenticated: true,
    authCheckedAt: new Date(NOW - 1_000).toISOString(),
    limits: {
      session: { usedPercent, resetsAt },
      weekly: null,
      plan: "pro",
      capturedAt: Math.floor((NOW - 1_000) / 1_000),
    },
    provenance: { source: "live", reason: null, staleSince: null },
    observedAt: new Date(NOW - 1_000).toISOString(),
    bootId: ["boot", "selection", "1371"].join("-"),
  };
}

const accounts = [
  { id: "default", authPresent: true },
  { id: "spare", authPresent: true },
];

const RESET = Math.floor(NOW / 1_000) + 86_400;

test.each(["claude", "codex"] as const)("%s spends the soonest binding window before a larger balance", (engine) => {
  const samples = [observation("default", 10, RESET + 86_400), observation("spare", 50, RESET)].map(sample => ({ ...sample, engine }));
  for (const pool of [accounts, [...accounts].reverse()]) {
    expect(selectHeadlessAccount(pool, samples, "default", [], NOW)).toEqual({ kind: "available", accountId: "spare" });
  }
  samples[0]!.limits!.session!.usedPercent = 50;
  expect(selectHeadlessAccount(accounts, samples, "default", [], NOW)).toEqual({ kind: "available", accountId: "spare" });
});

test.each([74, 75, 99, 100])("a soon-resetting account at %i percent used only wins with adequate headroom", (used) => {
  expect(selectHeadlessAccount(accounts, [observation("default", 10, RESET + 86_400), observation("spare", used, RESET)], "default", [], NOW))
    .toEqual({ kind: "available", accountId: used < 75 ? "spare" : "default" });
});

test("small balances stay eligible and keep headroom order when no account is adequate", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 90, RESET), observation("spare", 80, RESET + 86_400)], "default", [], NOW))
    .toEqual({ kind: "available", accountId: "spare" });
  expect(selectHeadlessAccount([accounts[0]!], [observation("default", 99, RESET)], null, [], NOW))
    .toEqual({ kind: "available", accountId: "default" });
});

test.each([
  ["unknown", null], ["at reset", Math.floor(NOW / 1_000)], ["past reset", Math.floor(NOW / 1_000) - 1],
] as const)("an unknown or passed binding reset (%s) falls back to headroom for the group", (_label, reset) => {
  const third = { id: "third", authPresent: true };
  const samples = [observation("default", 10, RESET + 86_400), observation("spare", 50, RESET), observation("third", 30, reset)];
  for (const pool of [[...accounts, third], [third, ...accounts], [...accounts].reverse().concat(third)]) {
    expect(selectHeadlessAccount(pool, samples, "spare", [], NOW)).toEqual({ kind: "available", accountId: "default" });
  }
});

test("equal resets use headroom, routing preference, then stable id", () => {
  const samples = [observation("default", 10, RESET), observation("spare", 30, RESET)];
  expect(selectHeadlessAccount(accounts, samples, "spare", [], NOW)).toEqual({ kind: "available", accountId: "default" });
  samples[1]!.limits!.session!.usedPercent = 10;
  expect(selectHeadlessAccount(accounts, samples, "spare", [], NOW)).toEqual({ kind: "available", accountId: "spare" });
  expect(selectHeadlessAccount([...accounts].reverse(), samples, null, [], NOW)).toEqual({ kind: "available", accountId: "default" });
});

test("the tightest window binds; tied windows use the latest reset and unknown stays unknown", () => {
  const a = observation("default", 5, RESET);
  a.limits!.weekly = { usedPercent: 50, resetsAt: RESET + 86_400 };
  const b = observation("spare", 50, RESET + 3_600);
  const pick = () => selectHeadlessAccount(accounts, [a, b], "default", [], NOW);
  expect(pick()).toEqual({ kind: "available", accountId: "spare" });
  a.limits!.session!.usedPercent = 50;
  expect(pick()).toEqual({ kind: "available", accountId: "spare" });
  a.limits!.weekly.resetsAt = null;
  expect(pick()).toEqual({ kind: "available", accountId: "default" });
});

test("only the launch model's own tier can set Claude's binding reset", () => {
  const a = { ...observation("default", 5, RESET), engine: "claude" as const };
  a.limits!.weekly = { usedPercent: 20, resetsAt: RESET };
  a.limits!.tiers = [{ tier: "opus", usedPercent: 50, resetsAt: RESET + 86_400 }, { tier: "sonnet", usedPercent: 100, resetsAt: RESET }];
  const b = { ...observation("spare", 50, RESET + 3_600), engine: "claude" as const };
  expect(selectHeadlessAccount(accounts, [a, b], "default", [], NOW, "opus")).toEqual({ kind: "available", accountId: "spare" });
  expect(selectHeadlessAccount(accounts, [a, b], "default", [], NOW, "haiku")).toEqual({ kind: "available", accountId: "default" });
});

test("stale or cached reset evidence cannot outrank confirmed live headroom; retry order still leads", () => {
  const a = observation("default", 10, RESET + 86_400);
  const b = observation("spare", 50, RESET);
  for (const changed of [
    { ...b, observedAt: new Date(NOW - 6 * 60_000).toISOString() },
    { ...b, provenance: { source: "cache" as const, reason: "offline", staleSince: b.observedAt } },
  ]) expect(selectHeadlessAccount(accounts, [a, changed], "spare", [], NOW)).toEqual({ kind: "available", accountId: "default" });
  expect(selectHeadlessAccount(accounts, [a, b], "spare", ["spare"], NOW)).toEqual({ kind: "available", accountId: "default" });
});

test("reset ranking preserves the paid-credit guard", () => {
  const guarded = observation("spare", 99, RESET);
  guarded.limits!.credits = { hasCredits: true, balance: "10", unlimited: false };
  expect(selectHeadlessAccount(accounts, [observation("default", 50, RESET + 86_400), guarded], "spare", [], NOW))
    .toEqual({ kind: "available", accountId: "default" });
});

test("headless selection chooses the authenticated account with the most fresh quota headroom", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 100), observation("spare", 25)], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("headless selection uses an unobserved account before declaring confirmed exhaustion", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 100)], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("a fresh transcript-reconciled usage limit removes that account from automatic admission (#1371)", () => {
  const limited = observation("default", 100, Math.floor(NOW / 1_000) + 900);
  limited.provenance = { source: "transcript", reason: "transcript-reconciled", staleSince: null };
  expect(selectHeadlessAccount(accounts, [limited, observation("spare", 25)], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

function copilotSnapshot(accountId: string, usedPercent: number, resetsAt: number | null, observedAt = NOW - 10 * 60_000): DurableQuotaObservation {
  return {
    engine: "copilot",
    accountId,
    authenticated: true,
    authCheckedAt: new Date(NOW - 1_000).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
    bootId: "copilot-monthly-test",
    limits: {
      session: null,
      weekly: { usedPercent, resetsAt, windowMinutes: 43_200, observedAt: Math.floor(observedAt / 1_000) },
      tiers: [],
      plan: null,
      capturedAt: Math.floor(observedAt / 1_000),
    },
    provenance: { source: "transcript", reason: null, staleSince: null },
  };
}

test("a stale exhausted Copilot monthly window blocks that account until reset", () => {
  const reset = Math.floor(NOW / 1_000) + 86_400;
  expect(selectHeadlessAccount(accounts, [copilotSnapshot("default", 100, reset), observation("spare", 10)], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("stale partial or reset-expired Copilot snapshots are unknown", () => {
  const freshExhausted = observation("spare", 100, Math.floor(NOW / 1_000) + 86_400);
  expect(selectHeadlessAccount(accounts, [copilotSnapshot("default", 10, Math.floor(NOW / 1_000) + 86_400), freshExhausted], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "default",
  });
  expect(selectHeadlessAccount(accounts, [copilotSnapshot("default", 100, Math.floor(NOW / 1_000) - 1), freshExhausted], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "default",
  });
});

test("stale signed-out observations remain unknown for every engine; fresh sign-out is unavailable", () => {
  const staleSignedOut = (engine: DurableQuotaObservation["engine"]): DurableQuotaObservation => ({
    ...observation("default", 50),
    engine,
    authenticated: false,
    authCheckedAt: new Date(NOW - 60 * 60_000).toISOString(),
    observedAt: new Date(NOW - 60 * 60_000).toISOString(),
    provenance: { source: "cache", reason: null, staleSince: null },
  });
  const singleAccount = [{ id: "default", authPresent: true }];
  for (const engine of ["claude", "codex", "copilot"] as const) {
    expect(selectHeadlessAccount(singleAccount, [staleSignedOut(engine)], "default", [], NOW)).toEqual({
      kind: "available",
      accountId: "default",
    });
  }
  const freshSignedOut = { ...staleSignedOut("copilot"), authCheckedAt: new Date(NOW - 1_000).toISOString(), observedAt: new Date(NOW - 1_000).toISOString(), provenance: { source: "live" as const, reason: null, staleSince: null } };
  expect(selectHeadlessAccount(singleAccount, [freshSignedOut], "default", [], NOW)).toEqual({ kind: "unavailable" });
});

test("headless selection reports the earliest account recovery when every account is exhausted", () => {
  const firstReset = Math.floor(NOW / 1_000) + 900;
  const secondReset = Math.floor(NOW / 1_000) + 1_800;
  expect(selectHeadlessAccount(accounts, [observation("default", 100, secondReset), observation("spare", 100, firstReset)], null, [], NOW)).toEqual({
    kind: "exhausted",
    resetsAt: firstReset,
  });
});

test("headless selection keeps reset unknown when any exhausted governing window lacks a reset", () => {
  const reset = Math.floor(NOW / 1_000) + 900;
  const mixedReset = observation("default", 100, reset);
  mixedReset.limits!.weekly = { usedPercent: 100, resetsAt: null };
  expect(selectHeadlessAccount([accounts[0]!], [mixedReset], "default", [], NOW)).toEqual({
    kind: "exhausted",
    resetsAt: null,
  });
});

test("headless selection keeps reset unknown when exhausted evidence names an expired reset", () => {
  const expiredReset = Math.floor(NOW / 1_000) - 1;
  expect(selectHeadlessAccount([accounts[0]!], [observation("default", 100, expiredReset)], "default", [], NOW)).toEqual({
    kind: "exhausted",
    resetsAt: null,
  });
});

test("the hold verdict keeps an expired reset that selection reports as unknown, and the reading it rests on (#3158)", () => {
  const expiredReset = Math.floor(NOW / 1_000) - 1;
  const observations = [observation("default", 100, expiredReset)];
  expect(accountQuotaVerdict(observations, "default", NOW)).toEqual({
    capacity: "exhausted", resetsAt: expiredReset, observedAt: new Date(NOW - 1_000).toISOString() });
  expect(accountQuotaVerdict([observation("default", 100)], "default", NOW)).toMatchObject({ capacity: "exhausted", resetsAt: null });
});

test("headless retry prefers an eligible account that has not already failed", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 20), observation("spare", 30)], "default", ["default"], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("headless retry chooses an untried unknown-capacity account before a tried account with known headroom", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 20)], "default", ["default"], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("headless selection distinguishes missing authentication from exhausted quota", () => {
  expect(selectHeadlessAccount([{ id: "default", authPresent: false }], [], "default", [], NOW)).toEqual({ kind: "unavailable" });
});

test("headless selection excludes fresh live signed-out evidence even when credentials remain on disk", () => {
  const signedOut = { ...observation("default", 20), authenticated: false };
  expect(selectHeadlessAccount(accounts, [signedOut], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("headless selection treats a fresh reached-limit reading as exhausted while its windows still have room", () => {
  const reached = { ...observation("default", 10), limitReached: true };
  expect(selectHeadlessAccount(accounts, [reached], "default", [], NOW)).toEqual({ kind: "available", accountId: "spare" });
  expect(selectHeadlessAccount([accounts[0]!], [reached], "default", [], NOW)).toEqual({ kind: "exhausted", resetsAt: null });
  // A later reading that says it is no longer reached, or a mark past the freshness horizon, restores it.
  expect(selectHeadlessAccount([accounts[0]!], [{ ...reached, limitReached: false }], "default", [], NOW)).toEqual({ kind: "available", accountId: "default" });
  expect(selectHeadlessAccount([accounts[0]!], [reached], "default", [], NOW + 5 * 60_000)).toEqual({ kind: "available", accountId: "default" });
  // Only the provider's live word counts; a carried reading does not refuse on it.
  expect(selectHeadlessAccount([accounts[0]!], [{ ...reached, provenance: { source: "cache", reason: "quota-probe-failed", staleSince: null } }], "default", [], NOW)).toEqual({ kind: "available", accountId: "default" });
});

test("headless selection honours a fresh reached-limit reading that carries no percentage window", () => {
  const bare = { ...observation("default", 0), limitReached: true, limits: { session: null, weekly: null, plan: "pro", capturedAt: Math.floor((NOW - 1_000) / 1_000) } };
  expect(selectHeadlessAccount(accounts, [bare], "default", [], NOW)).toEqual({ kind: "available", accountId: "spare" });
  expect(selectHeadlessAccount([accounts[0]!], [bare], "default", [], NOW)).toEqual({ kind: "exhausted", resetsAt: null });
  // A probe that read the marker but no limits at all says the same.
  expect(selectHeadlessAccount([accounts[0]!], [{ ...bare, limits: null }], "default", [], NOW)).toEqual({ kind: "exhausted", resetsAt: null });
  // A confirmed clear marker, the freshness horizon, or a carried reading leaves the account unknown and eligible.
  expect(selectHeadlessAccount([accounts[0]!], [{ ...bare, limitReached: false }], "default", [], NOW)).toEqual({ kind: "available", accountId: "default" });
  expect(selectHeadlessAccount([accounts[0]!], [bare], "default", [], NOW + 5 * 60_000)).toEqual({ kind: "available", accountId: "default" });
  expect(selectHeadlessAccount([accounts[0]!], [{ ...bare, provenance: { source: "cache", reason: "quota-probe-failed", staleSince: null } }], "default", [], NOW)).toEqual({ kind: "available", accountId: "default" });
});
