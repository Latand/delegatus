import { expect, test } from "bun:test";
import { proactiveAccountReserveError } from "./proactiveReserve";
import { proactiveObservation } from "./proactiveReserve.fixture";

const now = Date.parse("2026-10-22T00:00:00.000Z");

test("fresh complete usage below the reserve admits the allowed account", () => {
  const sample = proactiveObservation();
  expect(proactiveAccountReserveError(sample.accountId, [sample.accountId], sample, now + 300_000)).toBeNull();
});
test.each(["pool", "missing", "auth", "auth-age", "age", "future", "source", "weekly", "session", "80", "reached", "invalid"])("reserve refuses %s independently", kind => {
  const sample = proactiveObservation();
  let pool = [sample.accountId];
  if (kind === "pool") pool = [];
  if (kind === "auth") sample.authenticated = false;
  if (kind === "auth-age") sample.authCheckedAt = new Date(now - 300_001).toISOString();
  if (kind === "age") sample.observedAt = new Date(now - 300_001).toISOString();
  if (kind === "future") sample.observedAt = new Date(now + 1).toISOString();
  if (kind === "source") sample.provenance.source = "transcript";
  if (kind === "weekly") sample.limits!.weekly = null;
  if (kind === "session") sample.limits!.session = null;
  if (kind === "80") sample.limits!.weekly!.usedPercent = 80;
  if (kind === "reached") sample.limitReached = true;
  if (kind === "invalid") sample.limits!.weekly!.usedPercent = NaN;
  expect(proactiveAccountReserveError(sample.accountId, pool, kind === "missing" ? undefined : sample, now)).toBeString();
});
