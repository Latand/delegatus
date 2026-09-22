import { expect, test } from "bun:test";
import type { DeliveryOutcome } from "@/lib/delivery";
import {
  SEAT_TICK_PERMANENT_REFUSALS,
  SEAT_TICK_REFUSAL_CIRCUIT,
  seatTickActiveRefusalRun,
  seatTickNextRefusalRun,
  seatTickPermanentRefusal,
  seatTickRefusalCircuitOpen,
} from "./seatTickRefusal";

const refused = (error: string, over: Partial<Extract<DeliveryOutcome, { ok: false }>> = {}): DeliveryOutcome =>
  ({ ok: false, outcome: "failed", error, status: 503, ...over });

/* The reclaimed-host sentence the structured send writes before the cause. */
const RECLAIMED = "conversation host was reclaimed; automatic resume did not establish a deliverable host";

test("the permanent set is exactly the reasons it names", () => {
  expect(SEAT_TICK_PERMANENT_REFUSALS.map((entry) => entry.reason)).toEqual(["migration-prevents-resume", "conversation-superseded"]);
  expect(SEAT_TICK_REFUSAL_CIRCUIT).toBe(3);
});

test("a migration that prevents resume is permanent, bare and as the cause of a reclaimed host", () => {
  expect(seatTickPermanentRefusal(refused("conversation migration prevents resume succession"))?.reason).toBe("migration-prevents-resume");
  const reclaimed = seatTickPermanentRefusal(refused(`${RECLAIMED}: conversation migration prevents resume succession`));
  expect(reclaimed?.reason).toBe("migration-prevents-resume");
  expect(reclaimed?.detail).toContain("conversation migration prevents resume succession");
});

test("a superseded seat conversation is permanent, in both of the delivery layer's words for it", () => {
  expect(seatTickPermanentRefusal(refused("superseded", { status: 409 }))?.reason).toBe("conversation-superseded");
  expect(seatTickPermanentRefusal(refused("conversation was superseded by a successor"))?.reason).toBe("conversation-superseded");
});

test("a refusal that may clear by waiting is not permanent", () => {
  for (const error of [
    RECLAIMED,
    `${RECLAIMED}: account limit reached`,
    "conversation host ownership is synchronizing; no deliverable process is recorded yet",
    "structured delivery ownership is unavailable",
    "an account switch is pending for this conversation; injected context cannot be held across it",
    "",
  ]) expect(seatTickPermanentRefusal(refused(error))).toBeNull();
});

test("a permanent reason on a refusal that may have actuated is not a release", () => {
  const error = "conversation migration prevents resume succession";
  expect(seatTickPermanentRefusal(refused(error, { operationId: "op-1" }))).toBeNull();
  expect(seatTickPermanentRefusal(refused(error, { actuation: "started" }))).toBeNull();
  expect(seatTickPermanentRefusal(refused(error, { resend: "verify-first" }))).toBeNull();
  expect(seatTickPermanentRefusal({ ok: true, target: null, outcome: "delivered" })).toBeNull();
});

test("the run counts one reason under one basis, and anything that moves the basis ends it", () => {
  const basis = { seatEpoch: 39, lastWakeAt: "2026-09-01T00:00:00.000Z", settingsUpdatedAt: null };
  const migration = seatTickPermanentRefusal(refused("conversation migration prevents resume succession"))!;
  const attempt = (n: number) => ({ clientMessageId: `key-${n}`, preparedAt: "2026-09-22T10:00:00.000Z" });
  let state: { refusals: ReturnType<typeof seatTickNextRefusalRun> | null } = { refusals: null };
  for (let n = 1; n <= 3; n++) {
    state = { refusals: seatTickNextRefusalRun(state, basis, migration, attempt(n), "2026-09-22T10:05:00.000Z") };
    expect(state.refusals!.count).toBe(n);
    expect(seatTickRefusalCircuitOpen(seatTickActiveRefusalRun(state, basis))).toBe(n >= 3);
  }
  expect(seatTickActiveRefusalRun(state, { ...basis, seatEpoch: 40 })).toBeNull();
  expect(seatTickActiveRefusalRun(state, { ...basis, lastWakeAt: "2026-09-22T11:00:00.000Z" })).toBeNull();
  expect(seatTickActiveRefusalRun(state, { ...basis, settingsUpdatedAt: "2026-09-22T11:00:00.000Z" })).toBeNull();

  /* A different permanent reason starts its own run. */
  const superseded = seatTickPermanentRefusal(refused("superseded"))!;
  expect(seatTickNextRefusalRun(state, basis, superseded, attempt(4), "2026-09-22T10:10:00.000Z").count).toBe(1);
});
