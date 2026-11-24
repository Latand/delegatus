import { expect, test } from "bun:test";

import {
  ANTIGRAVITY_QUOTA_WINDOW_MINUTES,
  antigravityLimitsFromExhaustion,
  parseAntigravityQuotaError,
  redactAntigravityQuotaMessage,
} from "./antigravityQuota";

const BASE_MS = Date.parse("2026-11-24T01:00:00.000Z");
const BASE_SEC = Math.floor(BASE_MS / 1000);

test("parses RESOURCE_EXHAUSTED and Individual quota reached messages across all reset duration formats", () => {
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

  const hoursMins = parseAntigravityQuotaError(
    "Individual quota reached for gemini-3.8-flash. Resets in 2h 15m",
    BASE_MS,
  );
  expect(hoursMins?.resetsAt).toBe(BASE_SEC + 2 * 3600 + 15 * 60);

  const minsOnly = parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Resets in 45m", BASE_MS);
  expect(minsOnly?.resetsAt).toBe(BASE_SEC + 45 * 60);

  const secsOnly = parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Resets in 90s", BASE_MS);
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

test("ignores non-quota errors and redacts emails, tokens, and home paths from quota messages", () => {
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

test("maps active exhaustion onto a 5h session window, expires cleanly at resetsAt, and isolates caller mutations", () => {
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

  // Reset-less exhaustion expires after one 5-hour window.
  const withoutReset = parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Individual quota reached", BASE_MS)!;
  expect(antigravityLimitsFromExhaustion(withoutReset, { nowMs: BASE_MS + 60_000 }).active).toBe(true);
  expect(antigravityLimitsFromExhaustion(withoutReset, { nowMs: BASE_MS + 300 * 60_000 })).toEqual({
    limits: null,
    active: false,
    expired: true,
  });
});
