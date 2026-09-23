import { expect, test } from "bun:test";

import type { DurableQuotaObservation } from "./migration/contracts";
import { selectHeadlessAccount } from "./headlessSelection";

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
