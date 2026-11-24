import { expect, test } from "bun:test";

import {
  ANTIGRAVITY_QUOTA_WINDOW_MINUTES,
  antigravityLimitsFromExhaustion,
  isAntigravitySessionWindowActive,
  parseAntigravityQuotaError,
  redactAntigravityQuotaMessage,
} from "./antigravityQuota";

const BASE_MS = Date.parse("2026-11-24T01:00:00.000Z");
const BASE_SEC = Math.floor(BASE_MS / 1000);

test("parses explicit individual quota messages across spaced and compact reset duration formats", () => {
  const full = parseAntigravityQuotaError(
    "RESOURCE_EXHAUSTED: Individual quota reached for gemini-4-neon. Resets in 4h 12m 30s",
    BASE_MS,
  );
  expect(full).toEqual({
    exhausted: true,
    resetsAt: BASE_SEC + (4 * 3600 + 12 * 60 + 30),
    windowMinutes: ANTIGRAVITY_QUOTA_WINDOW_MINUTES,
    usedPercent: 100,
    observedAt: BASE_SEC,
    message: "RESOURCE_EXHAUSTED: Individual quota reached for gemini-4-neon. Resets in 4h 12m 30s",
  });

  const compact = parseAntigravityQuotaError(
    "Individual quota reached. Resets in 2h15m30s",
    BASE_MS,
  );
  expect(compact?.resetsAt).toBe(BASE_SEC + 2 * 3600 + 15 * 60 + 30);

  const spaced = parseAntigravityQuotaError(
    "Individual quota reached. Resets in 2h 15m 30s",
    BASE_MS,
  );
  expect(spaced?.resetsAt).toBe(compact?.resetsAt);

  // Malformed partial intervals MUST be rejected (`resetsAt: null`) instead of taking only the tail `30s`.
  expect(parseAntigravityQuotaError("Individual quota reached. Resets in 2h15x30s", BASE_MS)?.resetsAt).toBeNull();
  expect(parseAntigravityQuotaError("Individual quota reached. Resets in 2h 15x 30s", BASE_MS)?.resetsAt).toBeNull();

  const hoursMins = parseAntigravityQuotaError(
    "Individual quota reached for gemini-3.8-flash. Resets in 2h 15m",
    BASE_MS,
  );
  expect(hoursMins?.resetsAt).toBe(BASE_SEC + 2 * 3600 + 15 * 60);

  const minsOnly = parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Individual quota reached. Resets in 45m", BASE_MS);
  expect(minsOnly?.resetsAt).toBe(BASE_SEC + 45 * 60);

  const secsOnly = parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Individual quota reached. Resets in 90s", BASE_MS);
  expect(secsOnly?.resetsAt).toBe(BASE_SEC + 90);

  const verboseWords = parseAntigravityQuotaError(
    "Quota exceeded for account. Try again in 1 hour 5 minutes 10 seconds.",
    BASE_MS,
  );
  expect(verboseWords?.resetsAt).toBe(BASE_SEC + 3600 + 5 * 60 + 10);

  const isoReset = parseAntigravityQuotaError(
    "RESOURCE_EXHAUSTED: quota reached until 2026-11-24T04:30:00Z",
    BASE_MS,
  );
  expect(isoReset?.resetsAt).toBe(Math.floor(Date.parse("2026-11-24T04:30:00Z") / 1000));

  const noDuration = parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Individual quota reached", BASE_MS);
  expect(noDuration).toMatchObject({
    exhausted: true,
    resetsAt: null,
    windowMinutes: 300,
    usedPercent: 100,
    observedAt: BASE_SEC,
  });
});

test("rejects transient per-minute rate limits and non-quota errors, and redacts PII", () => {
  expect(parseAntigravityQuotaError("RESOURCE_EXHAUSTED: requests per minute exceeded; retry after 10 seconds", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("RESOURCE_EXHAUSTED: tokens per minute limit reached; retry after 15 seconds", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Rate limit exceeded; retry after 10 seconds", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Too many requests", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("RESOURCE_EXHAUSTED", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("UNAVAILABLE: retry after 10 seconds", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("ETIMEDOUT connecting to upstream", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("JSON-RPC -32602 invalid params", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("permission denied", BASE_MS)).toBeNull();
  expect(parseAntigravityQuotaError("", BASE_MS)).toBeNull();

  const fixtureEmail = ["fixture-user", "example.invalid"].join("@");
  const fixtureToken = ["ya29", "fixture_token_12345"].join(".");
  const fixturePath = ["", "home", "fixture-user", ".gemini", "creds.json"].join("/");
  const redacted = redactAntigravityQuotaMessage(
    `RESOURCE_EXHAUSTED for ${fixtureEmail} with ${fixtureToken} at ${fixturePath}`,
  );
  expect(redacted).not.toContain(fixtureEmail);
  expect(redacted).not.toContain(fixtureToken);
  expect(redacted).not.toContain(fixturePath);
  expect(redacted).toContain("[redacted-email]");
  expect(redacted).toContain("[redacted-token]");
  expect(redacted).toContain("[redacted-path]");
});

test("maps active exhaustion onto a 5h session window, expires identically at resetsAt and observedAt+5h, and isolates caller mutations", () => {
  const exhaustion = parseAntigravityQuotaError(
    "RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h 0m",
    BASE_MS,
  )!;

  const active = antigravityLimitsFromExhaustion(exhaustion, { nowMs: BASE_MS + 60_000, tierName: "Google AI Ultra" });
  expect(active.active).toBe(true);
  expect(active.expired).toBe(false);
  expect(active.limits).toEqual({
    session: {
      usedPercent: 100,
      resetsAt: BASE_SEC + 7200,
      windowMinutes: 300,
      observedAt: BASE_SEC,
      source: "account",
    },
    weekly: null,
    tiers: [],
    plan: "Google AI Ultra",
    capturedAt: BASE_SEC,
  });

  // Mutating caller's returned object must not affect subsequent calls.
  active.limits!.session!.usedPercent = 0;
  const fresh = antigravityLimitsFromExhaustion(exhaustion, { nowMs: BASE_MS + 60_000, tierName: "Google AI Ultra" });
  expect(fresh.limits?.session?.usedPercent).toBe(100);

  // At and after resetsAt, the exhaustion expires rather than staying stuck at 100%.
  const atReset = antigravityLimitsFromExhaustion(exhaustion, { nowMs: (BASE_SEC + 7200) * 1000 });
  expect(atReset).toEqual({ limits: null, active: false, expired: true });

  // Reset-less exhaustion expires after one 5-hour window (18,000s) under the shared predicate.
  const withoutReset = parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Individual quota reached", BASE_MS)!;
  expect(antigravityLimitsFromExhaustion(withoutReset, { nowMs: BASE_MS + 17_999 * 1000 }).active).toBe(true);
  expect(antigravityLimitsFromExhaustion(withoutReset, { nowMs: BASE_MS + 18_000 * 1000 })).toEqual({
    limits: null,
    active: false,
    expired: true,
  });
  const unknownWindow = { resetsAt: null, observedAt: BASE_SEC, windowMinutes: 300 };
  expect(isAntigravitySessionWindowActive(unknownWindow, BASE_SEC + 17_999)).toBe(true);
  expect(isAntigravitySessionWindowActive(unknownWindow, BASE_SEC + 18_000)).toBe(false);
  expect(isAntigravitySessionWindowActive(unknownWindow, BASE_SEC + 18_001)).toBe(false);
});
