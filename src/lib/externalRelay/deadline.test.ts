import { expect, test } from "bun:test";
import { relayRequestDeadline, remainingMs } from "./deadline";

test("service deadline uses its own clock difference and is immutable", () => {
  const received = Date.parse("2026-10-13T12:00:00Z");
  const d = relayRequestDeadline({ claimed_at: "2026-10-13T08:00:00Z", deadline_at: "2026-10-13T08:00:13Z" }, received);
  expect(d).toEqual({ receivedAt: received, at: received + 13000, declineAt: received + 3000, source: "deadline_at", fallback: null });
  expect(Object.isFrozen(d)).toBe(true);
  expect(remainingMs(d, received + 12000)).toBe(1000);
  expect(remainingMs(d, received + 14000)).toBe(0);
});
for (const [name, raw, fallback] of [
  ["absent", {}, "absent"],
  ["malformed", { deadline_at: "tomorrow" }, "unparseable"],
  ["non-string", { deadline_at: 17 }, "unparseable"],
  ["no offset", { deadline_at: "2026-10-13T08:00:13" }, "unparseable"],
  ["bad claim", { deadline_at: "2026-10-13T08:00:13Z", claimed_at: "bad" }, "unparseable"],
  ["past", { claimed_at: "2026-10-13T08:00:00Z", deadline_at: "2026-10-13T07:59:59Z" }, "past"],
  ["equal", { claimed_at: "2026-10-13T08:00:00Z", deadline_at: "2026-10-13T08:00:00Z" }, "past"],
  ["far", { claimed_at: "2026-10-13T08:00:00Z", deadline_at: "2026-10-13T08:10:01Z" }, "far"],
] as const) test(`deadline fallback ${name} never refuses a claim`, () => {
  expect(relayRequestDeadline(raw, 1000)).toEqual({ receivedAt: 1000, at: 121000, declineAt: 111000, source: "receipt", fallback });
});
test("a late claim declines immediately and the maximum service window is accepted", () => {
  const claimed_at = "2026-10-13T08:00:00Z";
  expect(relayRequestDeadline({ claimed_at, deadline_at: "2026-10-13T08:00:04Z" }, 1000).declineAt).toBe(1000);
  expect(relayRequestDeadline({ claimed_at, deadline_at: "2026-10-13T08:10:00Z" }, 1000).at).toBe(601000);
});
