import { expect, test } from "bun:test";
import { creditGuardBlock, creditGuardUsedPercent, paidCredits } from "./creditGuard";
import { selectProjectAccount } from "./projectSelection";
import type { DurableQuotaObservation } from "./migration/contracts";

const now = Date.parse("2026-10-15T00:00:00Z");
function observation(usedPercent: number, hasCredits = true): DurableQuotaObservation {
  return { engine: "codex", accountId: "account-a", authenticated: true, authCheckedAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(), bootId: "fixture", provenance: { source: "live", reason: null, staleSince: null },
    limits: { session: null, weekly: { usedPercent, resetsAt: now / 1000 + 3600 }, plan: "pro", capturedAt: now / 1000,
      credits: { hasCredits, balance: hasCredits ? "10" : "0", unlimited: false } } };
}
const accounts = [{ id: "account-a", authPresent: true }, { id: "account-b", authPresent: true }];

test.each(["hasCredits", "has_credits"])("retains paid credits from %s independently of reset credits", field => {
  expect(paidCredits({ [field]: true, balance: "12.50", unlimited: false })).toEqual({ hasCredits: true, balance: "12.50", unlimited: false });
  expect(paidCredits({ availableCount: 1 })).toBeUndefined();
});

test("99 percent guards each paid account; uncredited accounts keep their final percent", () => {
  expect(creditGuardBlock("codex", observation(98.99).limits)).toBeNull();
  expect(creditGuardBlock("codex", observation(99).limits)).toEqual({ resetsAt: now / 1000 + 3600 });
  expect(creditGuardBlock("codex", observation(99, false).limits)).toBeNull();
  expect(creditGuardBlock("claude", observation(99).limits)).toBeNull();
  const limits = observation(10).limits!;
  limits.session = { usedPercent: 99, resetsAt: now / 1000 + 300 };
  expect(creditGuardBlock("codex", limits)).not.toBeNull();
});

test("guard configuration always stays below paid-credit exhaustion", () => {
  for (const value of [undefined, "", "0", "-1", "100", "101", "NaN"]) {
    expect(creditGuardUsedPercent({ LLV_CODEX_CREDIT_GUARD_USED_PERCENT: value })).toBe(99);
  }
  expect(creditGuardUsedPercent({ LLV_CODEX_CREDIT_GUARD_USED_PERCENT: "98.5" })).toBe(98.5);
});

test.each([false, true])("paid guard fences automatic, pinned and explicit selection (bound=%s)", bound => {
  const input = { project: "project", engine: "codex" as const, accounts, observations: [observation(99)],
    bindings: bound ? accounts.map(account => ({ project: "project", engine: "codex" as const, accountId: account.id, createdAt: new Date(now).toISOString() })) : [],
    now, preferredId: "account-a" };
  expect(selectProjectAccount(input)).toEqual({ kind: "available", accountId: "account-b" });
  for (const requestedChoice of ["explicit", "fenced"] as const) {
    expect(selectProjectAccount({ ...input, requestedId: "account-a", requestedChoice }).kind).toBe("exhausted");
  }
  expect(selectProjectAccount({ ...input, observations: [observation(99, false)], requestedId: "account-a" }).kind).toBe("available");
});

test("staleness and a predicted reset cannot release the guard; a fresh reading can", () => {
  const input = { project: null, engine: "codex" as const, accounts: accounts.slice(0, 1), observations: [observation(99)], bindings: [],
    preferredId: "account-a", now: now + 2 * 3600_000 };
  expect(selectProjectAccount(input).kind).toBe("exhausted");
  expect(selectProjectAccount({ ...input, observations: [observation(1)] }).kind).toBe("available");
});
