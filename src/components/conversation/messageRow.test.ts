/**
 * The three states a sent message is ever in (send-latency slice 3).
 *
 * The vocabulary the operator used to read — accepted, queued, delivering,
 * held, recovering, delivered — is transport bookkeeping. This pins the
 * collapse: which of those become "waiting for confirmation", which prove
 * arrival, which are a failure that needs a decision, and what each failure
 * reads as in both interface languages.
 */
import { expect, test } from "bun:test";

import { type TFunction, translate } from "@/lib/i18n";

import { messageRowModel } from "./messageRow";
import type { OutboxEntry } from "./outbox";

const t = (locale: "en" | "uk"): TFunction => (key, params) => translate(locale, key, params);
const AT = 1_772_400_000_000;

const entry = (overrides: Partial<OutboxEntry>): OutboxEntry =>
  ({ id: "key", text: "status of the merge queue", images: 0, at: AT, state: "queued", ...overrides }) as OutboxEntry;

test("every transport state on the way in is one pending row", () => {
  const pending: Partial<OutboxEntry>[] = [
    { state: "queued" },
    { state: "delivering" },
    { state: "delivering", awaitingTurn: true },
    { state: "delivering", acceptedHeld: true },
    { state: "delivering", heldForSwitch: true },
    { state: "delivering", deliveryUncertain: true },
    /* The composer's own local row for an admission it never saw confirmed is
       written `failed`; it is still not a message that was not sent. */
    { state: "failed", deliveryUncertain: true },
  ];
  for (const overrides of pending) {
    const row = messageRowModel(t("en"), entry(overrides), { nowMs: AT + 30_000 });
    expect(row.phase).toBe("pending");
    expect(row.status).toBe(translate("en", "outbox.awaitingConfirmation"));
    expect(row.failure).toBeNull();
  }
});

test("arrival is the only confirmation, and a failure is the only decision", () => {
  expect(messageRowModel(t("en"), entry({ state: "delivered" }), { nowMs: AT }).phase).toBe("confirmed");
  const failed = messageRowModel(t("en"), entry({ state: "failed", error: "pane is gone" }), { nowMs: AT });
  expect(failed.phase).toBe("failed");
  expect(failed.failure).toEqual({
    reason: translate("en", "outbox.failure.generic"),
    detail: "pane is gone",
    action: "retry",
  });
});

test("the known failures read in the interface language, with the raw sentence kept", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["structured host recovery failed after 12 contended attempts: account is busy", "outbox.failure.hostBusy"],
    ["structured recovery runtime host restart failed", "outbox.failure.hostRecovery"],
    ["account is busy", "outbox.failure.accountBusy"],
    ["Your access token could not be refreshed; please log out and sign in again", "outbox.failure.signInExpired"],
    ["this conversation is not resumable", "outbox.failure.notResumable"],
    ["structured spawn runtime host is unavailable", "outbox.failure.hostGone"],
  ];
  for (const [raw, key] of cases) {
    for (const locale of ["en", "uk"] as const) {
      const row = messageRowModel(t(locale), entry({ state: "failed", error: raw }), { nowMs: AT });
      expect(row.failure?.reason).toBe(translate(locale, key as Parameters<typeof translate>[1]));
      /* The runtime's own sentence is never thrown away — it names attempt
         counts and provider wording a report needs — it is one tap behind. */
      expect(row.failure?.detail).toBe(raw);
    }
  }
  /* And no raw English survives into the Ukrainian reading. */
  const uk = messageRowModel(t("uk"), entry({ state: "failed", error: "structured host recovery failed after 12 contended attempts: account is busy" }), { nowMs: AT });
  expect(uk.failure?.reason).not.toContain("account is busy");
});

test("the one action follows what can actually be done to the message", () => {
  const action = (overrides: Partial<OutboxEntry>) =>
    messageRowModel(t("en"), entry({ state: "failed", error: "nope", ...overrides }), { nowMs: AT }).failure?.action;
  expect(action({})).toBe("retry");
  /* Bytes that no longer exist cannot be replayed from here. */
  expect(action({ needsReattach: true })).toBe("return");
  /* The bytes are the server's now, so the replay is the server's too: the
     journal starts the admitted operation's next attempt from its own recorded
     request. Same message, same key, nothing composed here. */
  expect(action({ originalOperationOnly: true, operationId: "operation-1" })).toBe("retry-operation");
  /* Unless the operator already ended it — that decision is not replayed. */
  expect(action({ originalOperationOnly: true, operationId: "operation-1",
    deliveryReceipt: { reason: "delivery-discarded", operationId: "operation-1" } as OutboxEntry["deliveryReceipt"] })).toBe("check");
  /* A discard was the operator's own decision; replaying it would undo it. */
  expect(action({ deliveryReceipt: { reason: "delivery-discarded", operationId: "operation-2" } as OutboxEntry["deliveryReceipt"] })).toBe("check");
});

test("an unconfirmed delivery is asked about under its own key, never re-sent", () => {
  /* An operation exists: ask the server again under it. */
  const addressable = messageRowModel(t("en"), entry({ state: "delivering", deliveryUncertain: true, operationId: "operation-1" }), { nowMs: AT });
  expect(addressable.recovery).toBe("check");
  /* And with no operation id it is the SAME offer, which is the whole point
     (round-3 P1). The row's own id is the idempotency key the admission was
     made under, so there is always something to ask about. Offering the words
     back to the composer here is what let one message be admitted twice: the
     row went, the composer minted a second key, and the server held both. */
  const stranded = messageRowModel(t("en"), entry({ state: "delivering", deliveryUncertain: true }), { nowMs: AT });
  expect(stranded.recovery).toBe("check");
  expect(stranded.phase).toBe("pending");
  expect(stranded.cancellable).toBe(false);
  /* A delivery still in flight is not offered a recovery at all. */
  expect(messageRowModel(t("en"), entry({ state: "delivering" }), { nowMs: AT }).recovery).toBeNull();
});

test("the transport's own words survive as the row's evidence", () => {
  /* Demoted, never deleted: this is what the disclosure shows. */
  const parked = messageRowModel(t("en"), entry({ state: "delivering", awaitingTurn: true }), {
    nowMs: AT + 4 * 60_000,
    session: { host: "hosted", turn: "running" },
  });
  expect(parked.transport).toBe(translate("en", "runtime.receipt.awaitingTurnFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 4 }),
  }));
  expect(parked.wait).toBe("awaiting-turn");
  const switched = messageRowModel(t("en"), entry({ state: "delivering" }), {
    nowMs: AT + 1_000,
    switchHold: { label: "Account B" },
  });
  expect(switched.transport).toBe(translate("en", "outbox.heldForSwitch", { label: "Account B" }));
});

test("an unknown outcome authorizes nothing, whatever identity it carries", () => {
  /* The defect this pins (round-4 P2): an uncertain receipt that happened to
     carry an operation id opened the journal's own retry under the row's
     disclosure, and clicking it re-armed another attempt of a message that may
     already be in the engine. The lookup is the whole offer. */
  const receipt = (extra: Record<string, unknown> = {}) => ({
    operationId: "operation-unknown",
    idempotencyKey: "key",
    conversationId: "conversation_x",
    kind: "send",
    status: "uncertain",
    resend: "verify-first",
    reason: "recipient evidence unavailable",
    ...extra,
  }) as OutboxEntry["deliveryReceipt"];
  const unknowns: Partial<OutboxEntry>[] = [
    /* With an operation id on the entry itself. */
    { state: "delivering", deliveryUncertain: true, operationId: "operation-unknown" },
    /* With one only on the receipt the stream projected onto it. */
    { state: "delivering", deliveryUncertain: true, deliveryReceipt: receipt() },
    /* With both, and the local row written `failed` by a request that died. */
    { state: "failed", deliveryUncertain: true, operationId: "operation-unknown", deliveryReceipt: receipt() },
    /* And with neither — the admission whose response never named one. */
    { state: "delivering", deliveryUncertain: true },
  ];
  for (const overrides of unknowns) {
    for (const locale of ["en", "uk"] as const) {
      const row = messageRowModel(t(locale), entry(overrides), { nowMs: AT + 90_000 });
      expect(row.phase).toBe("pending");
      expect(row.recovery).toBe("check");
      expect(row.discardable).toBe(false);
      expect(row.cancellable).toBe(false);
      expect(row.failure).toBeNull();
    }
  }
});

test("only a proven failure may replay the admitted operation", () => {
  /* The other side of the same rule: once the outcome IS established, the row
     offers the journal's own next attempt as its ONE primary action — and the
     server's `safe` resend is what proved the original never executed. */
  const safe = messageRowModel(t("en"), entry({
    state: "failed",
    originalOperationOnly: true,
    operationId: "operation-proven",
    error: "structured host recovery failed after 12 contended attempts: account is busy",
    deliveryReceipt: {
      operationId: "operation-proven", idempotencyKey: "key", conversationId: "conversation_x",
      kind: "send", status: "failed", resend: "safe",
    } as OutboxEntry["deliveryReceipt"],
  }), { nowMs: AT + 90_000 });
  expect(safe.phase).toBe("failed");
  expect(safe.failure?.action).toBe("retry-operation");
  /* Never twice: the disclosure does not repeat the row's own action, and a
     terminal safe failure has nothing left to end. */
  expect(safe.discardable).toBe(false);
  /* An unresolved admitted operation behind a proven failure keeps the end-it
     control, which is a decision about a delivery whose failure IS known. */
  const unresolved = messageRowModel(t("en"), entry({
    state: "failed",
    operationId: "operation-open",
    error: "account is busy",
    deliveryReceipt: {
      operationId: "operation-open", idempotencyKey: "key", conversationId: "conversation_x",
      kind: "send", status: "failed",
    } as OutboxEntry["deliveryReceipt"],
  }), { nowMs: AT + 90_000 });
  expect(unresolved.discardable).toBe(true);
});
