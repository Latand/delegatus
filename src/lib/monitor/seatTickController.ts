import crypto from "node:crypto";
import { SeatTickAccounting } from "./seatTickAccounting";

import { statePath } from "@/lib/configDir";
import { deliverConversationMessage, type DeliveryOutcome } from "@/lib/delivery";
import { canonicalOrchestratorProject, type StillbornSeatRollback } from "@/lib/orchestrator/seats";
import { RUNTIME_IDEMPOTENCY_KEY_LIMIT, runtimeIdempotencyKeyAdmissible } from "@/lib/runtime/contracts";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { mutateTasksFile } from "@/lib/tasks/store";

import {
  MONITOR_REF_PREFIX,
  monitorClientRequestId,
  monitorRefIn,
  orchestratorAlertCardText,
  seatTickRetryGuardCardText,
  seatTickSettingsCardText,
  seatTickSourceGapCardText,
  seatTickSourceGapRef,
} from "./cards";
import { openIssuesForProposal, type ProposalIssue } from "./githubEvidence";
import { appendSeatTickRecord } from "./journalStore";
import { redactBounded, redactMonitorText } from "./redact";
import { seatTickProposalMessage, seatTickWakeMessage } from "./report";
import { SEAT_TICK_WAKE_INTERVAL_MS, seatTickDecision, seatTickPolicy, seatTickWakeCommit, seatTickWakeCommitPlan } from "./seatTick";
import { seatTickFenceBoundMs, seatTickFenceLapsesAt, seatTickFenceRetirableOnAge, seatTickFenceSentence, seatTickReportedFence, seatTickWakeFence } from "./seatTickFence";
import { effectiveSeatTickSettings, seatTickSettingsAfterLapse, writeSeatTickSettings } from "./seatTickSettings";
import { readSeatTickState, seatTickStateForEpoch, writeSeatTickState } from "./seatTickState";
import {
  defaultSeatTickSources,
  gatherSeatTickInput,
  repoDirForProject,
  seatTickProjects,
  type SeatTickSources,
  type SeatTickWakeEvidence,
  type SeatTickWakeState,
} from "./seatTickSources";
import { SEAT_TICK_RETIRED_WAKE_LIMIT } from "./types";
import type {
  SeatTickCard,
  SeatTickOutstandingWake,
  SeatTickPolicy,
  SeatTickProjectState,
  SeatTickRetiredWake,
  SeatTickRetirementReason,
  SeatTickRunRecord,
  SeatTickVerdict,
  SeatTickVerdictKind,
} from "./types";

/**
 * The seat tick controller (issue #1245).
 *
 * One in-process clock, started by the release that owns traffic beside the
 * flow pipeline controller, the Telegram scheduler and the host retirement
 * sweep. There is no scheduler service, no cron entry, no timer unit, no
 * external process and no cross-process lock. "Exactly one active ticker per
 * seat" rests on two refusals instead, because one process is not one process
 * for ever — a deploy promotes a successor beside the incumbent:
 *
 * - A second start inside THIS process is refused out loud rather than
 *   silently ignored.
 * - Every sweep re-asks whether this release still owns traffic, and a release
 *   that has been replaced refuses the sweep, says so in the journal and stops
 *   its own clock. Authority is durable and re-readable, so it answers across
 *   processes what a process-local flag cannot answer at all.
 *
 * What the thing this replaces got wrong, and what this does instead:
 *
 * - It lived in a session, so every rotation dropped it and the successor could
 *   not tell. Here the clock is the Viewer's and the state is on disk, so a
 *   rotation is a new epoch on a row that already exists.
 * - It could act under a seat that had been revoked minutes earlier. Here the
 *   seat epoch is re-read immediately before the send, and a seat that moved in
 *   between is refused — the wake is journaled as refused, and nothing about it
 *   is recorded as a wake the successor received. A send the layer accepted but
 *   kept (held behind a migration, queued with a runtime host) is remembered as
 *   outstanding, because a retained payload outlives the check that made it,
 *   and every later check asks the layer HOLDING it what became of it: still
 *   waiting, delivered after all, or settled unsent. That one question answers
 *   both halves of the tick's accounting — when a stamp may move, and what a
 *   revocation has to reach — so the two cannot drift apart.
 * - It queued its fires and then double-fired into a finished turn. Here a seat
 *   whose turn is genuinely progressing is skipped and the tick is dropped;
 *   nothing is ever held.
 * - Its empty log was equally consistent with perfect operation and with total
 *   failure. Here every check leaves a line, including a check that threw.
 */

export interface SeatTickControllerDependencies {
  sources?: SeatTickSources;
  policy?: SeatTickPolicy | null;
  readState?: typeof readSeatTickState;
  writeState?: typeof writeSeatTickState;
  /** Persists a tick setting that reached its expiry (#1275). The reading is
      already correct without it — the expiry is applied wherever the record is
      read — so this only makes the record on disk say what the tick is
      already doing. */
  writeSettings?: typeof writeSeatTickSettings;
  appendRecord?: typeof appendSeatTickRecord;
  deliver?: typeof deliverConversationMessage;
  /** Whether the board now carries the card. See {@link ensureSeatTickCard}. */
  ensureCard?: (project: string, card: SeatTickCard, at: string) => boolean;
  proposalIssues?: (project: string, sources: SeatTickSources) => Promise<ProposalIssue[]>;
  /** Whether this release still owns viewer traffic, re-asked per sweep. */
  ownsTraffic?: () => boolean | Promise<boolean>;
  /** Reconcile this project's ACTIVE seat against the launch it was activated
      on, before the check reads a seat (#1757). See
      {@link reconcileProvisionalSeat}. */
  reconcileSeat?: (project: string) => Promise<StillbornSeatRollback | null> | StillbornSeatRollback | null;
}

/** The family of refs for the card that says a prepared wake has been
    unresolved for longer than the wake interval, or that its receipt ended
    unverified (#1465). */
export const SEAT_TICK_WAKE_UNRESOLVED_REF = "seat-tick-wake-unresolved";

/**
 * The ref of ONE attempt's unresolved card (#1594).
 *
 * This was a single project-wide ref while a project could only ever have one
 * unresolved attempt. Retirement ends that: a project can now carry retired
 * attempts beside an outstanding one, all unresolved at once, and a board card
 * is re-found by its ref alone — `instance` distinguishes only the create
 * receipt and never appears in the body. So one ref meant the first attempt to
 * be carded took the project's only slot and every later one wrote nothing,
 * leaving the board describing the wrong attempt: a retired card saying the
 * project's wakes are not held back, standing in front of an outstanding
 * attempt that is holding all of them.
 *
 * The attempt's own key is therefore the ref, hashed because
 * {@link monitorRefIn} reads back `[A-Za-z0-9_-]{4,64}` and a client message id
 * is neither colon-free nor bounded. The key itself goes in the body, where an
 * operator can read it. Cards per project stay bounded by
 * {@link SEAT_TICK_RETIRED_WAKE_LIMIT} plus the one outstanding attempt, and a
 * card re-raised for the SAME attempt still finds its own card and rewrites
 * nothing.
 *
 * One expected effect at the release that carries this: a card standing under
 * the old flat ref is no longer re-found — neither by the ref nor by the create
 * receipt, which is derived from it — so an attempt already carded is carded
 * once more under its own ref, and the old card stays open until an operator
 * closes it. One duplicate per attempt already unresolved at the deploy, and
 * none afterwards. Re-finding the old ref as well would mean carrying a lookup
 * for a shape that exists only in the board's past, which is a worse trade than
 * one stale card.
 */
export const seatTickWakeUnresolvedRef = (clientMessageId: string): string =>
  `${SEAT_TICK_WAKE_UNRESOLVED_REF}-${crypto.createHash("sha256").update(clientMessageId).digest("hex").slice(0, 16)}`;
const CARD_TEXT_LIMIT = 5_000;

/**
 * The card for the children source when it cannot be fully accounted for
 * (#1465). The pull-request card's shape, with the consequence this source has:
 * what cannot be named while it stands is a finished worker whose outcome is
 * owed, or a stalled one. The detail already names the condition and what it
 * means, so an operator reading the board knows which hand it calls for.
 */
function seatTickChildrenGapCardText(project: string, detail: string, ref: string, at: string): string {
  return redactBounded(
    [
      "Seat tick cannot fully account for the seat's spawned children",
      "",
      `${detail}.`,
      "Wakes continue on every reason that does not depend on it, and each one names the missing evidence;"
        + " a finished worker whose outcome is owed, or a stalled one, is what cannot be named while this stands.",
      "The tick keeps asking on every check and reports nothing further until every child is accounted for"
        + " — this card is raised once per outage.",
      `Project ${project}. Observed ${at.slice(0, 16).replace("T", " ")} UTC.`,
      "",
      `${MONITOR_REF_PREFIX} ${ref}`,
    ].join("\n"),
    CARD_TEXT_LIMIT,
  );
}

/**
 * The card for a prepared wake nobody can account for (#1465).
 *
 * The issue this closes is a wake the layer failed to deliver going silent for
 * ever. The attempt keeps its identity — see {@link reconcileOutstandingWake} —
 * and this is where the wait is made visible: the operator sees which attempt,
 * since when, what its holder last said, and that the tick is deliberately
 * dispatching nothing else for the project until it settles.
 */
function seatTickWakeUnresolvedCardText(project: string, detail: string, ref: string, at: string): string {
  return redactBounded(
    [
      "Seat tick wake unresolved under its original key",
      "",
      `${detail}.`,
      "Nothing the wake carried is acknowledged: every outcome and lane event it named stays owed until a wake that lands names it.",
      `Project ${project}. Observed ${at.slice(0, 16).replace("T", " ")} UTC.`,
      "",
      `${MONITOR_REF_PREFIX} ${ref}`,
    ].join("\n"),
    CARD_TEXT_LIMIT,
  );
}

function cardText(project: string, card: SeatTickCard, at: string): string {
  if (card.kind === "no-seat") return orchestratorAlertCardText(card.detail, at);
  if (card.kind === "source-unreadable") {
    return card.ref === seatTickSourceGapRef("children")
      ? seatTickChildrenGapCardText(project, card.detail, card.ref, at)
      : seatTickSourceGapCardText(project, card.detail, card.ref, at);
  }
  if (card.kind === "wake-unresolved") return seatTickWakeUnresolvedCardText(project, card.detail, card.ref, at);
  if (card.kind === "tick-settings") {
    return seatTickSettingsCardText({
      project,
      detail: card.detail,
      reason: card.settings?.reason ?? null,
      until: card.settings?.until ?? null,
      setBy: card.settings?.setBy ?? null,
      updatedAt: card.settings?.updatedAt ?? null,
    });
  }
  return seatTickRetryGuardCardText(project, card.detail, card.ref, at);
}

/**
 * One board card per condition, found by its `monitor-ref:` line rather than by
 * a receipt — so the idempotency survives a restart, and an operator who edits
 * the text above the marker keeps it.
 *
 * Two kinds of card meet here. A condition that HAPPENED (no seat, a wake
 * reason the guard stopped) is written once and left for the operator to
 * close. A STANDING state — a project's tick settings (#1275) — is instead
 * kept in step with the state it describes: its text is rewritten when the
 * setting changes, and the card is closed by the first check that reads the
 * project back on its defaults, so the board never claims a quiet tick that is
 * ticking again. The card body is stamped with when the SETTING was recorded,
 * so a settled state rewrites nothing check after check.
 *
 * It answers whether the board now carries what the card asked for, because one
 * caller has to know: the source-gap row records that the operator was told
 * (#1298), and that may only be written when the telling happened. A create the
 * board refused is a false, and so is a close that did not take; an open card
 * already standing for this condition is a true, as is a replayed create — with
 * a per-outage receipt (see {@link SeatTickCard.instance}) a replay means this
 * very outage was carded by an earlier check.
 */
function ensureSeatTickCard(project: string, card: SeatTickCard, at: string): boolean {
  /* The board file is resolved HERE, per call, rather than taken from the
     module-load default `mutateTasksFile` would otherwise use. That default is
     frozen the first time `@/lib/tasks/store` is imported anywhere in the
     process, so which file this writes to would depend on which module got
     imported first — the same reason `root/store.ts`, `flows/store.ts` and
     `session/titleStore.ts` each resolve their own path at call time. The tick
     is the one writer here that runs on a timer against whatever state dir the
     process is pointed at, so a stale path would put a real board card in
     someone else's board. In the Viewer both readings are identical. */
  return mutateTasksFile<boolean>((state) => {
    const existing = state.tasks.find((task) =>
      canonicalOrchestratorProject(task.project) === project
      && task.status !== "done"
      && monitorRefIn(task.text) === card.ref);
    if (card.state === "resolved") {
      if (!existing) return { state: undefined, result: true };
      const closed = patchTask(state.tasks, existing.id, { status: "done" });
      return closed.ok
        ? { state: { tasks: closed.tasks, recentCreates: state.recentCreates }, result: true }
        : { state: undefined, result: false };
    }
    const text = cardText(project, card, at);
    if (existing) {
      /* A card for something that HAPPENED is left exactly as it stands: its
         body carries the instant it was observed, so rewriting it would churn
         the board once per check for as long as the condition holds. Only a
         card that tracks a standing state — the one kind that declares its
         `state` — is kept in step with what it describes. */
      if (card.state !== "open") return { state: undefined, result: true };
      if (existing.text === text) return { state: undefined, result: true };
      const updated = patchTask(state.tasks, existing.id, { text });
      return updated.ok
        ? { state: { tasks: updated.tasks, recentCreates: state.recentCreates }, result: true }
        /* The condition is on the board either way; only its wording is stale. */
        : { state: undefined, result: true };
    }
    const created = createTask(state.tasks, {
      project,
      text,
      placement: "unplaced",
      /* The occurrence, not just the condition (#1298). Without it the second
         outage of a source replays the first outage's receipt and creates no
         card at all, once the first has been completed. */
      clientRequestId: monitorClientRequestId(card.instance ? `${card.ref}:${card.instance}` : card.ref),
    }, state.recentCreates);
    if (!created.ok) return { state: undefined, result: false };
    if (created.replay) return { state: undefined, result: true };
    return { state: { tasks: created.tasks, recentCreates: created.recentCreates }, result: true };
  }, statePath("tasks.json"));
}

/**
 * Whether the seat actually has the message, judged at the moment of the send.
 *
 * A send the delivery layer accepted is not the same as a wake the seat
 * received. `held` parks it behind an account migration, `queued` and
 * `delivering` leave it with the runtime host and not the audience, and
 * `pending` has not reached a host at all. Recording any of those as a wake
 * starts the hourly clock on a message nobody read, and — worse — acknowledges
 * the lifecycle events that produced it, which are then never offered again.
 *
 * `queued` is the one worth spelling out, because a structured host admits
 * EVERY send as queued whether it is idle or mid-turn: the answer here is not
 * "the host is busy", it is "the runtime host has this and the seat does not
 * yet". Which is exactly why a false is not the end of the story. The wake is
 * recorded against the operation the runtime host queued it under, and
 * {@link reconcileOutstandingWake} asks that host what became of it — so the
 * message the host does deliver is credited at the next check instead of being
 * disbelieved for ever, and the message it has not delivered yet can still be
 * taken back out of its queue.
 */
export function wakeReached(outcome: DeliveryOutcome): boolean {
  if (!outcome.ok) return false;
  switch (outcome.outcome) {
    case "held":
    case "queued":
    case "delivering":
    case "pending":
      return false;
    default:
      return true;
  }
}

function deliveryOutcomeLabel(outcome: DeliveryOutcome): string {
  return outcome.ok ? outcome.outcome ?? "delivered" : "failed";
}

/**
 * What the delivery layer said when it would not take the wake (#1771), or
 * null when it took it.
 *
 * The layer's own words, redacted and bounded like every other reason the
 * monitor writes down. It goes on the check's journal line, which is what the
 * seat surface reads back as the last run's detail — so a refusal is legible
 * where the mute tick is noticed, without asking the seat.
 */
function sendRefusalDetail(outcome: DeliveryOutcome): string | null {
  if (outcome.ok) return null;
  return `the delivery layer would not take the wake: ${redactBounded(outcome.error || "no reason was returned", REASON_LIMIT)}`;
}

function verdictDetail(verdict: SeatTickVerdict): string | null {
  if (verdict.kind === "skipped") return "the seat's turn is progressing; the tick is dropped, never queued";
  if (verdict.kind === "wake") {
    /* The gap is journaled beside the reasons, not in place of them (#1298):
       a wake that went out over an unreadable source has to be readable back
       as exactly that, or the journal shows a healthy hour where one reason
       was blind. */
    return [...verdict.reasons.map((reason) => reason.detail), ...verdict.gaps.map((gap) => gap.detail)].join("; ");
  }
  return verdict.detail;
}

/**
 * The wake's identity, and with it its idempotency.
 *
 * `clientMessageId` is the delivery layer's idempotency key, so this decides
 * which two sends are the same message. Both halves matter:
 *
 * - What the wake SAYS — the seat epoch, the reasons, the state fingerprint
 *   they were raised against — so a wake that never landed is re-raised at the
 *   next check under the same key and replays instead of stacking a second
 *   copy of a message the seat may still receive. A wake RELEASED as proven
 *   never executed is the one exception, and the reverse: its key is spent in
 *   the layers that refused it, so its replacement folds it in and is a new
 *   message to them (see {@link releasedWakeIdentity}).
 * - WHICH wake it is — the stamp of the last delivered one, which only a
 *   landed send advances. Without it the hourly wake on an unchanged board
 *   would carry the previous hour's key and be swallowed as a replay: silence
 *   the seat could not tell from a healthy board.
 *
 * The project's monitor prompt is part of what the wake says, so it belongs in
 * the first half — see {@link wakePromptIdentity} for why it is folded in as a
 * digest and why a promptless wake keeps the key it always had.
 */
function wakeClientMessageId(
  project: string,
  seatEpoch: number,
  verdict: SeatTickVerdict,
  context: { fingerprint: string; lastWakeAt: string | null; monitorPrompt: string | null; releasedWake?: SeatTickProjectState["releasedWake"] },
): string {
  const shape = verdict.kind === "wake"
    ? verdict.reasons.map((reason) => reason.kind).sort().join(",")
    : "proposal";
  return boundedWakeIdentity(`seat-tick:${project}:${seatEpoch}:${context.lastWakeAt ?? "first"}:${shape}:${context.fingerprint}`
    + wakePromptIdentity(context.monitorPrompt)
    + releasedWakeIdentity(context.releasedWake ?? null), project, seatEpoch);
}

/**
 * THE SAME IDENTITY, INSIDE THE BOUND THE DELIVERY LAYERS ENFORCE (#1771).
 *
 * The composition above is readable on purpose — every part of it is a fact an
 * operator reads straight off the key — and it grew one clause at a time
 * (#1280's prompt digest, #1672's released-wake digest) while nothing measured
 * it. The runtime journal refuses a key over
 * {@link RUNTIME_IDEMPOTENCY_KEY_LIMIT} characters inside its own admission,
 * before it writes an operation, an outbox effect or a ledger entry. So a
 * project whose name, stamp, reason list and two digests together crossed that
 * bound had every wake refused at the journal: nothing reached the seat,
 * nothing landed, `lastWakeAt` never moved, and the age-bound retirement then
 * appended the released-wake digest — making the replacement key LONGER than
 * the key it replaced. That loop cost a live seat a day of wakes.
 *
 * So the readable form is kept wherever it fits, byte for byte, and an
 * outstanding wake prepared under it still replays under it. A composition
 * that does not fit collapses into a digest of ITSELF behind the two parts an
 * operator needs to find the row at all — the project and the seat epoch. It
 * is derived from the whole composition, so two wakes are the same message
 * here exactly when they were the same message before, and the project name is
 * truncated rather than the digest when even that does not fit.
 */
function boundedWakeIdentity(identity: string, project: string, seatEpoch: number): string {
  if (runtimeIdempotencyKeyAdmissible(identity)) return identity;
  const tail = `:${seatEpoch}:digest-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
  const head = `seat-tick:${project}`;
  return `${head.slice(0, Math.max(0, RUNTIME_IDEMPOTENCY_KEY_LIMIT - tail.length))}${tail}`;
}

/**
 * The released attempt's share of the next wake's identity (#1672).
 *
 * A wake released as proven never executed leaves its key bound in the
 * runtime journal to the operation the journal refused, and the delivery
 * record re-arms that same operation for the same key. The wake raised in its
 * place carries the same obligations and, with nothing landed, the same stamp
 * and fingerprint — so without this it would be the same key, and the journal
 * would answer it by replaying the refusal, check after check, delivering
 * nothing. Folding the released key in makes the replacement a new message to
 * both layers, and keeps it one: the marker stands until a landing moves the
 * stamp, so an unlanded replacement still replays under its own key.
 */
function releasedWakeIdentity(released: SeatTickProjectState["releasedWake"]): string {
  if (!released) return "";
  return `:after-${crypto.createHash("sha256").update(released.clientMessageId).digest("hex").slice(0, 16)}`;
}

/**
 * The prompt's share of the wake's identity (#1280).
 *
 * The prompt is text the wake carries, and the delivery layer refuses a CHANGED
 * payload sent under a key it is already holding. So without this, a wake
 * carrying one prompt that the layer held or queued, followed by the record
 * being changed to another, produced the same key with different text at the
 * very next check: the replacement was refused, over and over, until the
 * outstanding wake settled on its own. Replacing and clearing a standing
 * instruction is the ordinary use of the field, so that is the ordinary case.
 *
 * A digest, because the key is a durable identifier written into the row, the
 * journal and the delivery layer's reservation, and a thousand characters of a
 * project's own prose has no business in any of them. Bounded, and derived from
 * the prompt alone, so the same prompt is the same identity at every later
 * check — which is what keeps an unlanded wake a replay the layer recognizes.
 *
 * A project with no prompt contributes NOTHING here, not the digest of an empty
 * string: the promptless key is byte for byte the key it was before the field
 * existed, so a promptless wake already outstanding still replays under it.
 * Nothing here decides WHEN a seat is woken; this decides which two sends the
 * delivery layer is entitled to treat as one message.
 */
function wakePromptIdentity(monitorPrompt: string | null): string {
  if (!monitorPrompt) return "";
  return `:prompt-${crypto.createHash("sha256").update(monitorPrompt).digest("hex").slice(0, 16)}`;
}

const REVOKED_WAKE_REASON = "the seat tick revoked a wake raised for a seat that has since been replaced";
/** The same revocation for the other retirement (#1746): the attempt was
    retired unresolved on its age, a later wake carries everything it named, and
    the payload is worth taking back out of the queue precisely because the seat
    it is addressed to is still the seat — the one duplicate this issue accepts
    is a duplicate it need not accept where the holder will still give it up. */
const RETIRED_ON_AGE_WAKE_REASON = "the seat tick revoked a wake it retired unresolved after its age bound, whose obligations a later wake carries";

/** What the holder answered about an attempt, with the evidence it showed. A
    holder that could not answer at all is `unreadable`, with why. */
interface WakeObservation {
  observed: SeatTickWakeState | "unreadable";
  evidence: SeatTickWakeEvidence | null;
  reason: string;
}

/** Ask the holder, and never let its failure take the check down: a holder
    that cannot answer is not evidence either way, so the attempt stays
    outstanding and the next check asks again. */
async function observeWake(sources: SeatTickSources, wake: SeatTickOutstandingWake): Promise<WakeObservation> {
  try {
    const answer = await sources.wakeState(wake);
    return typeof answer === "string"
      ? { observed: answer, evidence: null, reason: "" }
      : { observed: answer.state, evidence: answer.evidence, reason: "" };
  } catch (error) {
    return { observed: "unreadable", evidence: null, reason: redactMonitorText(error instanceof Error ? error.message : "unknown error") };
  }
}

/** Bounded prose for a reason the delivery layer wrote. */
const REASON_LIMIT = 200;

/**
 * The evidence behind a holder's answer, in one clause an operator can check:
 * the operation the record holds under the key, what the record says of it,
 * and what the runtime journal answered. Null when the answer showed none.
 */
function evidenceSummary(evidence: SeatTickWakeEvidence | null): string | null {
  if (!evidence) return null;
  const parts: string[] = [];
  if (evidence.record) {
    const record = evidence.record;
    const ending = record.state === "delivered" ? "delivered"
      : record.state === "in-flight" ? "in flight"
        : record.resend === "safe" ? "failed, proven lost" : "failed, unverified";
    parts.push(`delivery record: ${ending}${record.reason ? ` — ${redactBounded(record.reason, REASON_LIMIT)}` : ""}`);
  } else {
    parts.push("delivery record: nothing under the key");
  }
  parts.push(evidence.operationId ? `operation ${evidence.operationId}` : "no operation named");
  const journal = evidence.journal;
  parts.push(journal === "no-record" ? "runtime journal holds no record of it"
    : journal === "unreachable" ? "runtime journal unreachable"
      : journal === "unasked" ? "runtime journal not asked"
        : `runtime journal: ${journal.status}${journal.reason ? ` — ${redactBounded(journal.reason, REASON_LIMIT)}` : ""}`);
  if (evidence.recorded === "lost") parts.push("the delivery record was settled lost on the journal's own verdict");
  if (evidence.recorded === "delivered") parts.push("the delivery record was settled delivered on the journal's own verdict");
  if (evidence.recorded === "refused") parts.push("the delivery record could not take the journal's verdict and keeps its own answer; the release rests on the journal alone");
  return parts.join("; ");
}

/** The holder's last word for a card or a journal line. */
function holderAnswer(observation: WakeObservation): string {
  if (observation.observed === "unreadable") return `could not be read${observation.reason ? ` (${observation.reason})` : ""}`;
  const summary = evidenceSummary(observation.evidence);
  return `answered "${observation.observed}"${summary ? ` (${summary})` : ""}`;
}

/** A settlement's own detail, with the evidence it rests on beside it. */
function withEvidence(detail: string, observation: WakeObservation): string {
  const summary = evidenceSummary(observation.evidence);
  return summary ? `${detail}; ${summary}` : detail;
}

/**
 * What ends a kept attempt, one exit per line. An attempt fenced for days is
 * a fence an operator has to be able to reason about, so every exit the tick
 * will take on its own is named — and, when the journal holds no record of
 * the operation, it says plainly that an operator discard cannot reach it
 * either. Read by the card that carries the attempt and by the diagnostic
 * surface, so the two never disagree about what would end it.
 */
export function seatTickAttemptExits(evidence: SeatTickWakeEvidence | null, lapsesAt?: string | null): string[] {
  const exits = [
    "the delivery record or the runtime journal reporting the operation delivered, which credits the plan the wake was raised on",
    "the journal reporting it rejected or failed before actuation, or the record proving it lost, which releases the key and lets the next check raise the wake again",
    "the seat being superseded by a different conversation at a higher epoch, which retires the attempt and lets the successor's own wake go out",
    /* #1746 replaced the line that stood here — "age alone ends nothing" — and
       the replacement has to say what the age does end. Not the obligation: an
       attempt retired on age keeps its key and its payload, is never re-sent
       and credits nothing whatever becomes of it. What ends is the fence. */
    `its age bound${lapsesAt ? ` at ${lapsesAt.slice(0, 16).replace("T", " ")} UTC` : " — two of this project's wake intervals, and never less than an hour, from when it was prepared"}, which retires it unresolved: it is never re-sent and credits nothing, and the obligations it named are re-derived by the next check, which may wake the seat`,
  ];
  if (evidence?.journal === "no-record" && evidence.operationId) {
    exits.push(`the runtime journal holds no record under operation ${evidence.operationId}, so an operator discard of that operation cannot reach it; supersession and the age bound are the exits left that need no new evidence`);
  }
  return exits;
}

function keptAttemptExits(evidence: SeatTickWakeEvidence | null, lapsesAt: string | null): string {
  return ` What ends it: ${seatTickAttemptExits(evidence, lapsesAt).join("; ")}.`;
}

/**
 * Positive proof that the seat an attempt was addressed to has been replaced
 * (#1594), or null.
 *
 * This is deliberately stricter than the `replaced` test that decides whether
 * to REVOKE an attempt, because it licenses something else: releasing the fence
 * that keeps a second wake out of flight. Revocation is safe on weak evidence —
 * taking a payload back from a seat that turns out to still be there costs one
 * wake. Releasing the fence on weak evidence puts two wakes in flight to one
 * seat, which is the failure the fence exists for. So it takes all three:
 *
 * - a seat that is actually there, because a seat file that reads empty or
 *   could not be read is an absence of evidence, not a successor;
 * - a strictly higher epoch, which is the project's own monotonic proof that
 *   the seat moved on rather than a row that disagrees about which seat it is;
 * - a different conversation, because a re-designation of the SAME conversation
 *   at a higher epoch is one seat: a payload still in the queue for it would
 *   reach the live seat, and a second wake beside it is exactly a duplicate.
 */
function supersededSeat(
  seat: { conversationId: string | null; seatEpoch: number } | null,
  wake: SeatTickOutstandingWake,
): SeatTickRetiredWake["supersededBy"] | null {
  if (!seat?.conversationId) return null;
  if (seat.seatEpoch <= wake.seatEpoch || seat.conversationId === wake.conversationId) return null;
  return { conversationId: seat.conversationId, seatEpoch: seat.seatEpoch };
}

/** What retirement this check owes the attempt, or null to keep it where it
    is. The two reasons and what each rests on are in
    {@link SeatTickRetirementReason}. */
type Retirement = { reason: SeatTickRetirementReason; supersededBy: SeatTickRetiredWake["supersededBy"] };

/**
 * Whether this check moves the attempt out of the fence, and on what evidence
 * (#1594, #1746).
 *
 * The supersession half is #1594's and unchanged: positive proof that the
 * conversation the payload was addressed to no longer holds the seat.
 *
 * The age half is #1746's, and it is three conditions rather than one, because
 * each of them is the fence doing a job worth keeping:
 *
 * - The holder has proved nothing either way. `retained` is deliberately not
 *   here: a holder that affirms it still HAS the payload is going to deliver
 *   it, and retiring that would turn a wake still on its way into a guaranteed
 *   duplicate. What the bound ends is an attempt no evidence can settle — the
 *   #1672 shape, where the record is `unverified` for ever and the runtime
 *   journal has been compacted past the operation.
 * - No transport call is out. A send whose call has not returned may still be
 *   reserving or actuating, and retiring it would let a second wake go to ONE
 *   seat while the first is mid-flight. That is the rule the fence is actually
 *   for, and it is the rule that stays.
 * - The attempt has been fenced for its whole bound, measured from an instant
 *   the row records. An attempt with no such instant is stamped by this same
 *   check, one bound before it can be retired on age.
 */
function retirementFor(context: {
  seat: { conversationId: string | null; seatEpoch: number } | null;
  wake: SeatTickOutstandingWake;
  observed: SeatTickWakeState | "unreadable";
  now: number;
  wakeIntervalMs: number;
}): Retirement | null {
  const superseded = supersededSeat(context.seat, context.wake);
  if (superseded) return { reason: "seat-superseded", supersededBy: superseded };
  if (!seatTickFenceRetirableOnAge(context.wake, context.observed, context.now, context.wakeIntervalMs)) return null;
  return { reason: "unresolved-age", supersededBy: null };
}

/**
 * What a check has to say about a retired attempt, and whether it ended.
 *
 * The verdicts are the outstanding reconcile's own, read the same way off the
 * journal — with one thing removed. A retired attempt never commits: it was
 * addressed to a seat this project has replaced, so even `landed` acknowledges
 * nothing, moves no stamp and harvests no child. Everything it named is still
 * owed, and the successor's own wake is what carries it.
 */
interface RetiredSettlement {
  verdict: SeatTickVerdictKind;
  outcome: string;
  detail: string;
}

/** What took this attempt out of the fence, in one clause an operator reads.
    Both retirements are the same row under the same rule — never re-sent,
    crediting nothing — and differ only in the evidence that moved them. */
function retiredAs(entry: SeatTickRetiredWake): string {
  return entry.supersededBy ? "retired to a superseded seat" : "retired unresolved on its age bound";
}

/**
 * Ask, every check, what became of the attempts a superseded seat left behind
 * (#1594).
 *
 * This is the whole of what retirement keeps: the holder is still asked, a
 * holder that still HAS the payload is still asked to give it back, and a wait
 * that has outlived the interval is still on the board. What it deliberately
 * does not do is re-dispatch. The payload was prepared for a conversation that
 * no longer holds the project, and there is no answer — not `absent`, not a
 * refusal, not age — that makes sending it again the right thing: the only
 * caller that could admit it reads {@link SeatTickProjectState.outstandingWake},
 * which a retired attempt is no longer in.
 */
async function reconcileRetiredWakes(context: {
  project: string;
  state: SeatTickProjectState;
  sources: SeatTickSources;
  appendRecord: typeof appendSeatTickRecord;
  writeState: typeof writeSeatTickState;
  ensureCard: (project: string, card: SeatTickCard, at: string) => boolean;
  at: string;
  now: number;
  wakeIntervalMs: number;
}): Promise<SeatTickProjectState> {
  let state = context.state;
  const entries = [...state.retiredWakes];
  if (!entries.length) return state;
  for (const entry of entries) {
    const wake = entry.wake;
    const observation = await observeWake(context.sources, wake);
    const observed = observation.observed;
    let settlement: RetiredSettlement | null = null;
    /* The divergence named at the outstanding path's own `landed` branch: there
       a landing commits even when the seat has been replaced, here it credits
       nothing. This is the safe half of the disagreement and the reason it is
       tolerable while #1604 is open — an obligation kept owed costs the
       successor a repeat, an obligation discharged on a seat that never held it
       costs the successor the instruction entirely. */
    if (observed === "landed") {
      settlement = { verdict: "landed", outcome: "landed",
        detail: entry.supersededBy
          ? "a wake retired to a superseded seat was delivered to it after all; nothing it carried is credited, because the seat that received it no longer holds this project, so every obligation it named is still owed and the successor's own wake carries it"
          /* An age retirement's landing reached the seat that still holds the
             project, and it still credits nothing: the check that retired it
             re-derived everything it named into a wake of its own, and
             crediting both would acknowledge the same obligations twice. */
          : "a wake retired unresolved on its age bound was delivered after all; nothing it carried is credited, because the check that retired it re-derived every obligation it named into a later wake" };
    } else if (observed === "dropped") {
      settlement = { verdict: "dropped", outcome: "dropped",
        detail: `the layer holding a wake ${retiredAs(entry)} settled it without delivering it; the obligations it named were never credited and remain owed` };
    } else if (observed === "retained") {
      let withdrawal: Awaited<ReturnType<SeatTickSources["withdrawWake"]>>;
      try { withdrawal = await context.sources.withdrawWake(wake, entry.supersededBy ? REVOKED_WAKE_REASON : RETIRED_ON_AGE_WAKE_REASON); }
      catch { withdrawal = "unknown"; }
      if (withdrawal === "withdrawn") {
        settlement = { verdict: "revoked", outcome: "withdrawn",
          detail: entry.supersededBy
            ? "a wake retired to a superseded seat was taken out of the queue holding it before it could reach that seat"
            : "a wake retired unresolved on its age bound was taken out of the queue holding it, so the wake that replaced it is the only one this seat receives" };
      }
    } else if (observed === "absent" && !wake.operationId && wake.dispatch?.state !== "active") {
      /* The holder affirms it is holding nothing under this key, and no
         transport call is out. Where an outstanding attempt would be
         re-dispatched on that answer, this one is released and never sent:
         the seat it names is gone, or a later wake already carries what it
         named. */
      settlement = { verdict: "revoked", outcome: "unsent",
        detail: `the layer holding a wake ${retiredAs(entry)} affirms it holds nothing under its key and no transport call is outstanding: the attempt is released unsent, and it is never re-dispatched because `
          + (entry.supersededBy ? "the seat it was prepared for has been replaced" : "the check that retired it already re-derived every obligation it named") };
    }
    /* An answer that settles nothing leaves the board and no journal line —
       which is where this path parts company with the outstanding one, and on
       purpose. There a keep-verdict (`too-late`, `unknown`, `uncertain`) writes
       a line every check, and it can afford to: a project has at most ONE
       outstanding attempt, so that is one extra line per check. Here a project
       may hold {@link SEAT_TICK_RETIRED_WAKE_LIMIT} of them, and twenty lines
       per five-minute check would evict the journal's whole
       `SEAT_TICK_RUN_HISTORY` of history in two checks — the audit trail
       spent on repeating what has not changed. The standing condition is the
       card's to carry, and the retirement line already recorded what the holder
       last answered at the moment the attempt was retired. */
    if (!settlement) {
      const preparedAt = Date.parse(wake.preparedAt ?? entry.retiredAt);
      const overdue = Number.isFinite(preparedAt) && context.now - preparedAt >= context.wakeIntervalMs;
      if (overdue || observed === "uncertain") {
        const detail = `A wake prepared ${(wake.preparedAt ?? entry.retiredAt).slice(0, 16).replace("T", " ")} UTC for seat epoch ${wake.seatEpoch},`
          + `${entry.supersededBy ? ` which epoch ${entry.supersededBy.seatEpoch} has since replaced,` : " retired unresolved on its age bound,"}`
          + ` is still unresolved under its original key; the layer holding it last ${holderAnswer(observation)}.`
          + " The attempt is never re-sent and nothing it named is credited, and it no longer holds back this project's wakes."
          + ` Check the delivery record under its client message id ${wake.clientMessageId}`;
        try {
          context.ensureCard(context.project, { ref: seatTickWakeUnresolvedRef(wake.clientMessageId), kind: "wake-unresolved", instance: wake.clientMessageId, detail }, context.at);
        } catch (error) {
          console.error("[seat tick] card write failed", error instanceof Error ? error.name : "unknown");
        }
      }
      continue;
    }
    if (state.accounting) {
      const accounting = new SeatTickAccounting(state.accounting.filename, context.project);
      if (!accounting.settleRetired(wake.clientMessageId)) {
        state = accounting.readState();
        continue;
      }
      state = accounting.readState();
    } else {
      state = { ...state, retiredWakes: state.retiredWakes.filter((held) => held.wake.clientMessageId !== wake.clientMessageId) };
      context.writeState(context.project, state);
    }
    context.appendRecord({
      schemaVersion: 1,
      at: context.at,
      project: context.project,
      seatEpoch: wake.seatEpoch,
      verdict: settlement.verdict,
      reasons: [],
      items: 0,
      deferred: 0,
      eventsThrough: state.eventsThrough ?? 0,
      delivery: { clientMessageId: wake.clientMessageId, outcome: settlement.outcome },
      detail: withEvidence(settlement.detail, observation),
    });
  }
  return state;
}

/** What the reconcile concluded: the journal line it owes, and what the row
    does with the wake — credit it, forget it, or keep it for the next check.
    Null is the answer that settles nothing and is worth no line of its own. */
interface WakeSettlement {
  verdict: SeatTickVerdictKind;
  outcome: string;
  detail: string;
  /** Only landed evidence commits; only proven non-delivery clears. Everything
      else keeps the attempt under its original identity. */
  row: "commit" | "clear" | "keep";
}

/** Reconcile the frozen attempt against its delivery record. Arrival commits
 * its plan; fenced loss releases it. Everything else retains identity and
 * receives attention after the wake interval.
 *
 * An absent key alone proves no ending. Rotation may release a no-handle
 * attempt only after its admitted transport returned a refusal, and only if
 * the dispatch token still matches in the accounting transaction. All sends,
 * including same-key retries, claim that token before entering transport.
 * A paused old caller therefore either blocks replacement or fails admission
 * after replacement. Throws and legacy attempts retain unknown authority.
 */
async function reconcileOutstandingWake(context: {
  project: string;
  state: SeatTickProjectState;
  /** The seat as it stands NOW. A seat row with no conversation id is nobody
      the wake could have been addressed to, so it reads as a replacement. */
  seat: { conversationId: string | null; seatEpoch: number; path?: string | null } | null;
  sources: SeatTickSources;
  appendRecord: typeof appendSeatTickRecord;
  writeState: typeof writeSeatTickState;
  ensureCard: (project: string, card: SeatTickCard, at: string) => boolean;
  /** The transport, for the same-key re-dispatch. Absent means this reconcile
      never re-dispatches — the one that follows a send in the same check. */
  deliver?: typeof deliverConversationMessage;
  at: string;
  now: number;
  wakeIntervalMs: number;
}): Promise<SeatTickProjectState> {
  const outstanding = context.state.outstandingWake;
  if (!outstanding) return context.state;
  let state = context.state;
  const persist = (next: SeatTickProjectState): SeatTickProjectState => {
    if (next.accounting) {
      const accounting = new SeatTickAccounting(next.accounting.filename, context.project);
      accounting.writeState(next);
      return accounting.readState();
    }
    context.writeState(context.project, next);
    return next;
  };
  /* An attempt written before the instant existed is stamped when first seen,
     so the attention bound below is measured from a fact. */
  if (!outstanding.preparedAt) state = persist({ ...state, outstandingWake: { ...outstanding, preparedAt: context.at } });
  let wake = state.outstandingWake!;
  const preparedAt = Date.parse(wake.preparedAt!);
  const overdue = Number.isFinite(preparedAt) && context.now - preparedAt >= context.wakeIntervalMs;
  const replaced = !context.seat
    || context.seat.conversationId !== wake.conversationId
    || context.seat.seatEpoch !== wake.seatEpoch;

  /* A holder that cannot answer must not take the check down with it, and it
     is not evidence either way: the wake stays outstanding, so the next check
     asks again rather than crediting or discarding it on a failed read. */
  const observation = await observeWake(context.sources, wake);
  const observed = observation.observed;
  let reason = observation.reason;
  let settlement: WakeSettlement | null = null;
  let redispatched: string | null = null;
  /* And why, when the re-dispatch was refused (#1771): the same-key recovery
     answering "failed" check after check with nothing saying what refused it
     is the silence this issue was filed for. */
  let redispatchReason: string | null = null;
  /* A landing is asked about before a replacement, so a wake that reaches a
     conversation the project has since replaced still commits here — the stamp,
     the cursor and every child it named. That is not what the retired path
     does with the same physical event (see `reconcileRetiredWakes`), and the
     two are reachable for one attempt depending only on whether an earlier
     check retired it first. Both readings are defensible: this one discharges
     the obligation because SOMEONE was told, the retired one keeps it owed
     because the successor was not, and the retired one is the safe direction —
     at worst the successor is told again. What decides between them is a
     question about what "told" means across a rotation, not a question about
     this branch, so it is not settled here: #1604. */
  if (observed === "landed") {
    settlement = { verdict: "landed", outcome: "landed", row: "commit",
      detail: "a wake the delivery layer had kept reached the seat; the wake stamp and the event cursor move now, on the plan the check that raised it wrote down" };
  } else if (observed === "dropped") {
    settlement = { verdict: "dropped", outcome: "dropped", row: "clear",
      detail: "the layer holding the wake settled it without delivering it, so no stamp moves and the next check may raise it again" };
  } else if (replaced) {
    if (observed === "retained") {
      let withdrawal: Awaited<ReturnType<SeatTickSources["withdrawWake"]>>;
      try { withdrawal = await context.sources.withdrawWake(wake, REVOKED_WAKE_REASON); }
      catch (error) { withdrawal = "unknown"; reason = redactMonitorText(error instanceof Error ? error.message : "unknown error"); }
      settlement = withdrawal === "withdrawn"
        ? { verdict: "revoked", outcome: "withdrawn", row: "clear",
          detail: "a wake the delivery layer had accepted but not landed was taken out of its queue before it could reach the replaced seat" }
        : withdrawal === "too-late"
          ? { verdict: "revoked", outcome: "too-late", row: "keep",
            detail: "the wake raised for the replaced seat could not be taken back: the layer holding it had already let it go, so the replaced seat may have received it; the attempt is kept under its original key until the holder settles it" }
          : { verdict: "revoked", outcome: "unknown", row: "keep",
            detail: `the wake raised for the replaced seat could not be revoked: the layer holding it did not answer${reason ? ` (${reason})` : ""}; it is asked again at the next check` };
    } else if (observed === "uncertain") {
      settlement = { verdict: "uncertain", outcome: "uncertain", row: "keep",
        detail: "the layer holding the wake raised for the replaced seat ended it without proving arrival; the original key and all obligations remain outstanding, and no wake replaces it" };
    } else if (observed === "absent" && !wake.operationId && wake.text && wake.dispatch?.state === "refused" && state.accounting) {
      const accounting = new SeatTickAccounting(state.accounting.filename, context.project);
      if (!accounting.settleAbsent(wake)) return accounting.readState();
      state = accounting.readState();
      settlement = { verdict: "revoked", outcome: "unsent", row: "clear",
        detail: "the wake raised for the replaced seat was refused by the delivery layer before it reserved anything, and the record holds nothing under its key and the returned dispatch token was fenced atomically: the attempt is released unsent with nothing it named acknowledged, and the successor's next check raises its own wake" };
    } else {
      settlement = { verdict: "revoked", outcome: "unknown", row: "keep",
        detail: `the wake raised for the replaced seat could not be revoked: no holder could account for it${reason ? ` (${reason})` : ""}; it is asked again at the next check` };
    }
  } else if (observed === "uncertain") {
    settlement = { verdict: "uncertain", outcome: "uncertain", row: "keep",
      detail: "the layer holding the wake ended it without proving arrival; the original key and all obligations remain outstanding, and no wake replaces it" };
  } else if (observed === "absent" && !wake.operationId && wake.text && (!wake.dispatch || wake.dispatch.state === "refused") && context.deliver) {
    /* The same-identity recovery described above: the layer affirms it holds
       nothing under this key and the send never received an operation, so the
       frozen payload goes out again under the key it was prepared with — if,
       at this instant, the row still carries this attempt and the seat is
       still the one it was prepared for. A row that moved on belongs to the
       controller that moved it; a seat that moved is the next check's to
       release. */
    const held = state.accounting ? new SeatTickAccounting(state.accounting.filename, context.project).readState() : state;
    const authority = context.sources.seatFor(context.project).active;
    if (held.outstandingWake?.clientMessageId !== wake.clientMessageId) return held;
    if (!authority || authority.conversationId !== wake.conversationId || authority.seatEpoch !== wake.seatEpoch) return state;
    const accounting = state.accounting ? new SeatTickAccounting(state.accounting.filename, context.project) : null;
    if (!accounting) return state;
    const token = accounting.beginDispatch(wake);
    state = accounting.readState();
    if (!token) return state;
    wake = state.outstandingWake!;
    let outcome: DeliveryOutcome | null = null;
    try {
      outcome = await context.deliver({ pid: null, path: authority.path ?? context.seat?.path ?? "", conversationId: wake.conversationId,
        clientMessageId: wake.clientMessageId, text: wake.text!, images: [], origin: { kind: "agent", role: "seat-tick" } });
      redispatched = deliveryOutcomeLabel(outcome);
      redispatchReason = sendRefusalDetail(outcome);
    } catch (error) {
      redispatched = "unreturned";
      redispatchReason = `the transport call did not return: ${redactBounded(error instanceof Error ? error.message : "unknown error", REASON_LIMIT)}`;
    }
    if (outcome) {
      accounting.returnedDispatch(wake.clientMessageId, token, !outcome.ok && !outcome.operationId && outcome.actuation !== "started" && outcome.resend !== "verify-first");
      state = accounting.readState();
      if (state.outstandingWake?.clientMessageId !== wake.clientMessageId) return state;
      wake = state.outstandingWake!;
    }
    if (outcome && wakeReached(outcome)) {
      settlement = { verdict: "landed", outcome: "landed", row: "commit",
        detail: "a wake the delivery layer had refused without keeping a record was re-dispatched under its original key and reached the seat; the wake stamp and the event cursor move now, on the plan the check that raised it wrote down" };
    } else if (outcome?.operationId) {
      /* The layer now holds it: the next check asks that holder. */
      state = persist({ ...state, outstandingWake: { ...wake, operationId: outcome.operationId } });
      wake = state.outstandingWake!;
    }
  }
  /* `retained` is the steady state between two checks; `unknown`, `absent` and
     an unreadable holder proved nothing. None settles anything, and none is
     worth a line of its own beside the check's — the check's line carries the
     deferral, and the board carries the wait once it has outlived the interval. */

  /* Durable attention (#1465): an attempt kept past the project's wake interval,
     and a receipt the host ended unverified the moment it is seen, go on the
     board once each — the attempt's own key is the occurrence. The card says
     what the holder last answered and what the operator can check; the tick
     itself dispatches nothing new for this project until the attempt settles. */
  if (settlement?.row === "clear" && wake.dispatch?.state === "active") {
    settlement = { ...settlement, row: "keep", outcome: "unknown",
      detail: "the delivery record was fenced, but its admitted transport call has not returned; the original attempt remains outstanding until that call is accounted for" };
  }
  const kept = !settlement || settlement.row === "keep";
  /* #1594, #1746. A kept attempt is an obligation, and it is also a fence on
     the next wake — two jobs one field was doing at once. The obligation is
     right and survives; the fence is only sound while the attempt can still
     reach the seat the tick is about to wake AND could still be settled by
     evidence. Given either proof — the seat superseded, or the age bound spent
     with nothing proved — the attempt moves to the retired slot: same key,
     same payload, same landing plan, still asked after every check, crediting
     nothing whatever becomes of it — and out of the way of a wake that would
     otherwise wait behind an answer that is never coming. */
  const retirement = kept ? retirementFor({ seat: context.seat, wake, observed, now: context.now, wakeIntervalMs: context.wakeIntervalMs }) : null;
  let retired = false;
  let evicted: string | null = null;
  if (retirement) {
    if (state.accounting) {
      const accounting = new SeatTickAccounting(state.accounting.filename, context.project);
      const moved = accounting.retire(wake, context.at, retirement, context.now - seatTickFenceBoundMs(context.wakeIntervalMs));
      retired = moved.retired;
      evicted = moved.evicted;
      state = accounting.readState();
    } else if (state.retiredWakes.length < SEAT_TICK_RETIRED_WAKE_LIMIT) {
      state = persist({ ...state, outstandingWake: null,
        retiredWakes: [...state.retiredWakes, { wake, retiredAt: context.at, ...retirement }],
        releasedWake: { clientMessageId: wake.clientMessageId, releasedAt: context.at } });
      retired = true;
    }
  }
  const lapsesAt = seatTickFenceLapsesAt(wake.preparedAt ?? null, context.wakeIntervalMs);
  if (kept && (overdue || observed === "uncertain")) {
    const detail = `A wake prepared ${wake.preparedAt!.slice(0, 16).replace("T", " ")} UTC for ${replaced ? "a seat that has since been replaced" : "this seat"}`
      + ` is still unresolved under its original key; the layer holding it last ${holderAnswer(observation)}${redispatched ? `, and a re-dispatch under the same key answered "${redispatched}"${redispatchReason ? ` — ${redispatchReason}` : ""}` : ""}.`
      + (retired
        ? (retirement!.reason === "seat-superseded"
          ? " The attempt is kept under that seat, never re-sent and crediting nothing, and it no longer holds back this project's wakes."
          : " The attempt is retired unresolved on its age bound, never re-sent and crediting nothing: it no longer holds back this project's wakes, and the next check re-derives everything it named.")
        : " The tick keeps the attempt and dispatches no replacement wake for this project until it lands or the delivery record proves it never actuated."
          + keptAttemptExits(observation.evidence, lapsesAt))
      + ` Check the seat's conversation for the wake and the delivery record under its client message id ${wake.clientMessageId}`;
    try {
      context.ensureCard(context.project, { ref: seatTickWakeUnresolvedRef(wake.clientMessageId), kind: "wake-unresolved", instance: wake.clientMessageId, detail }, context.at);
    } catch (error) {
      console.error("[seat tick] card write failed", error instanceof Error ? error.name : "unknown");
    }
  }
  /* A retirement is worth a line even when the holder's answer was not: it is
     the instant this project's wakes started flowing again, and an operator
     reading the journal for the silence has to find its end there. */
  if (!settlement && !retired) return state;

  const next: SeatTickProjectState = settlement?.row === "commit"
    ? seatTickWakeCommit(state, wake.commit, context.now)
    : settlement?.row === "clear"
      /* Released, and remembered as such: the key stays bound in the layers
         that refused it, so the wake raised in its place must not be it. */
      ? { ...state, outstandingWake: null, releasedWake: { clientMessageId: wake.clientMessageId, releasedAt: context.at } }
      : state;

  context.appendRecord({
    schemaVersion: 1,
    at: context.at,
    project: context.project,
    seatEpoch: wake.seatEpoch,
    /* One line, both facts: what the holder answered is the outcome, and the
       verdict says the attempt stopped fencing this project's wakes. */
    verdict: retired ? "retired" : settlement!.verdict,
    reasons: [],
    items: 0,
    deferred: 0,
    eventsThrough: next.eventsThrough ?? 0,
    delivery: { clientMessageId: wake.clientMessageId, outcome: settlement?.outcome ?? observed },
    detail: withEvidence(retired ? retirementDetail(settlement?.detail ?? null, retirement!, wake, evicted) : settlement!.detail, observation),
  });
  if (retired) return state;
  if (settlement!.row === "keep") return next;
  if (state.accounting) {
    const accounting = new SeatTickAccounting(state.accounting.filename, context.project);
    accounting.settle(wake.clientMessageId, next, settlement!.row === "commit" ? "landed" : "unsent");
    return accounting.readState();
  }
  context.writeState(context.project, next);
  return next;
}

/** The retirement's own clause, after whatever the holder's answer said. */
function retirementDetail(settled: string | null, retirement: Retirement, wake: SeatTickOutstandingWake, evicted: string | null): string {
  const moved = retirement.reason === "seat-superseded"
    ? `the attempt is retired to seat epoch ${wake.seatEpoch}, which epoch ${retirement.supersededBy!.seatEpoch} has replaced`
    : `the attempt is retired unresolved on its age bound: it has been fenced since ${(wake.preparedAt ?? "").slice(0, 16).replace("T", " ")} UTC with nothing proving its delivery either way`;
  const kept = "it keeps its original key, is never re-sent, credits nothing whatever becomes of it, and no longer withholds this project's wakes";
  const rederived = retirement.reason === "unresolved-age"
    ? "; every obligation it named is still owed and the next check derives its own wake from them"
    : "";
  const room = evicted
    ? `; the retained-attempt bound was full, so the entry fenced longest ago, under key ${evicted}, was dropped from the row — it credited nothing and fenced nothing, and its own retirement stands in this journal`
    : "";
  return `${settled ? `${settled}; ` : ""}${moved}: ${kept}${rederived}${room}`;
}

/**
 * One check of one project: read, decide, maybe wake, journal.
 *
 * Returns the journal line it wrote, so a caller — a test, or a future status
 * surface — reads exactly what was recorded rather than a parallel summary. It
 * throws only if the journal append itself fails; every other failure becomes
 * an `error` line, because a check that vanished silently is the ambiguity this
 * journal exists to remove.
 */
export async function runSeatTickCheck(
  project: string,
  dependencies: SeatTickControllerDependencies = {},
): Promise<SeatTickRunRecord | null> {
  const policy = dependencies.policy === undefined ? seatTickPolicy() : dependencies.policy;
  if (!policy) return null;
  const appendRecord = dependencies.appendRecord ?? appendSeatTickRecord;
  /* Canonical before the read, because the write below is keyed by the
     canonical name: an alias read against a canonical write would find an empty
     row every check, and an empty row has never been woken, so the tick would
     wake on every check instead of hourly. */
  const canonical = canonicalOrchestratorProject(project);

  try {
    return await check(canonical, policy, dependencies, appendRecord);
  } catch (error) {
    const record: SeatTickRunRecord = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      project: canonical,
      seatEpoch: null,
      verdict: "error",
      reasons: [],
      items: 0,
      deferred: 0,
      eventsThrough: 0,
      delivery: null,
      detail: `the check failed: ${redactMonitorText(error instanceof Error ? error.message : "unknown error")}`,
    };
    appendRecord(record);
    return record;
  }
}

async function check(
  canonical: string,
  policy: SeatTickPolicy,
  dependencies: SeatTickControllerDependencies,
  appendRecord: typeof appendSeatTickRecord,
): Promise<SeatTickRunRecord> {
  const sources = dependencies.sources ?? defaultSeatTickSources();
  const readState = dependencies.readState ?? readSeatTickState;
  const writeState = dependencies.writeState ?? writeSeatTickState;
  const deliver = dependencies.deliver ?? deliverConversationMessage;
  const ensureCard = dependencies.ensureCard ?? ensureSeatTickCard;

  /* BEFORE A SEAT IS READ AT ALL (#1757): converge the active seat with the
     launch it was activated on, so this check opens on the seat the operator
     can actually reach rather than on a provisional one whose launch died. */
  const rollbackDetail = await reconcileProvisionalSeat(canonical, dependencies);

  /* Then, before anything else is READ, let alone decided: settle the wake
     this project left outstanding. It comes before the rest because both of
     its answers change what this check may conclude — a landing moves the event cursor
     the gather pages from and starts the hourly bound, and a rotation means
     taking the payload back out of the queue the row carried it across the
     rotation for. */
  const opening = sources.now();
  const openingSeat = sources.seatFor(canonical).active ?? null;
  const openingInterval = wakeIntervalFor(canonical, opening, sources);
  /* Retired attempts first (#1594), so an attempt this check is about to retire
     is asked of its holder by the NEXT check rather than twice by this one. */
  const drained = await reconcileRetiredWakes({
    project: canonical,
    state: seatTickStateForEpoch(readState(canonical), openingSeat?.seatEpoch ?? null),
    sources,
    appendRecord,
    writeState,
    ensureCard,
    at: new Date(opening).toISOString(),
    now: opening,
    wakeIntervalMs: openingInterval,
  });
  const settled = await reconcileOutstandingWake({
    project: canonical,
    state: drained,
    seat: openingSeat,
    sources,
    appendRecord,
    writeState,
    ensureCard,
    deliver,
    at: new Date(opening).toISOString(),
    now: opening,
    wakeIntervalMs: openingInterval,
  });

  const gathered = await gatherSeatTickInput(canonical, settled, policy, sources);
  const at = new Date(gathered.now).toISOString();
  /* The gather's own row, not the one it was handed: a first check seals the
     event cursor at the journal head while reading it, and re-deriving the row
     from `settled` here would drop the seal and read the whole journal as
     unread again at the next check. */
  const input = { ...gathered, state: seatTickStateForEpoch(gathered.state, gathered.seat?.seatEpoch ?? null) };
  const decision = seatTickDecision(input);

  /* An expiry that passed is already reflected in everything above — the
     reading applies it wherever the record is read — so this write changes no
     behaviour. What it changes is the RECORD: a row that still says "off"
     beside a tick that is ticking is the kind of disagreement someone reads
     off the board at the worst possible moment. */
  if (input.settings.lapsed) {
    try {
      (dependencies.writeSettings ?? writeSeatTickSettings)(input.project, seatTickSettingsAfterLapse(input.project, input.settings));
    } catch (error) {
      console.error("[seat tick] lapsed settings could not be persisted", error instanceof Error ? error.name : "unknown");
    }
  }

  let state = decision.state;
  for (const card of decision.cards) {
    let carded = false;
    try {
      carded = ensureCard(input.project, card, at);
    } catch (error) {
      console.error("[seat tick] card write failed", error instanceof Error ? error.name : "unknown");
    }
    /* The outage is remembered as reported only once the report EXISTS (#1298).
       The decision names the row to write and the board write is what earns it:
       a write that threw, or that the board refused, leaves the row unreported,
       so the next check raises the same card again instead of the tick sitting
       on a memory of having told an operator who was never told. A write that
       succeeded — or replayed this outage's own receipt — is the telling. */
    if (carded && card.kind === "source-unreadable") {
      if (card.ref === seatTickSourceGapRef("pull-requests") && decision.reportedSourceGap) state = { ...state, pullRequestGap: decision.reportedSourceGap };
      if (card.ref === seatTickSourceGapRef("children") && decision.reportedChildrenGap) state = { ...state, childrenGap: decision.reportedChildrenGap };
    }
  }

  let delivery: SeatTickRunRecord["delivery"] = null;
  /* Why this check sent nothing, when what stopped it was a fence rather than
     a quiet board (#1746). A mute tick and a quiet one wrote the same line
     before this. */
  let fenceDetail: string | null = null;
  /* Why a wake this check DID dispatch reached nobody (#1771). A layer that
     refuses a send answers with its reason, and the controller used to throw
     that reason away: the journal line said "failed", the card said the
     attempt was unresolved, and nothing anywhere said what had refused it or
     why. A refusal an operator cannot read is a refusal nobody acts on. */
  let sendDetail: string | null = null;
  const verdict = decision.verdict;
  const terminalChildren = input.children.filter((child) => child.status === "terminal").map((child) => child.outcomeId ?? child.conversationId);

  if ((verdict.kind === "wake" || verdict.kind === "proactive") && input.seat) {
    const clientMessageId = wakeClientMessageId(input.project, input.seat.seatEpoch, verdict, {
      fingerprint: input.changeFingerprint,
      lastWakeAt: input.state.lastWakeAt,
      releasedWake: input.state.releasedWake ?? null,
      /* The same row the message below reads its prompt from, read once: the
         identity and the text have to move together or they are exactly the
         disagreement this key exists to prevent. */
      monitorPrompt: input.settings.monitorPrompt,
    });
    const text = verdict.kind === "wake"
      ? seatTickWakeMessage({
        project: input.project,
        reasons: verdict.reasons,
        items: verdict.items,
        deferred: verdict.deferred,
        /* Said once, as a count (#1749): the children this check declined to
           list because their outcomes are a retired seat's, not this one's. */
        staleChildren: verdict.staleChildren,
        signals: input.signals,
        /* What the check could not read travels with the wake it could still
           raise (#1298), so the seat acts on the rest knowing what is missing
           from it. */
        gaps: verdict.gaps,
        monitorPrompt: input.settings.monitorPrompt,
      })
      : seatTickProposalMessage({
        project: input.project,
        issues: await (dependencies.proposalIssues ?? defaultProposalIssues)(input.project, sources),
        signals: input.signals,
        items: policy.itemsPerWake,
        slot: String(Math.floor(input.now / policy.proposalIntervalMs)),
        monitorPrompt: input.settings.monitorPrompt,
      });

    /* The prompt above came off the settings row this check read, not out of
       anything the controller carries between checks or between seats: the row
       is the project's, so an instruction a seat left for its own monitor is
       still on the next check's wake, and still on the wake the successor gets
       after a rotation retires the seat that wrote it. (#1280)

       The seat epoch is re-read here, one step before the send, for the same
       reason the retirement sweep re-checks: a rotation that landed while this
       check was gathering must not have its predecessor woken. */
    const current = sources.seatFor(input.project).active;
    const rotated = !current
      || current.seatEpoch !== input.seat.seatEpoch
      || current.conversationId !== input.seat.conversationId;
    /* A prepared wake retains its original key and payload until settlement,
       including across prompt changes and seat rotation.

       What may withhold this project's next wake is one bounded fence, read
       here and by every surface that reports it (#1746): the outstanding
       attempt, or a retired one addressed to the conversation about to be
       woken — a seat re-designated BACK onto it makes the duplicate real again
       (#1594) — and in both cases only while the attempt is inside its age
       bound. Past the bound the opening reconcile has already retired it, and
       a fence nothing can ever settle is not a reason to leave a seat unwoken
       for a second day. */
    const fence = seatTickWakeFence(state, { conversationId: input.seat.conversationId }, input.now, input.settings.wakeIntervalMs);
    const withheld = fence !== null;
    /* The cursor then moves past everything this check READ, not only what
       the message listed: the terminal events are the ones carried, and the
       routine progress between them is what the seat is deliberately not
       told about one line at a time. Anything the page bound left behind
       keeps its place and is offered again. Terminal children are recorded
       only as far as the wake names them (#1465). */
    const commit = seatTickWakeCommitPlan(verdict, {
      fingerprint: input.changeFingerprint,
      eventsThrough: input.events.at(-1)?.seq ?? state.eventsThrough ?? 0,
      terminalChildren,
    });
    if (rotated) {
      delivery = { clientMessageId, outcome: "seat-rotated" };
    } else if (withheld) {
      delivery = { clientMessageId, outcome: "deferred-outstanding" };
      fenceDetail = seatTickFenceSentence(fence!);
    } else if (commit) {
      const wake = {
        clientMessageId, conversationId: input.seat.conversationId, seatEpoch: input.seat.seatEpoch,
        operationId: null, commit, text, preparedAt: at,
      };
      const accounting = state.accounting ? new SeatTickAccounting(state.accounting.filename, input.project) : null;
      /* One prepared attempt per project, whichever store holds the row. The
         accounting's own admission is the fence in production; a row with no
         accounting beside it answers the same question here, because an age
         bound that overwrote an attempt still in a holder's queue would put
         the second wake in flight that the bound was never meant to license
         (#1746). */
      const prepared = accounting ? accounting.prepare(state, wake) : !state.outstandingWake;
      if (!prepared) {
        /* A refusal moves no revision, so this check's own state — its gap run,
           its stall memory, its sealed cursor — is still the row's to write.
           Only a row another controller moved underneath is taken as it now
           stands. A prepare the accounting refused for want of a finished
           migration is named as such (#1465): the children gap beside it
           carries the same condition to the board, and the journal must not
           read as a wake merely waiting behind another. */
        const fresh = accounting ? accounting.readState() : state;
        if (fresh.accounting?.revision !== state.accounting?.revision) state = fresh;
        delivery = { clientMessageId, outcome: fresh.accounting?.gap ? "accounting-blocked" : "deferred-outstanding" };
        /* A prepare refused for want of an attempt slot is the fence too, and
           it is named the same way rather than left as a bare deferral: either
           another controller's attempt, arrived between this check's read and
           its write, or this row's own attempt, which the opening reconcile
           reached the age bound of and still declined to retire. */
        const raced = fresh.accounting?.gap
          ? null
          : seatTickReportedFence(fresh, { conversationId: input.seat.conversationId }, input.now, input.settings.wakeIntervalMs);
        if (raced) fenceDetail = seatTickFenceSentence(raced);
      } else {
        state = accounting ? accounting.readState() : { ...state, outstandingWake: wake };
        if (!accounting) writeState(input.project, state);
        // Preparation is durable before transport, and seat authority is re-read afterward.
        const authority = sources.seatFor(input.project).active;
        if (!authority || authority.seatEpoch !== wake.seatEpoch || authority.conversationId !== wake.conversationId) {
          delivery = { clientMessageId, outcome: "seat-rotated" };
          // This invocation has not entered transport, so non-delivery is proven.
          if (accounting) {
            accounting.cancelUndispatched(wake);
            state = accounting.readState();
          } else state = { ...state, outstandingWake: null };
        } else {
          const token = accounting?.beginDispatch(wake);
          if (accounting) state = accounting.readState();
          let outcome: DeliveryOutcome | null = null;
          try {
            if (accounting && !token) throw new Error("wake dispatch already claimed");
            outcome = await deliver({ pid: null, path: authority.path ?? input.seat.path ?? "", conversationId: authority.conversationId,
              clientMessageId, text, images: [], origin: { kind: "agent", role: "seat-tick" } });
            delivery = { clientMessageId, outcome: deliveryOutcomeLabel(outcome) };
            sendDetail = sendRefusalDetail(outcome);
          } catch (error) {
            delivery = { clientMessageId, outcome: "unreturned" };
            // Missing receipts do not authorize forgetting a prepared attempt.
            sendDetail = `the transport call for the wake did not return: ${redactBounded(error instanceof Error ? error.message : "unknown error", REASON_LIMIT)}`;
          }
          if (accounting && token && outcome) {
            accounting.returnedDispatch(clientMessageId, token, !outcome.ok && !outcome.operationId && outcome.actuation !== "started" && outcome.resend !== "verify-first");
            state = accounting.readState();
          }
          if (outcome && wakeReached(outcome)) {
            const landed = seatTickWakeCommit(state, commit, input.now);
            if (accounting) {
              accounting.settle(clientMessageId, landed, "landed");
              state = accounting.readState();
            } else state = landed;
          } else {
            if (outcome?.operationId && state.outstandingWake) {
              state = { ...state, outstandingWake: { ...state.outstandingWake, operationId: outcome.operationId } };
              if (accounting) { accounting.writeState(state); state = accounting.readState(); }
              else writeState(input.project, state);
            }
            /* The record is asked for what became of the send, whatever the
               transport answered: a refusal's shape proves nothing about which
               transport refused or what it had reserved first. No re-dispatch
               follows a send inside the same check; the next check's opening
               reconcile is where a same-key recovery may happen (#1465). */
            state = await reconcileOutstandingWake({ project: input.project, state,
              seat: sources.seatFor(input.project).active ?? null, sources, appendRecord, writeState, ensureCard, at, now: input.now,
              wakeIntervalMs: input.settings.wakeIntervalMs });
          }
        }
      }
    }
  }

  writeState(input.project, state);
  const record: SeatTickRunRecord = {
    schemaVersion: 1,
    at,
    project: input.project,
    seatEpoch: input.seat?.seatEpoch ?? null,
    verdict: verdict.kind,
    reasons: verdict.kind === "wake" ? verdict.reasons.map((reason) => reason.kind) : [],
    items: verdict.kind === "wake" ? verdict.items.length : 0,
    deferred: verdict.kind === "wake" ? verdict.deferred : 0,
    eventsThrough: state.eventsThrough ?? 0,
    delivery,
    detail: [rollbackDetail, verdictDetail(verdict), fenceDetail, sendDetail].filter((part): part is string => !!part).join("; ") || null,
  };
  appendRecord(record);
  return record;
}

/**
 * BOUND THE PROVISIONAL WINDOW WITH THE DRIVER THAT ALREADY EXISTS (#1757).
 *
 * A seat activated on a durably accepted spawn is provisional until the Viewer
 * can resolve its conversation. The routes reconcile that window whenever one
 * is called, and if nobody calls one the project keeps a seat nothing can read
 * — the board still showing its composer — for as long as that lasts. The
 * incident's operator waited a morning.
 *
 * This tick is the in-process clock the release that owns traffic already runs,
 * its project set is built from the active seats, and it comes round on its own
 * every few minutes. So the same reconciliation runs here, unchanged in
 * substance: readable outranks the receipt, only a terminally failed launch
 * rolls a seat back, and an unsettled launch is left exactly where it is.
 *
 * It RECONCILES ONLY. It starts nothing, sends nothing, and waits on no launch.
 * A reconciliation that throws is logged and the check goes on — a repair that
 * could not run must not cost the project its check.
 *
 * Imported lazily, for the reason {@link releaseOwnsTraffic} is: the seat
 * command's graph reaches the spawn route, and the tick has no business pulling
 * that into its static imports.
 */
async function reconcileProvisionalSeat(
  project: string,
  dependencies: SeatTickControllerDependencies,
): Promise<string | null> {
  try {
    const reconcile = dependencies.reconcileSeat ?? (async (target: string) => {
      const { reconcileActiveOrchestratorSeat } = await import("@/lib/orchestrator/seatCommand");
      return reconcileActiveOrchestratorSeat(target);
    });
    const rolledBack = await reconcile(project);
    if (!rolledBack) return null;
    const restored = rolledBack.restored;
    return `the seat this check opened on was stillborn and has been rolled back: ${redactMonitorText(rolledBack.terminalized.seat.intent.error ?? "no reason was recorded")}; ${restored?.conversationId
      ? `the project is designated on ${restored.conversationId} again at epoch ${restored.seatEpoch}`
      : "the project is left undesignated, which is what create_orchestrator answers"}`;
  } catch (error) {
    console.error("[seat tick] the active seat could not be reconciled", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

/** The project's wake interval as it stands, for the bound on an attempt
    (#1465): the settings row, expiry applied, and the default when the row
    cannot be read — the same interval the decision applies to every wake. */
function wakeIntervalFor(project: string, now: number, sources: SeatTickSources): number {
  try {
    return effectiveSeatTickSettings(sources.settings(project), now, SEAT_TICK_WAKE_INTERVAL_MS).wakeIntervalMs;
  } catch {
    return SEAT_TICK_WAKE_INTERVAL_MS;
  }
}

async function defaultProposalIssues(project: string, sources: SeatTickSources): Promise<ProposalIssue[]> {
  const cwd = repoDirForProject(project, sources);
  return cwd ? openIssuesForProposal({ cwd }) : [];
}

/**
 * Whether this release still owns viewer traffic.
 *
 * Imported lazily: the module that answers this is the Viewer's node-side
 * startup runtime, and pulling its dependency graph into the tick's static
 * imports would put node: builtins on a path that has no business carrying
 * them. An answer that cannot be read at all is read as "yes", the same way the
 * authority check itself treats a missing target — a tick that silently stopped
 * because an import hiccuped is a worse failure than the one being guarded.
 */
async function releaseOwnsTraffic(): Promise<boolean> {
  try {
    const { viewerReleaseOwnsTraffic } = await import("@/lib/viewerInstrumentation");
    return viewerReleaseOwnsTraffic();
  } catch (error) {
    console.error("[seat tick] traffic authority is unreadable", error instanceof Error ? error.name : "unknown");
    return true;
  }
}

/**
 * Every project the tick has an opinion about, checked once.
 *
 * The sweep opens by re-asking whether this release still owns traffic, and
 * that question is the duplicate refusal that survives process replacement. The
 * process-local flag behind {@link startSeatTick} cannot see a promoted
 * successor at all: a deploy leaves the predecessor running with its timer
 * armed, and both would sweep the same seats. The durable authority target is
 * the one fact both processes can read, so the replaced release refuses, says
 * so where the refusal outlives it, and stops its own clock — no lock, and no
 * second answer to "who owns this seat".
 *
 * After that, one project's failure never stops the others: this is a sweep,
 * not a transaction — and each project's own failure is a journal line of its
 * own, written by {@link runSeatTickCheck}.
 */
export async function reconcileSeatTick(dependencies: SeatTickControllerDependencies = {}): Promise<SeatTickRunRecord[]> {
  const sources = dependencies.sources ?? defaultSeatTickSources();
  const appendRecord = dependencies.appendRecord ?? appendSeatTickRecord;
  if (!await (dependencies.ownsTraffic ?? releaseOwnsTraffic)()) {
    const refusal = "this release no longer owns viewer traffic, so the seats belong to the promoted one";
    console.error(`[seat tick] refused: ${refusal}`);
    try {
      appendRecord({
        schemaVersion: 1,
        at: new Date().toISOString(),
        project: "",
        seatEpoch: null,
        verdict: "refused",
        reasons: [],
        items: 0,
        deferred: 0,
        eventsThrough: 0,
        delivery: null,
        detail: `the seat tick sweep was refused and this process's clock stopped: ${refusal}`,
      });
    } catch {
      /* The log line above already carries the refusal; an unwritable journal
         must not turn a refusal into a crash. */
    }
    stopSeatTick();
    return [];
  }
  const records: SeatTickRunRecord[] = [];
  for (const project of seatTickProjects(sources)) {
    try {
      const record = await runSeatTickCheck(project, { ...dependencies, sources });
      if (record) records.push(record);
    } catch (error) {
      /* Only an unwritable journal reaches here; the check itself records its
         own failures. */
      console.error("[seat tick] check could not be journaled", error instanceof Error ? error.name : "unknown");
    }
  }
  return records;
}

const tickHost = globalThis as typeof globalThis & {
  __llvSeatTickTimer?: ReturnType<typeof setInterval>;
  __llvSeatTickRunning?: boolean;
};

/**
 * Start the clock, or refuse out loud.
 *
 * The refusal is the requirement, not a nicety: two orchestrators ticking one
 * project is a defect to make visible, and a silent early return is how a
 * predecessor's schedule went on firing for hours next to its successor with
 * nothing anywhere saying so. So a second start is logged AND journaled — the
 * journal being the artifact that outlives both processes, which is the whole
 * reason it exists.
 *
 * This refusal only covers a second start inside one process. The one that
 * covers a second PROCESS is in {@link reconcileSeatTick}, which re-reads the
 * durable traffic authority every sweep — a deployment candidate never starts
 * controllers, and a release that has been promoted past stops sweeping the
 * moment it notices. There is deliberately no cross-process lock behind either:
 * a lock would be a second, weaker answer beside the authority both processes
 * already read.
 */
export function startSeatTick(ports: {
  scheduleInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  sweep?: () => Promise<unknown>;
  policy?: SeatTickPolicy | null;
  log?: (line: string) => void;
  appendRecord?: typeof appendSeatTickRecord;
} = {}): boolean {
  const log = ports.log ?? ((line: string) => console.error(line));
  if (tickHost.__llvSeatTickTimer) {
    const refusal = "this process already holds the seat tick — exactly one ticker per seat";
    log(`[seat tick] refused: ${refusal}`);
    try {
      (ports.appendRecord ?? appendSeatTickRecord)({
        schemaVersion: 1,
        at: new Date().toISOString(),
        project: "",
        seatEpoch: null,
        verdict: "refused",
        reasons: [],
        items: 0,
        deferred: 0,
        eventsThrough: 0,
        delivery: null,
        detail: `a second seat tick start was refused: ${refusal}`,
      });
    } catch {
      /* The log line above already carries the refusal; an unwritable journal
         must not turn a refusal into a crash. */
    }
    return false;
  }
  const policy = ports.policy === undefined ? seatTickPolicy() : ports.policy;
  if (!policy) {
    log("[seat tick] not started: LLV_SEAT_TICK_CHECK_MINUTES=0 turns the tick off");
    return false;
  }
  const schedule = ports.scheduleInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const sweep = ports.sweep ?? (() => reconcileSeatTick());
  const timer = schedule(() => {
    /* A check that outran its interval drops the next one rather than stacking
       it. A tick that would land behind the one before it is stale by
       construction, and staleness is the whole reason nothing is queued. */
    if (tickHost.__llvSeatTickRunning) return;
    tickHost.__llvSeatTickRunning = true;
    void Promise.resolve(sweep())
      .catch((error) => console.error("[seat tick] sweep failed", error instanceof Error ? error.name : "unknown"))
      .finally(() => { tickHost.__llvSeatTickRunning = false; });
  }, policy.checkIntervalMs);
  timer.unref?.();
  tickHost.__llvSeatTickTimer = timer;
  return true;
}

/** Test seam: the timer is process-global, so a suite must be able to start
    from an unstarted one without reaching into module internals. */
export function stopSeatTick(): void {
  const timer = tickHost.__llvSeatTickTimer;
  if (timer) clearInterval(timer);
  tickHost.__llvSeatTickTimer = undefined;
  tickHost.__llvSeatTickRunning = false;
}
