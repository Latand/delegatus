/**
 * Issue #1213 — the delivery evidence the operator can reach.
 *
 * The report's screenshot was this surface: an optimistic user bubble reading
 * «Delivering» with a spinner, for a message parked behind a turn that never
 * ended. It said the same word for a delivery that landed in twelve seconds,
 * one that landed in twenty-one minutes, and one that never landed.
 *
 * Send-latency slice 3 kept every distinction this issue won and moved it off
 * the resting row: the message itself reads one stable sentence while it is
 * unconfirmed, and the wait's own words — which turn, which host, how long —
 * are the evidence under its progress affordance, reachable by hover or by
 * opening it. So the assertions below read `transport()`, and `status()` is
 * the one sentence the operator reads without asking.
 *
 * What must NOT appear on a resting admitted row: a control. The row is the
 * composer's local mirror and owns no journal operation. `retryOutbox` refuses
 * anything but a failed entry, and `cancelOutbox` deletes the local row while
 * the server keeps holding the message — so a Retry or an X on an admitted row
 * is a button that lies.
 */
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { installActEnv } from "@/test-helpers/actEnv";
import { type TFunction, translate } from "@/lib/i18n";

const translator = (locale: "en" | "uk"): TFunction => (key, params) => translate(locale, key, params);

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
});

const { OutboxBubblesView } = await import("@/components/conversation/OutboxBubbles");
const { outboxReceiptPatch } = await import("@/components/conversation/outbox");
type ReceiptStatus = Parameters<typeof outboxReceiptPatch>[1];
const { DELIVERY_UNCERTAIN_MS } = await import("@/components/runtime/deliveryWait");
/** One label-unit past the bound. Derived from the bound so raising the bound
    cannot leave a stale minute count asserted next to it. */
const PAST_BOUND_MS = DELIVERY_UNCERTAIN_MS + 60_000;
const PAST_BOUND_MIN = Math.round(PAST_BOUND_MS / 60_000);
type Entry = Parameters<typeof OutboxBubblesView>[0]["entries"][number];
type Session = NonNullable<Parameters<typeof OutboxBubblesView>[0]["session"]>;

/** The host the operator was talking to: alive, and inside a turn. The bubble
    may only name a turn boundary on the host's own evidence. */
const BUSY: Session = { host: "hosted", turn: "running" };

const SUBMITTED_AT = 1_772_000_000_000;

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "key-1213",
    text: "status of the merge queue",
    images: 0,
    at: SUBMITTED_AT,
    state: "delivering",
    ...overrides,
  } as Entry;
}

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(node));
  return host;
}

/** The one sentence on the resting row: three states, never the transport's. */
const status = (host: HTMLElement) => host.querySelector("[data-outbox-status]")?.textContent ?? "";
/** The transport evidence, as the affordance publishes it for hover and as its
    disclosure renders it. */
const transport = (host: HTMLElement) =>
  host.querySelector("[data-outbox-progress]")?.getAttribute("title") ?? "";
/** The same evidence after the operator opens the affordance — the assertion
    that hover and disclosure can never drift apart. */
async function disclosed(host: HTMLElement): Promise<string> {
  const toggle = host.querySelector<HTMLButtonElement>("[data-outbox-progress]");
  if (!toggle) return "";
  await act(async () => toggle.click());
  return host.querySelector("[data-outbox-transport]")?.textContent ?? "";
}
const phase = (host: HTMLElement) => host.querySelector("[data-outbox-entry]")?.getAttribute("data-outbox-wait");
const rowPhase = (host: HTMLElement) => host.querySelector("[data-outbox-entry]")?.getAttribute("data-message-row");

let checked = 0;

async function bubble(
  overrides: Partial<Entry>,
  nowMs: number,
  locale: "en" | "uk" = "en",
  session: Session | null = BUSY,
) {
  document.body.replaceChildren();
  checked = 0;
  return render(
    <OutboxBubblesView
      entries={[entry(overrides)]}
      t={translator(locale)}
      nowMs={nowMs}
      onCancel={() => {}}
      onRetry={() => {}}
      /* Production wires this to a re-read of the runtime under the message's
         own operation; here it only has to be reachable. */
      onCheck={() => { checked += 1; }}
      session={session}
    />,
  );
}

test("#1213 an attempt on the wire keeps the wording it always had, as evidence", async () => {
  const host = await bubble({}, SUBMITTED_AT + 4_000);
  expect(phase(host)).toBe("handing-over");
  expect(rowPhase(host)).toBe("pending");
  expect(transport(host)).toBe(translate("en", "outbox.delivering"));
  /* Hover and disclosure are the same sentence, never two versions of it. */
  expect(await disclosed(host)).toBe(translate("en", "outbox.delivering"));
  /* And the row itself says the one thing that is true of every unconfirmed
     delivery, so it does not change as the transport does. */
  expect(status(host)).toBe(translate("en", "outbox.awaitingConfirmation"));
  expect(host.querySelector(".animate-spin")).not.toBeNull();
});

test("#1213 a message parked at a turn boundary says which wait it is in, and its age", async () => {
  for (const locale of ["en", "uk"] as const) {
    const host = await bubble({ awaitingTurn: true }, SUBMITTED_AT + 4 * 60_000, locale);
    expect(phase(host)).toBe("awaiting-turn");
    expect(transport(host)).toBe(translate(locale, "runtime.receipt.awaitingTurnFor", {
      waited: translate(locale, "runtime.receipt.waitedMin", { n: 4 }),
    }));
    /* The lie the operator reported: nothing is being transmitted. The word is
       not in the evidence, and the row does not claim it either. */
    expect(host.textContent).not.toContain(translate(locale, "outbox.delivering"));
    expect(status(host)).toBe(translate(locale, "outbox.awaitingConfirmation"));
  }
});

test("past the bound the message stays unconfirmed — never 'not sent' — and offers Check status", async () => {
  for (const locale of ["en", "uk"] as const) {
    const host = await bubble({ awaitingTurn: true }, SUBMITTED_AT + PAST_BOUND_MS, locale);
    expect(phase(host)).toBe("uncertain");
    /* The evidence keeps the whole sentence, with the age that earned it. */
    expect(transport(host)).toBe(translate(locale, "runtime.receipt.unconfirmed", {
      waited: translate(locale, "runtime.receipt.waitedMin", { n: PAST_BOUND_MIN }),
    }));
    /* A transport timeout is not proof the message was not sent, so the row
       stays pending confirmation and never becomes a failure. */
    expect(rowPhase(host)).toBe("pending");
    expect(status(host)).toBe(translate(locale, "outbox.awaitingConfirmation"));
    expect(host.querySelector("[data-outbox-failure]")).toBeNull();
    /* And the one thing that can settle it is offered under the disclosure,
       against the original identity — never a second send. */
    await disclosed(host);
    const check = host.querySelector<HTMLButtonElement>("[data-outbox-check]");
    expect(check).not.toBeNull();
    expect(host.querySelector("[data-outbox-retry]")).toBeNull();
    await act(async () => check!.click());
    expect(checked).toBe(1);
  }
});

/**
 * Replay the composer's own receipt→bubble projection over a receipt sequence
 * and render what the operator is looking at after each one.
 *
 * The projection is the real one ({@link outboxReceiptPatch}); only the store
 * and the effect that calls it are stood in for here, so the wording asserted
 * below is the wording the composer produces.
 */
async function drive(statuses: readonly ReceiptStatus[], nowMs: number) {
  let projected: Partial<Entry> = {};
  const seen: { transport: string; status: string; phase: string | null | undefined }[] = [];
  for (const receiptStatus of statuses) {
    const patch = outboxReceiptPatch(entry(projected), receiptStatus);
    if (patch) projected = { ...projected, ...patch };
    const host = await bubble(projected, nowMs);
    seen.push({ transport: transport(host), status: status(host), phase: phase(host) });
  }
  return seen;
}

test("#1213 a send parked at a turn boundary stops reading as an attempt on the wire", async () => {
  /* The defect the operator photographed, at its root: `pending`, `queued`,
     `delivering` and `applying` all project to ONE `delivering` bubble state, so
     a reconciliation guard that compares state alone never sees the delivery
     queue park this send behind a turn — and the bubble keeps the spinner and
     the bare word «Delivering» for as long as the turn runs. */
  const nowMs = SUBMITTED_AT + 4 * 60_000;
  const [onWire, parked] = await drive(["delivering", "queued"], nowMs);
  expect(onWire!.phase).toBe("handing-over");
  expect(onWire!.transport).toBe(translate("en", "outbox.delivering"));
  expect(parked!.phase).toBe("awaiting-turn");
  expect(parked!.transport).toBe(translate("en", "runtime.receipt.awaitingTurnFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 4 }),
  }));
});

test("#1213 a send taken off the park and put on the wire stops claiming a turn boundary", async () => {
  /* The same guard in the other direction: the queue reaches the turn boundary
     and moves the send `queued`→`delivering`, and the bubble would go on saying
     the agent is mid-turn while the message is genuinely being handed over. */
  const nowMs = SUBMITTED_AT + 4 * 60_000;
  const [, handingOver] = await drive(["queued", "delivering"], nowMs);
  expect(handingOver!.phase).toBe("handing-over");
  expect(handingOver!.transport).toBe(translate("en", "outbox.delivering"));
});

test("#1213 an admission the request path never confirmed leaves the bubble alone", async () => {
  /* `pending`, `applying` and `uncertain` prove nothing about a hand-over, so
     none of them may write a turn boundary onto the bubble — that flag is a
     claim about where the message IS. */
  for (const status of ["pending", "applying"] as const) {
    expect(outboxReceiptPatch({ state: "delivering" }, status)).toBeNull();
    expect(outboxReceiptPatch({ state: "delivering", awaitingTurn: true }, status)).toBeNull();
  }
});

test("#1213 no admitted bubble offers a control that cannot act on the message", async () => {
  /* Both of these would be lies: `retryOutbox` ignores a `delivering` entry,
     and `cancelOutbox` drops the bubble while the server still holds the send
     — the operator would believe a message was withdrawn that later arrives. */
  for (const nowMs of [SUBMITTED_AT + 4_000, SUBMITTED_AT + PAST_BOUND_MS]) {
    const host = await bubble({ awaitingTurn: true }, nowMs);
    expect(host.querySelector("[data-outbox-retry]")).toBeNull();
    expect(host.querySelector("[data-outbox-cancel]")).toBeNull();
  }
});

test("a queued message can still be taken back, and a failure gets exactly one action", async () => {
  const queued = await bubble({ state: "queued" }, SUBMITTED_AT + DELIVERY_UNCERTAIN_MS);
  /* Never handed to the server at all — taking it back is honest. It is one
     tap behind the affordance so the resting row stays the message itself. */
  expect(queued.querySelector("[data-outbox-cancel='key-1213']")).toBeNull();
  await disclosed(queued);
  expect(queued.querySelector("[data-outbox-cancel='key-1213']")).not.toBeNull();

  /* A proven failure is the one state that adds anything to the row: a reason
     in the interface language and ONE action, never a retry beside a cancel
     beside a status word. */
  const failed = await bubble({ state: "failed", error: "pane is gone" }, SUBMITTED_AT + 60_000);
  expect(rowPhase(failed)).toBe("failed");
  expect(status(failed)).toBe(translate("en", "outbox.failure.generic"));
  expect(failed.querySelectorAll("[data-outbox-retry], [data-outbox-cancel], [data-outbox-check], [data-outbox-clear]")).toHaveLength(1);
  expect(failed.querySelector("[data-outbox-retry='key-1213']")).not.toBeNull();
  /* The raw sentence is not thrown away: it is one tap behind the reason. */
  const reason = failed.querySelector<HTMLButtonElement>("[data-outbox-reason]")!;
  expect(reason.getAttribute("title")).toBe("pane is gone");
  await act(async () => reason.click());
  expect(failed.querySelector("[data-outbox-raw]")?.textContent).toBe("pane is gone");
});

test("#1213 a delivery stranded by a host that went away is not called a turn boundary", async () => {
  /* The rollback population: a deployment terminates every structured host and
     each parked message stays exactly where it was. The bubble reads the same
     host axis the composer does, so it says the window is gone instead of
     naming a turn on an agent that is not there. */
  const host = await bubble(
    { awaitingTurn: true },
    SUBMITTED_AT + 3 * 60_000,
    "en",
    { host: "dead", turn: "running" },
  );
  expect(phase(host)).toBe("awaiting-host");
  expect(transport(host)).toBe(translate("en", "runtime.receipt.awaitingHostFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 3 }),
  }));
  expect(transport(host)).not.toContain(translate("en", "runtime.receipt.awaitingTurnFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 3 }),
  }));
});

test("#1213 with no host behind the feed the bubble says it is waiting without naming a turn", async () => {
  /* A legacy surface with nothing structured behind it knows only that the
     message was admitted. Claiming a turn there is an invention, and the same
     invention would become the explanation on the terminal row. */
  const host = await bubble({ awaitingTurn: true }, SUBMITTED_AT + 3 * 60_000, "en", null);
  expect(phase(host)).toBe("awaiting-handover");
  expect(transport(host)).toBe(translate("en", "runtime.receipt.awaitingHandoverFor", {
    waited: translate("en", "runtime.receipt.waitedMin", { n: 3 }),
  }));
});

test("#1224 a bubble for a document-only submission names its attachment instead of rendering blank", async () => {
  /* An attachment-only message has no text of its own, and the count came from
     the images alone — so the operator's document appeared as an empty bubble
     with a status chip under it. */
  const host = await bubble({ text: "", images: 0, files: 1 }, SUBMITTED_AT + 1_000);
  expect(host.textContent).toContain(translate("en", "composer.attachmentsCount", { count: 1 }));

  /* An images-only submission keeps the wording it always had. */
  const images = await bubble({ text: "", images: 2 }, SUBMITTED_AT + 1_000);
  expect(images.textContent).toContain(translate("en", "composer.imagesCount", { count: 2 }));
});

/**
 * Sending into a host that is gone.
 *
 * The operator presses Send once and the Viewer raises the agent on the way to
 * delivering. The bubble is the message's one delivery state, so it has to walk
 * that sequence out loud — and the two host phases are not the same fact:
 * «nothing is hosting this» and «it is starting again» call for different
 * decisions, and only the second is progress. Both are read from the
 * conversation's own host axis, never inferred from the fact that a send was
 * made.
 */
const GONE: Session = { host: "unhosted", turn: "unknown" };
const RESUMING: Session = { host: "recovering", turn: "unknown" };

test("a send into a gone host walks queued → resuming host → delivering → delivered", async () => {
  for (const locale of ["en", "uk"] as const) {
    /* Queued: the operator's press landed in the local queue, nothing has been
       handed over yet. */
    let host = await bubble({ state: "queued" }, SUBMITTED_AT + 2_000, locale, GONE);
    expect(transport(host)).toBe(translate(locale, "outbox.queued"));
    const resting = status(host);

    /* Admitted while the conversation still has no host. A server-held
       admission with no receipt yet used to flatten this into a bare "held";
       the host axis knows more than that and the bubble now says it. */
    host = await bubble({ state: "delivering", acceptedHeld: true }, SUBMITTED_AT + 60_000, locale, GONE);
    expect(phase(host)).toBe("awaiting-host");
    expect(transport(host)).toBe(translate(locale, "runtime.receipt.awaitingHostFor", {
      waited: translate(locale, "runtime.receipt.waitedMin", { n: 1 }),
    }));
    expect(status(host)).toBe(resting);

    /* The send's own recovery is under way: progress, and it reads and spins
       like progress rather than sitting in the red "nothing is hosting" state. */
    host = await bubble({ state: "delivering", acceptedHeld: true }, SUBMITTED_AT + 60_000, locale, RESUMING);
    expect(phase(host)).toBe("resuming-host");
    expect(transport(host)).toBe(translate(locale, "runtime.receipt.resumingHostFor", {
      waited: translate(locale, "runtime.receipt.waitedMin", { n: 1 }),
    }));
    expect(status(host)).toBe(resting);
    expect(host.querySelector(".animate-spin")).not.toBeNull();

    /* The host came back and the message is being put in front of the agent. */
    host = await bubble({ state: "delivering" }, SUBMITTED_AT + 4_000, locale, { host: "hosted", turn: "idle" });
    expect(transport(host)).toBe(translate(locale, "outbox.delivering"));
    expect(status(host)).toBe(resting);

    /* Arrival is the only visible change in the whole walk: the affordance
       goes, and the row is already the message's final form. */
    host = await bubble({ state: "delivered" }, SUBMITTED_AT + 8_000, locale, { host: "hosted", turn: "idle" });
    expect(rowPhase(host)).toBe("confirmed");
    expect(host.querySelector("[data-outbox-progress]")).toBeNull();
    expect(host.querySelector("[data-outbox-failure]")).toBeNull();
  }
});

test("a resume that failed reads in the interface language, keeps the raw reason and offers one retry", async () => {
  /* The server retries a contended resume on its own doubling backoff and only
     then settles the operation failed, carrying the reason it failed for. That
     sentence is English prose written by the runtime, and the operator
     photographed it inside a Ukrainian interface. The row reads a sentence in
     the interface language; the raw one stays one tap away, because it names
     the attempt count a report needs. One same-key retry, as before. */
  const reason = "structured host recovery failed after 12 contended attempts: account is busy";
  let retried = 0;
  document.body.replaceChildren();
  const host = await render(
    <OutboxBubblesView
      entries={[entry({ state: "failed", error: reason })]}
      t={translator("en")}
      nowMs={SUBMITTED_AT + 120_000}
      onCancel={() => {}}
      onRetry={() => { retried += 1; }}
      session={GONE}
    />,
  );
  expect(status(host)).toBe(translate("en", "outbox.failure.hostBusy"));
  expect(status(host)).not.toBe(translate("en", "outbox.failed"));
  expect(host.querySelector("[data-outbox-reason]")?.getAttribute("title")).toBe(reason);
  const retry = host.querySelector("[data-outbox-retry='key-1213']") as HTMLButtonElement;
  expect(retry).toBeTruthy();
  await act(async () => retry.click());
  expect(retried).toBe(1);
});

test("the same failure reads in Ukrainian, with the runtime's English sentence behind it", async () => {
  /* The exact defect the operator reported: raw English internal text inside
     the Ukrainian interface. */
  const reason = "structured host recovery failed after 12 contended attempts: account is busy";
  document.body.replaceChildren();
  const host = await render(
    <OutboxBubblesView
      entries={[entry({ state: "failed", error: reason })]}
      t={translator("uk")}
      nowMs={SUBMITTED_AT + 120_000}
      onCancel={() => {}}
      onRetry={() => {}}
      session={GONE}
    />,
  );
  expect(status(host)).toBe(translate("uk", "outbox.failure.hostBusy"));
  const reasonButton = host.querySelector<HTMLButtonElement>("[data-outbox-reason]")!;
  expect(reasonButton.textContent).not.toContain("account is busy");
  await act(async () => reasonButton.click());
  expect(host.querySelector("[data-outbox-raw]")?.textContent).toBe(reason);
});
