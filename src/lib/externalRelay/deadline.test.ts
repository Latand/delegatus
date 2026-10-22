import { expect, test } from "bun:test";
import { relayRequestDeadline, remainingMs } from "./deadline";

const received = Date.parse("2026-10-13T12:00:00Z");
test("request deadline uses the original absolute UTC bound without renewing for claim transit", () => {
  const d = relayRequestDeadline({ claimed_at: "2026-10-13T11:59:55Z", deadline_at: "2026-10-13T12:00:13Z" }, received);
  expect(d).toEqual({ receivedAt: received, at: received + 13000, declineAt: received + 3000, source: "deadline_at", fallback: null });
  expect(Object.isFrozen(d)).toBe(true);
  expect(remainingMs(d, received + 12000)).toBe(1000);
  expect(remainingMs(d, received + 14000)).toBe(0);
});
for (const [name, raw, fallback] of [
  ["absent", {}, "absent"],
  ["malformed", { deadline_at: "tomorrow" }, "unparseable"],
  ["non-string", { deadline_at: 17 }, "unparseable"],
  ["missing seconds", { deadline_at: "2026-10-13T12:01Z" }, "unparseable"],
  ["no offset", { deadline_at: "2026-10-13T12:00:13" }, "unparseable"],
  ["offset instead of Z", { deadline_at: "2026-10-13T12:00:13+00:00" }, "unparseable"],
  ["past at receipt", { claimed_at: "2026-10-13T11:59:00Z", deadline_at: "2026-10-13T11:59:59Z" }, "past"],
  ["equal to receipt", { deadline_at: "2026-10-13T12:00:00Z" }, "past"],
] as const) test(`deadline fallback ${name} has one immutable receipt budget`, () => {
  expect(relayRequestDeadline(raw, received)).toEqual({ receivedAt: received, at: received + 600000, declineAt: received + 590000, source: "receipt", fallback });
});
test("five minutes of owner work leaves five minutes in the receipt window", () => {
  const deadline = relayRequestDeadline({}, received);
  expect(remainingMs(deadline, received + 300_000)).toBe(300_000);
  expect(remainingMs(deadline, received + 600_000)).toBe(0);
});
for (const transit of [0, 45_000, 300_000]) test(`service ten-minute deadline retains its full remainder after ${transit}ms transit`, () => {
  const at = received + 600_000;
  const deadline = relayRequestDeadline({ deadline_at: new Date(at).toISOString() }, received + transit);
  expect(deadline.at).toBe(at);
  expect(deadline.source).toBe("deadline_at");
  expect(remainingMs(deadline, received + transit)).toBe(600_000 - transit);
});
test("deadline extraction does not depend on claimed_at validation", () => {
  expect(relayRequestDeadline({ claimed_at: "bad", deadline_at: "2026-10-13T12:00:13Z" }, received).at).toBe(received + 13000);
});
test("a claim in its last ten seconds has no hold allowance", () => {
  expect(relayRequestDeadline({ deadline_at: "2026-10-13T12:00:04Z" }, received).declineAt).toBe(received);
});
