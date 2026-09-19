import { isTerminalHighSignalEvent } from "@/lib/lifecycle/vocabulary";

import { seatTickRetryGuardRef, seatTickSourceGapRef, ORCHESTRATOR_ALERT_REF, SEAT_TICK_SETTINGS_REF } from "./cards";
import { evidenceStallReason } from "./classify";
import type { EffectiveSeatTickSettings } from "./seatTickSettings";
import {
  SEAT_TICK_ANNOUNCED_LANES_LIMIT,
  SEAT_TICK_CHILDREN_SHOWN_LIMIT,
  SEAT_TICK_WAKE_REASON_KINDS,
  type SeatTickCard,
  type SeatTickCheckInput,
  type SeatTickChildInput,
  type SeatTickChildrenGap,
  type SeatTickDecision,
  type SeatTickEventInput,
  type SeatTickEvidenceGap,
  type SeatTickItem,
  type SeatTickOwnLaneInput,
  type SeatTickPipelineInput,
  type SeatTickPolicy,
  type SeatTickProjectState,
  type SeatTickPullRequestGap,
  type SeatTickSeatInput,
  type SeatTickSourceGap,
  type SeatTickTaskInput,
  type SeatTickVerdict,
  type SeatTickWakeCommit,
  type SeatTickWakeReason,
  type SeatTickWakeReasonKind,
} from "./types";

/**
 * The seat tick's pre-check (issue #1245) — a pure decision over durable state.
 *
 * The whole point of the tick is that the expensive half runs rarely. This is
 * the cheap half: no model call, no transcript scan, no network. It reads the
 * seat, the open lanes, the board, the lifecycle events past the seat's own
 * cursor and the Viewer's own signals, and answers one of five things.
 *
 * Five rules are load-bearing and easy to lose:
 *
 * - **A stale tick is dropped, never queued.** A seat whose turn is genuinely
 *   progressing is `skipped`, and a skipped check remembers nothing: the stall
 *   memory and the event cursor stay where they were so the next check decides
 *   on fresh evidence. The session-scheduled monitor this replaces queued its
 *   fires instead, and five of its seventy-six ticks were empty turns landing a
 *   fraction of a second behind the tick before them.
 * - **The skip terminates.** Only a verdict that says the turn is moving earns
 *   one. A turn the registry reports stalled or gone — and a turn the liveness
 *   plane cannot answer for at all — is not a turn the tick may wait behind
 *   forever, because the seat's own dead host is exactly the condition a wake
 *   exists to clear.
 * - **Every wake waits out the project's wake interval.** One hour by default,
 *   with no exception and no reason allowed to jump it: a terminal lane event
 *   is the FIRST thing the next wake carries, never a reason to raise one
 *   early. The bound is what the ADR's cost argument rests on — one resume per
 *   project per interval. What sets the interval is the project's own recorded
 *   settings (#1275, and the ADR amendment it carries): the seat governs its
 *   own tick, deliberately and with the reason on the record, and a project
 *   nobody configured runs on the default hour exactly as before.
 * - **Nothing here creates or wakes anything.** The decision names what is
 *   owed; the controller sends it, re-reads the seat epoch before it does, and
 *   only a delivered send advances a stamp. The one thing a check may settle on
 *   its own is the history in front of the cursor: an event nothing is owed on
 *   is discharged by the look that established that, never by a wake (#1285).
 * - **A wake names what is owed NOW, and silence means nothing is.** Both
 *   directions of that are here. An event about a lane that has itself finished
 *   is not an obligation, however far the cursor has fallen behind; a lane that
 *   finished and left its pull request unmerged IS one, however quiet the board
 *   otherwise looks (#1289). Where the two pull against each other the rarer,
 *   truer wake wins over the earlier one.
 * - **A failed evidence source degrades ITSELF and nothing else** (#1298). The
 *   rule above bought its truthfulness by refusing to conclude anything from a
 *   read that failed — and then refused to conclude anything at all, so a
 *   `gh` that could not authenticate withdrew a parked lane's wake as surely as
 *   it withdrew the pull request's. Twenty-three consecutive checks reported
 *   `error` while two lanes stood parked, which from the seat's side and the
 *   operator's is the silence the refusal exists to prevent. So the reasons
 *   that rest on the failed source are withheld, every other reason still wakes
 *   the seat, and the wake names the evidence it could not see. Only when
 *   nothing else stands is the check an `error` — quiet remains a conclusion
 *   nobody may draw from a read that failed.
 */

const MINUTE_MS = 60_000;

/**
 * The default bound, and the only one that is not a policy field.
 *
 * A project is woken at most once an hour while work is open. That is the
 * commitment in `docs/adr/0001-seat-tick-wake-resumes-a-dead-seat-host.md`,
 * and the whole cost argument for reversing #741's delivery rule rests on it:
 * a wake may resume a host the retirement sweep reclaimed, so "how often can
 * the two trade a host" is answered by this number.
 *
 * There is still no environment override, no exempt reason kind and no reset
 * when the seat rotates — the three ways the answer would silently become "it
 * depends". What #1275 added is the one deliberate way: a project's own
 * settings row, written by an explicit act with a reason on it and shown on
 * the board while it stands. A project nobody has configured is woken on this
 * number, and every project was, before anyone chose otherwise.
 */
export const SEAT_TICK_WAKE_INTERVAL_MS = 60 * MINUTE_MS;

export const DEFAULT_SEAT_TICK_POLICY: SeatTickPolicy = {
  checkIntervalMs: 5 * MINUTE_MS,
  stallAfterMs: 40 * MINUTE_MS,
  proposalIntervalMs: 24 * 60 * MINUTE_MS,
  itemsPerWake: 5,
  retryGuard: 2,
  backlogAfterMs: 3 * 24 * 60 * MINUTE_MS,
};

function positive(raw: string | undefined, fallback: number, scale: number): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? value * scale : fallback;
}

/**
 * The policy for this process: constants with env overrides, in the
 * `LLV_HOST_RETIREMENT_*` shape. There is deliberately no settings panel, no
 * cadence UI and no per-project opt-in — the requirement is that the tick works
 * from the start with no configuration by the operator.
 *
 * The wake interval is NOT among these. It is the bound the ADR commits to, so
 * it is {@link SEAT_TICK_WAKE_INTERVAL_MS} and nothing can set it.
 *
 * Null is the off switch, spelled the way retirement spells its own:
 * `LLV_SEAT_TICK_CHECK_MINUTES=0` means no checks at all.
 */
export function seatTickPolicy(env: Readonly<Record<string, string | undefined>> = process.env): SeatTickPolicy | null {
  const checkRaw = env.LLV_SEAT_TICK_CHECK_MINUTES?.trim();
  if (checkRaw && Number(checkRaw) === 0) return null;
  return {
    checkIntervalMs: positive(checkRaw, DEFAULT_SEAT_TICK_POLICY.checkIntervalMs, MINUTE_MS),
    stallAfterMs: positive(env.LLV_SEAT_TICK_STALL_MINUTES, DEFAULT_SEAT_TICK_POLICY.stallAfterMs, MINUTE_MS),
    proposalIntervalMs: positive(env.LLV_SEAT_TICK_PROPOSAL_HOURS, DEFAULT_SEAT_TICK_POLICY.proposalIntervalMs, 60 * MINUTE_MS),
    itemsPerWake: Math.floor(positive(env.LLV_SEAT_TICK_ITEMS, DEFAULT_SEAT_TICK_POLICY.itemsPerWake, 1)),
    retryGuard: Math.floor(positive(env.LLV_SEAT_TICK_RETRY_GUARD, DEFAULT_SEAT_TICK_POLICY.retryGuard, 1)),
    backlogAfterMs: positive(env.LLV_SEAT_TICK_BACKLOG_DAYS, DEFAULT_SEAT_TICK_POLICY.backlogAfterMs, 24 * 60 * MINUTE_MS),
  };
}

function isOpenLane(pipeline: SeatTickPipelineInput): boolean {
  return pipeline.state !== "terminal";
}

/** A standalone child with a live host behind it (#1465): open work, exactly
    as an open lane is. An unknown child is neither this nor terminal. */
function isRunningChild(child: SeatTickChildInput): boolean {
  return child.status === "running";
}

/** A child whose outcome is owed to the seat (#1465). The gather has already
    removed every child a delivered wake named, so each of these is unharvested. */
function isTerminalChild(child: SeatTickChildInput): boolean {
  return child.status === "terminal";
}

/** The stall memory's id for a child, kept apart from lane ids so a lane and
    a child can never share an entry. */
function childStallId(child: SeatTickChildInput): string {
  return `child:${child.conversationId}`;
}

/**
 * An assigned card nobody started — and only while that is a fact about NOW.
 *
 * "Assigned with no pipeline" accumulates. A board carrying historical status
 * notes parked in `assigned` months ago makes the condition permanently true,
 * so the reason fires on every interval for ever, carrying the same items, and
 * the first thing the tick teaches a seat is to ignore one of its own wake
 * reasons (#1262). The bound is the card's own movement: past
 * {@link SeatTickPolicy.backlogAfterMs} untouched it is backlog, not work
 * waiting to start.
 *
 * That is also what discharges it, without a second mechanism for silencing a
 * signal: the seat already moves, edits, blocks or closes a card, and any of
 * those makes it recent again — a card the seat judged not to be work drops
 * out on its own once nobody touches it.
 */
function isUnstarted(task: SeatTickTaskInput, now: number, backlogAfterMs: number): boolean {
  if (task.status !== "assigned" || task.owned) return false;
  const movedAt = task.updatedAt ? Date.parse(task.updatedAt) : Number.NaN;
  /* A card with no readable movement instant cannot be shown to be recent, and
     the whole failure being fixed here is a reason that can never stop being
     true, so the unprovable case is backlog. */
  return Number.isFinite(movedAt) && now - movedAt < backlogAfterMs;
}

/**
 * Work the seat could still carry: an open lane, a board card that is neither
 * blocked (a recorded stop) nor done, or a pull request a finished lane left
 * open.
 *
 * The third clause is #1289. Counting only lanes and cards made "the work
 * finished" and "the work finished and left three approved pull requests
 * unmerged" the same answer, and the tick said `quiet — nothing owed` to the
 * second one every five minutes for twelve hours. A finished lane's open pull
 * request is the obligation that finishing created, so it is open work.
 *
 * The fourth and fifth are #1465, the same blindness one layer down. A seat
 * that works through plain spawned children has no lane at all, so a running
 * worker was not open work and a finished one was not an obligation — the tick
 * answered `proactive` over a worker mid-task, and managers took to inventing
 * assigned heartbeat cards to be woken at all. A running child is open work
 * and an unharvested terminal child is the obligation finishing created.
 */
function hasOpenWork(input: SeatTickCheckInput): boolean {
  return input.pipelines.some(isOpenLane)
    || input.tasks.some((task) => task.status === "inbox" || task.status === "assigned")
    || input.pullRequests.length > 0
    || ownSettledLanes(input).length > 0
    /* Both child clauses ask the same question of the child as the item list
       does (#1749, #1783): a child no seat can read, or whose own clock is a
       predecessor's board, is not this seat's work whether it is still running
       or has already finished. Counting one kept a board with nothing left on
       it from ever being able to say so, and kept the interval agenda below
       naming children it had just refused to name. What being SHOWN a child
       costs is a repeated line, never the standing of the work, so that clause
       is the item list's alone. */
    || input.children.some((child) => isRunningChild(child) && isActionableChild(child, input.seat))
    || input.children.some((child) => isTerminalChild(child) && isActionableChild(child, input.seat));
}

/**
 * A pending event that is still a present obligation.
 *
 * Two filters, and the second is the one #1285 adds: the event has to be
 * terminal and high-signal (routine progress has never woken anyone on its
 * own), and the lane it names must not have reached a terminal state itself.
 * A `stage_completed` for a pipeline that closed yesterday is a fact about the
 * past — nothing is owed on it, and a wake that carries it spends a resumed
 * host and a paid turn establishing exactly that.
 */
function isOwedEvent(event: SeatTickEventInput): boolean {
  return isTerminalHighSignalEvent(event.type) && !event.pipelineTerminal;
}

/**
 * How far this check may move the cursor with no wake at all.
 *
 * The page is walked oldest-first and stops at the first event that is still
 * owed, so the seal covers exactly the history in front of it: routine progress
 * and terminal events whose lanes have finished. Null means the very first
 * pending event is owed and the cursor stays where it is.
 *
 * This is what stops a backlog from costing one resume per page. The bound that
 * makes a wake cheap — {@link SeatTickPolicy.itemsPerWake} items, once per
 * project per interval — turned into a ten-hour tail the moment the cursor fell
 * behind, because every page of history had to be carried to a seat before the
 * next one could be read. A page of history is discharged by one look instead,
 * and a check costs nothing.
 */
function dischargedThrough(events: readonly SeatTickEventInput[], cursor: number | null): number | null {
  let sealed = cursor;
  for (const event of events) {
    if (isOwedEvent(event)) break;
    /* A floor, never a subtraction: the cursor may only ever move forwards,
       whatever order a page reaches this. */
    sealed = Math.max(sealed ?? event.seq, event.seq);
  }
  return sealed;
}

/**
 * Whether the seat's turn is genuinely progressing, which is the only thing
 * that earns a dropped tick.
 *
 * The dead-host-over-an-open-turn case is why this is a positive test rather
 * than `turn === "busy"`. A seat whose host died mid-turn keeps a `busy` turn
 * on the registry forever, so a plain busy check skipped that seat at every
 * five-minute check for as long as the record stood — a permanent silence
 * produced by exactly the condition the wake exists to clear. Here the registry
 * decides: `running`, `waiting` under a turn the transcript still shows open (a
 * provider retry deadline) and `starting` (inside the launch grace, which
 * expires into `stalled` or `gone` on its own) are progress; everything else,
 * absent verdicts included, is not.
 */
export function seatTurnProgressing(seat: SeatTickSeatInput): boolean {
  if (seat.turn !== "busy") return false;
  const activity = seat.activity;
  if (!activity) return false;
  /* `waiting` covers two different seats. One is a turn held open by a provider
     retry deadline, which is progress. The other is `host_alive_turn_idle`: the
     transcript says the turn SETTLED and only the registry's record still calls
     it open — a seat sitting available, which the tick then skipped at every
     check for as long as the stale record stood (#1262). The evidence the
     verdict came from decides between them. */
  if (activity.lifecycle === "waiting") return activity.turnState === "busy";
  return activity.lifecycle === "running" || activity.lifecycle === "starting";
}

/**
 * The lanes that are not moving, and the clause that says so.
 *
 * Two sources, neither of them arithmetic over attempt timestamps. Parked is
 * the durable pipeline state, read through the monitor's one stall rule
 * (`evidenceStallReason`). Silence under an open turn is the registry's own
 * activity verdict for the conversation running the stage — the same answer
 * `agent_activity` gives, already reconciled with host death. Subtracting the
 * newest attempt instant from the clock would instead call a long-running stage
 * stalled while its host was writing to the transcript.
 */
function stalledLanes(input: SeatTickCheckInput): { pipeline: SeatTickPipelineInput; reason: string }[] {
  const options = { now: new Date(input.now), stallAfterMs: null };
  const found: { pipeline: SeatTickPipelineInput; reason: string }[] = [];
  for (const pipeline of input.pipelines) {
    if (!isOpenLane(pipeline)) continue;
    const parked = evidenceStallReason({ kind: "pipeline", id: pipeline.id, state: pipeline.state, updatedAt: pipeline.updatedAt }, options);
    if (parked) {
      found.push({ pipeline, reason: parked });
      continue;
    }
    const activity = pipeline.stageActivity;
    if (activity && (activity.lifecycle === "stalled" || activity.lifecycle === "gone")) {
      const stage = pipeline.stageId ? ` stage ${pipeline.stageId}` : "";
      found.push({
        pipeline,
        reason: `pipeline ${pipeline.id}${stage} runs a turn the registry reports ${activity.lifecycle} (${activity.reason})`,
      });
    }
  }
  return found;
}

/**
 * The children that are not moving (#1465), by the same two rules as the lanes
 * above and never by arithmetic over a launch instant.
 *
 * The liveness plane's verdict for the child's open turn is the first: a
 * `stalled` or `gone` verdict is the registry's own, already reconciled with
 * host death. The second is the registry's own evidence with no verdict to ask
 * for: a turn the registry records open with no host anywhere behind it. The
 * gather reports that as a `gone` verdict from the registry, so it reaches
 * here through the same clause. A long-running live turn the plane calls
 * `running` is never here, however long it has been open.
 */
function stalledChildren(input: SeatTickCheckInput): { child: SeatTickChildInput; reason: string }[] {
  const found: { child: SeatTickChildInput; reason: string }[] = [];
  for (const child of input.children) {
    if (!isRunningChild(child)) continue;
    const activity = child.activity;
    if (activity && (activity.lifecycle === "stalled" || activity.lifecycle === "gone")) {
      found.push({ child, reason: `child ${child.conversationId} runs a turn the registry reports ${activity.lifecycle} (${activity.reason})` });
    }
  }
  return found;
}

/**
 * Whether the Viewer can read this child's transcript at all (#1783).
 *
 * A child whose transcript is outside every scanner root, or gone from disk,
 * cannot be read by the seat and can never be harvested by anyone: the wake
 * that lists it asks for work no seat can do, and it asks again every hour for
 * ever, because nothing the seat does can discharge it. One of these reached a
 * single wake five times. It is skipped with its own reason in the summary,
 * which is the one thing that IS actionable about it — the transcript is
 * somewhere this Viewer does not scan.
 */
function isHarvestable(child: SeatTickChildInput): boolean {
  return child.transcript !== "unresolvable";
}

/**
 * The child's own clock: the instant IT last did something, and the only kind
 * of instant the age test may read (#1783).
 *
 * Two fields, in order, and nothing else. `terminalAt` is the registry's
 * record of when the child's turn ended, which exists only for a turn that
 * ended; `lastRecordAt` is the last record of its transcript, which a child
 * writes and nothing else does. Neither is `observedAt` or the
 * conversation's `updatedAt` — a rescan or a host-retirement sweep stamps
 * hundreds of rows with one of those, and reading them is what made the #1749
 * age test a no-op.
 *
 * In that order, and never the later of the two. A recorded terminal instant
 * is the registry's note of when this child's work ended, written once; the
 * file's last record is a fallback for the child that has no such note and
 * never will, and it is a file timestamp, which a copy or a mirror can move
 * without the child having done anything. Reading the later of them would put
 * a refreshable clock back in front of a fixed one, which is the shape of the
 * defect this test has now been wrong about twice. A child re-instructed since
 * it settled loses nothing by it: its turn is open again, so it HAS no
 * recorded terminal instant and its transcript is what speaks for it.
 */
function childOwnInstant(child: SeatTickChildInput): number {
  const terminalAt = child.terminalAt ? Date.parse(child.terminalAt) : Number.NaN;
  if (Number.isFinite(terminalAt)) return terminalAt;
  return child.lastRecordAt ? Date.parse(child.lastRecordAt) : Number.NaN;
}

/**
 * The state a landed wake records about a child line, so the next wake can
 * tell whether anything has moved since (#1783 round two).
 *
 * It is composed from what the line SHOWS. A harvest line shows the child's
 * latest owed outcome, and an outcome identity is one turn of one ledger
 * generation, so a child that ends another turn carries a different token and
 * is offered again — which is why the harvest's own acknowledgment is not
 * enough on its own here. A stall line shows a verdict about an open turn and
 * has nothing to acknowledge at all: a host that died over one leaves it open
 * for ever, so its token is the child's own last record, and the child is
 * offered again the moment it writes another one.
 *
 * The token carries no seat epoch, and does not need one: what a seat was shown
 * is that seat's, and `seatTickStateForEpoch` drops the whole record when a
 * check observes an epoch the row was not written under — alongside the stall
 * memory, so a successor re-observes a stall and reports it on its own second
 * check, as its predecessor did. Were the record instead read across a
 * rotation, this child would be the one it hurt: a dead host over an open turn
 * never writes another record, so its token never changes and a successor told
 * "unchanged" would never be told at all.
 */
function childStateToken(child: SeatTickChildInput, shows: string | null): string {
  const state = shows === null ? String(childOwnInstant(child)) : shows.slice(-32);
  return `${child.conversationId}@${state}`;
}

/** A day, the grace the designation clock is read with (#1749). */
const STALE_CHILD_GRACE_MS = 24 * 60 * MINUTE_MS;

/**
 * Whether a terminal child's outcome belongs to THIS seat's board (#1749).
 *
 * Two ways it does not, and each was in the evidence the issue was filed on.
 * The first is age: a wake to seat epoch 173 listed five children that finished
 * on the 4th and 5th of September, whose handoffs had been delivered to the
 * manager of that day and receipted. A terminal instant more than a day older
 * than the seat's own designation is a fact about a predecessor's board; this
 * seat cannot harvest it, and every wake that carried one spent five item slots
 * saying so.
 *
 * The second is the harvest itself. An outcome identity is a turn of a ledger
 * generation, so a child re-read from a fresh cursor mints a NEW owed outcome
 * for an outcome that was consumed weeks ago — which is how one child reached
 * the same wake twice, once as failed and once as finished. The stamp a landed
 * wake leaves on the child answers it: an earlier epoch harvested this
 * conversation, and nothing has happened to it since.
 *
 * What the age test READS is the third thing, and #1749 got it wrong (#1783):
 * `terminalAt` used to fall back to the instant the registry last observed the
 * turn, or last rewrote the conversation. Both are the registry's own clock,
 * and a rescan or a host-retirement sweep stamps hundreds of conversations
 * with one of them — 773 of them shared a single instant on the board this was
 * filed from — so the test compared the sweep's clock against the designation
 * and excluded nothing. The source now offers the child's own terminal instant
 * or the last record of its transcript, and nothing else.
 *
 * Both are narrow on purpose, and both are measured against the designation. A
 * child that went terminal after this seat was designated is owed however many
 * earlier outcomes a predecessor took — a worker re-instructed since the
 * rotation is exactly that case — and a seat with no readable designation
 * instant, or a child with no readable terminal instant, stales nothing at all.
 * The rule may cost a wake an item it should have carried in none of them.
 */
function isStaleChild(child: SeatTickChildInput, seat: SeatTickSeatInput): boolean {
  const instant = childOwnInstant(child);
  const designatedAt = seat.designatedAt ? Date.parse(seat.designatedAt) : Number.NaN;
  if (!Number.isFinite(instant) || !Number.isFinite(designatedAt)) return false;
  if (instant < designatedAt - STALE_CHILD_GRACE_MS) return true;
  /* The harvest narrows the same window rather than opening a second one. A
     child an earlier epoch already took needs no day of grace — the outcome was
     consumed before this seat existed — but an outcome recorded AFTER the
     designation is this seat's work whatever a predecessor took, which is what
     keeps a child re-instructed since the rotation owed. */
  return typeof child.harvestedEpoch === "number" && child.harvestedEpoch < seat.seatEpoch && instant < designatedAt;
}

/** Why a wake is not listing this child, or null when it is listing it. The
    order is the order the reasons are reported in, most fundamental first. */
type SeatTickChildSkip = "unreadable" | "stale" | "unchanged";

const SEAT_TICK_CHILD_SKIPS: readonly SeatTickChildSkip[] = ["unreadable", "stale", "unchanged"];

/** No wake has shown anything: what the two clauses about the CHILD are asked
    with, before the line that would show it exists. */
const EMPTY_SHOWN: ReadonlySet<string> = new Set<string>();

/** Children skipped for one reason, counted once each (#1783): the summary
    says how many CHILDREN it left out, never how many owed rows. */
function countSkipped(skipped: ReadonlyMap<string, SeatTickChildSkip>, reason: SeatTickChildSkip): number {
  let count = 0;
  for (const held of skipped.values()) if (held === reason) count += 1;
  return count;
}

/**
 * The one test both child paths apply (#1783 round two).
 *
 * Before this there were two, and each was missing what the other had. The
 * harvest tested the transcript and the age, and read the age off a field that
 * is null for every child whose host died over an open turn — which is how
 * three workers last written to on the 24th of August reached a wake to a seat
 * designated on the 18th of September. The stall path tested neither: a child
 * the registry reports `gone` under an open turn was listed whatever its age
 * and whether or not any seat could read a word of it, and two of those filled
 * the same wake. They are one list of children and one question about each of
 * them, so they are one test:
 *
 * - the Viewer can resolve its transcript, so a seat can read what it did;
 * - its own clock — its terminal instant, or the last record of its transcript
 *   when it has none — is no more than a day older than this seat's
 *   designation, and it is not an outcome an earlier epoch already took;
 * - and the state it would be shown in is not the state a landed wake has
 *   already shown this seat.
 *
 * A child with a readable transcript always has an instant, because the same
 * read produces both. A child with neither is one nothing can say anything
 * about, and it is reported unreadable rather than listed: the whole failure
 * being fixed here is a wake reason that can never stop being true.
 */
function childSkipReason(
  child: SeatTickChildInput,
  seat: SeatTickSeatInput,
  shows: string | null,
  shown: ReadonlySet<string>,
): SeatTickChildSkip | null {
  const fact = childFactsSkipReason(child, seat);
  if (fact) return fact;
  return shown.has(childStateToken(child, shows)) ? "unchanged" : null;
}

/**
 * The two clauses of that test that are facts about the CHILD, apart from the
 * one that is a fact about what this seat has been told (#1783 round two).
 *
 * They are apart because {@link hasOpenWork} needs exactly these two and must
 * not have the third. Whether a seat may be woken over a child is a question
 * about the child — can anything read it, and is its own clock this seat's
 * board or a predecessor's — and having been shown it an hour ago is no answer
 * to it. What being shown it governs is whether a wake REPEATS a line, which
 * is the item list's business and stays there.
 *
 * Both places had to take these, and only the item list did. A child the same
 * check had just declined to name still counted as open work, and still put
 * the interval agenda's clause about running children to true, so the hour
 * elapsing over two dead August workers raised a wake whose whole agenda was
 * the parenthetical saying they had been left out. That is the empty hourly
 * tick the interval clause exists to refuse, arriving under the reason that
 * says work is open.
 */
function childFactsSkipReason(child: SeatTickChildInput, seat: SeatTickSeatInput): SeatTickChildSkip | null {
  if (!isHarvestable(child)) return "unreadable";
  if (!Number.isFinite(childOwnInstant(child))) return "unreadable";
  if (isStaleChild(child, seat)) return "stale";
  return null;
}

/** A child a seat can act on: the two child-fact clauses above, asked where
    there may be no seat to ask them of. With no seat designated there is no
    designation to measure an age against and nothing to be stale relative to,
    so only the readable half is left. */
function isActionableChild(child: SeatTickChildInput, seat: SeatTickSeatInput | null): boolean {
  return seat ? childFactsSkipReason(child, seat) === null : isHarvestable(child);
}

/**
 * The seat's own settled lanes that are still standing (#1749).
 *
 * The backlog bound is the one {@link isUnstarted} applies to an assigned card,
 * and for the same reason: "the seat launched a lane and it completed" is true
 * for ever, so without a bound it is a wake reason nothing can discharge. Past
 * the bound the lane is history; inside it, closing, dismissing or moving the
 * lane is what discharges it, and each of those makes it recent again.
 */
function ownSettledLanes(input: SeatTickCheckInput): readonly SeatTickOwnLaneInput[] {
  return input.ownLanes.filter((lane) => {
    const movedAt = lane.updatedAt ? Date.parse(lane.updatedAt) : Number.NaN;
    return Number.isFinite(movedAt) && input.now - movedAt < input.policy.backlogAfterMs;
  });
}

function ownLaneLabel(lane: SeatTickOwnLaneInput): string {
  if (lane.settled === "provisioned") return `${lane.title} — lane you launched: provisioned, first stage running`;
  if (lane.settled === "provisioning-failed") {
    return `${lane.title} — lane you launched: provisioning failed, it never ran a stage: ${lane.detail || "no reason recorded"}`;
  }
  const settled = lane.settled === "completed"
    ? "completed, and nobody has closed it out"
    : lane.settled === "failed"
      ? "a stage failed"
      : "parked on a decision";
  return `${lane.title} — lane you launched: ${settled}`;
}

/**
 * One entry per child, in harvest order, carrying its latest state and every
 * owed outcome behind it (#1783).
 *
 * An outcome identity is one turn of one ledger generation, so a worker the
 * seat spawned once holds as many owed rows as it has ended turns. On the
 * board this was filed from, 209 owed rows stood for 67 children and one of
 * them held 63 of the rows; the agenda took them one row at a time, so a
 * single wake said the same child had finished and failed five times over and
 * held thirty-five items back behind it.
 *
 * The child keeps the place of its OLDEST owed outcome — the order the bound
 * cuts on is unchanged — and is described by its latest one, which is what the
 * seat has to act on. The outcomes behind it travel with the line so a landing
 * acknowledges all of them: a child the seat was shown and answered once is
 * not shown again until it ends another turn.
 */
interface SeatTickHarvestEntry {
  child: SeatTickChildInput;
  /** Every owed outcome this one line stands for, oldest first. */
  outcomeIds: readonly string[];
}

function collapseHarvest(owed: readonly SeatTickChildInput[]): SeatTickHarvestEntry[] {
  const order: string[] = [];
  const held = new Map<string, { child: SeatTickChildInput; outcomeIds: string[] }>();
  for (const child of owed) {
    const entry = held.get(child.conversationId);
    if (!entry) {
      order.push(child.conversationId);
      held.set(child.conversationId, { child, outcomeIds: child.outcomeId ? [child.outcomeId] : [] });
      continue;
    }
    /* Harvest order is oldest first, so the last row seen is the latest state. */
    entry.child = child;
    if (child.outcomeId) entry.outcomeIds.push(child.outcomeId);
  }
  return order.map((id) => held.get(id)!);
}

/** The terminal children in harvest order: the one that finished first is
    named first, so a bound that holds some back holds back the newest. */
function terminalChildren(input: SeatTickCheckInput): SeatTickChildInput[] {
  return input.children.filter(isTerminalChild).sort((left, right) => {
    const at = (child: SeatTickChildInput): number => {
      const parsed = child.terminalAt ? Date.parse(child.terminalAt) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    };
    return at(left) - at(right) || left.conversationId.localeCompare(right.conversationId);
  });
}

function elapsed(since: string | null, now: number, window: number): boolean {
  if (!since) return true;
  const at = Date.parse(since);
  return !Number.isFinite(at) || now - at >= window;
}

/**
 * The one gate every wake passes, exported so the gather can apply the SAME
 * clause rather than a second copy of it.
 *
 * It reads `lastWakeAt`, which the project keeps across a rotation, so an
 * incoming seat inherits the bound rather than a clean slate the predecessor's
 * wake is missing from — and the interval is the project's own (#1275), which
 * is the default hour until someone records something else.
 */
export function seatTickWakeDue(lastWakeAt: string | null, now: number, wakeIntervalMs: number): boolean {
  return elapsed(lastWakeAt, now, wakeIntervalMs);
}

/**
 * Whether an evidence source is failing rather than blipping (#1298).
 *
 * "Cannot be read at all" is a claim about a RUN of failures. `gh` refusing
 * once is a rate limit or a flaky network, and putting a card on the board for
 * that would teach the operator to ignore the card. A run that has
 * outlived a whole wake interval is the other thing — the credential is missing,
 * the command is not installed, the host config points nowhere — and that is
 * worth saying once, out loud.
 *
 * The project's own interval is the threshold rather than a number of checks,
 * because the check cadence is not what "how long has this been broken" means,
 * and because the same predicate then bounds the retry: past this point the
 * source is asked at the rate its answer could possibly change a wake, and no
 * faster.
 */
export function seatTickSourceGapStanding(gap: SeatTickSourceGap | null, now: number, wakeIntervalMs: number): boolean {
  if (!gap) return false;
  const since = Date.parse(gap.since);
  /* A run whose start cannot be read is not a run anything may be concluded
     from, so it is treated as freshly failing: it keeps the fast retry and
     raises no card. */
  return Number.isFinite(since) && now - since >= wakeIntervalMs;
}

/**
 * Whether the source is asked again on this check.
 *
 * Inside the first interval of a run, every check asks — a transient failure
 * must recover at the check interval, not an hour later. Once the run stands
 * (above), the subprocess is paid for at most once per wake interval: the
 * answer cannot raise a wake more often than that anyway, and a source that
 * has been dead all day should not cost one process per project every five
 * minutes for ever.
 *
 * Slowing the read can never slow a decision, because a check that does not
 * ask replays the gap it already knows about — see
 * {@link SeatTickCheckInput.pullRequestsUnavailable}. Every verdict in between
 * is the verdict a fresh failed read would have produced.
 */
export function seatTickSourceRetryDue(gap: SeatTickSourceGap | null, now: number, wakeIntervalMs: number): boolean {
  if (!gap || !seatTickSourceGapStanding(gap, now, wakeIntervalMs)) return true;
  const attempted = Date.parse(gap.lastAttemptAt);
  return !Number.isFinite(attempted) || now - attempted >= wakeIntervalMs;
}

/** The run of failures after one attempt failed: a new one, or the standing one
    advanced. `since` and `reported` belong to the RUN, so neither is reset by a
    later failure inside it — only an answer clears the row. */
export function seatTickSourceGapAfterFailure(
  gap: SeatTickSourceGap | null,
  kind: SeatTickPullRequestGap | SeatTickChildrenGap,
  at: string,
): SeatTickSourceGap {
  if (!gap) return { gap: kind, since: at, lastAttemptAt: at, attempts: 1, reported: false };
  return { ...gap, gap: kind, lastAttemptAt: at, attempts: gap.attempts + 1 };
}

/** The token the pull-request half carries when the source could not be read
    (#1298). Shared with the composer, so the two halves cannot drift apart. */
export const FINGERPRINT_UNREAD = "unread";

/**
 * Whether the board moved between two checks — the question the retry guard is
 * an answer to, and the one place a fingerprint is interpreted rather than
 * compared.
 *
 * Plain inequality answered it until one of the sources behind the digest
 * could go missing (#1298). An unreadable pull-request source contributes no
 * rows, which is byte-for-byte what a merged pull request contributes, so a
 * source failing every other check made the digest alternate between two
 * values and every wake looked like it had landed on a changed board. The
 * guard would never have reached its count, and the gap that is supposed to
 * cost nothing would have bought an unbounded wake for every reason on it.
 *
 * So the unreadable half says nothing instead of saying "empty": it can
 * neither invent movement nor claim stillness, and the answer rests on the
 * evidence both checks actually read. A digest from before this shape is
 * compared whole, which reads as one movement on the first check after it
 * changes and settles from there.
 */
export function seatTickBoardMoved(previous: string | null, current: string): boolean {
  if (previous === null) return true;
  const before = splitFingerprint(previous);
  const now = splitFingerprint(current);
  if (!before || !now) return previous !== current;
  if (before.board !== now.board) return true;
  /* The board part matched, so whatever moved has to have moved in the part one
     of these two checks could not read. Neither of them knows that it did. */
  if (before.pullRequests === FINGERPRINT_UNREAD || now.pullRequests === FINGERPRINT_UNREAD) return false;
  return before.pullRequests !== now.pullRequests;
}

function splitFingerprint(fingerprint: string): { board: string; pullRequests: string } | null {
  const cut = fingerprint.indexOf(".");
  if (cut <= 0 || cut === fingerprint.length - 1) return null;
  return { board: fingerprint.slice(0, cut), pullRequests: fingerprint.slice(cut + 1) };
}

/** The retry-guard count that applies right now: a board that moved since the
    last wake means nothing is being re-sent. */
function guardCount(state: SeatTickProjectState, kind: SeatTickWakeReasonKind, fingerprint: string): number {
  if (seatTickBoardMoved(state.lastWakeFingerprint, fingerprint)) return 0;
  return state.wakesWithoutChange[kind] ?? 0;
}

/**
 * The board card that says a project's tick is deliberately off or slowed
 * (#1275), or that it is back on the default.
 *
 * A tick that has gone quiet with nothing anywhere saying why is
 * indistinguishable from a tick that broke, and that is the worse failure of
 * the two. So while the settings depart from the default the board carries the
 * setting, its reason and who set it; when they are back at the default the
 * same card is resolved rather than left standing over a tick that is ticking.
 *
 * A project nobody has ever configured emits nothing at all — no card to raise
 * and none to resolve — so it costs exactly what it cost before this existed.
 */
function settingsCards(input: SeatTickCheckInput): SeatTickCard[] {
  const settings = input.settings;
  if (!settings.configured) return [];
  const context = { reason: settings.reason, until: settings.until, setBy: settings.setBy, updatedAt: settings.updatedAt };
  return [{
    ref: SEAT_TICK_SETTINGS_REF,
    kind: "tick-settings",
    state: settings.isDefault ? "resolved" : "open",
    settings: context,
    detail: seatTickSettingsCardDetail(settings),
  }];
}

/**
 * What a settings card says the SETTING is, in one clause.
 *
 * Exported because the operator's settings route shows the card text a change
 * would raise before the next check raises it (#1681), and a second copy of
 * this sentence is how the board and the control start wording one setting two
 * ways.
 */
export function seatTickSettingsCardDetail(
  settings: Pick<EffectiveSeatTickSettings, "enabled" | "wakeIntervalMs" | "isDefault" | "lapsed">,
): string {
  if (settings.isDefault) {
    return settings.lapsed
      ? "the recorded tick setting reached its expiry, so this project is back on the default wake interval"
      : "this project is on the default tick settings";
  }
  return settings.enabled
    ? `wakes for this project are set to one every ${Math.round(settings.wakeIntervalMs / MINUTE_MS)} minute(s)`
    : "ticking is off for this project: no wake will be sent until it is turned back on";
}

/**
 * What this check could not read, in the form the wake carries it (#1298).
 *
 * One entry per source, and today the pull-request read is the only source that
 * can fail without failing the whole check. The clause is written for the seat:
 * it says which evidence is missing and which obligation therefore cannot be
 * named, so a seat acting on the rest of the wake knows what is NOT in it.
 */
function evidenceGaps(input: SeatTickCheckInput): SeatTickEvidenceGap[] {
  const gaps: SeatTickEvidenceGap[] = [];
  const gap = input.pullRequestsUnavailable;
  if (gap) {
    gaps.push({
      source: "pull-requests",
      gap,
      detail: `the open pull requests of this project's finished lanes could not be read (${gap}), `
        + "so a pull request a finished lane left unmerged cannot be named in this wake",
    });
  }
  /* The second source that can fail without failing the whole check (#1465).
     Children the check could not account for are unknown children: not open
     work, not harvested, not quiet. The token says which condition stands. */
  if (input.childrenUnavailable) {
    gaps.push({
      source: "children",
      gap: input.childrenUnavailable,
      detail: `the seat's spawned children could not be read (${input.childrenUnavailable}): `
        + `${seatTickChildrenGapClause(input.childrenUnavailable)}, so a running or finished worker cannot be named in this wake`,
    });
  }
  return gaps;
}

/**
 * What each children-source condition means, in one clause a seat or an
 * operator can act on (#1465). Shared by the wake's gap line, the error
 * verdict and the standing card, so the three cannot describe one token three
 * ways.
 */
export function seatTickChildrenGapClause(gap: SeatTickChildrenGap): string {
  switch (gap) {
    case "registry-unreadable": return "the registry read failed";
    case "children-unindexed": return "the registry backend has no indexed lineage projection, so children cannot be paged";
    case "migration-pending": return "the SQLite accounting has not finished importing the legacy tick state";
    case "migration-blocked": return "the legacy tick state at state/seat-tick.json cannot be imported and blocks every wake until it is fixed or removed";
    case "discovery-incomplete": return "an owner's lineage page or the seat file's revocations could not be read to the end";
    case "ledger-gap": return "a child's event ledger was replaced, torn, malformed or skipped a sequence";
    case "ledger-pending": return "a child left its running state and its ledger has not been read yet";
    case "child-departed": return "a tracked child no longer projects under this seat and project";
    case "child-unplaced": return "a child has no conversation record or an unobserved turn with no host behind it";
  }
}

/**
 * The board card for a source that cannot be read at all, raised once per
 * outage (#1298).
 *
 * The journal already carried every failure, and the whole failure was that
 * nobody reads a journal: a `gh` that could not authenticate failed on every
 * check from the day the feature shipped, and the first person to notice was
 * the operator asking why the seat had been quiet for four hours. So a run of
 * failures that outlives the wake interval — long enough that this is
 * configuration rather than weather — is put where an operator looks.
 *
 * Once, and only once: {@link SeatTickSourceGap.reported} is the tick's own
 * memory of having said it, so closing the card does not summon it again five
 * minutes later. The row clears when the source answers, which is what makes
 * the next outage a new card rather than a silent one.
 *
 * The row it returns is what to remember AFTER the report exists, and it is
 * deliberately not folded into {@link SeatTickDecision.state}: `reported` is a
 * claim about the board, the board write can fail, and a decision that records
 * the claim anyway suppresses the one report this whole mechanism owes the
 * operator, permanently. The controller writes it once the card is there.
 *
 * `since` is the outage's own identity, which is why it travels on the card as
 * {@link SeatTickCard.instance}: every outage of this source shares one `ref`,
 * so the create receipt of the first card would replay for the second one and
 * put nothing on a board the first card has since been completed off.
 */
function sourceGapReport(
  input: SeatTickCheckInput,
  source: "pull-requests" | "children",
): { card: SeatTickCard; gap: SeatTickSourceGap } | null {
  const gap = source === "pull-requests" ? input.state.pullRequestGap : input.state.childrenGap;
  const unavailable = source === "pull-requests" ? input.pullRequestsUnavailable : input.childrenUnavailable;
  if (!unavailable || !gap || gap.reported) return null;
  if (!seatTickSourceGapStanding(gap, input.now, input.settings.wakeIntervalMs)) return null;
  const since = `${gap.since.slice(0, 16).replace("T", " ")} UTC (${gap.gap}, ${gap.attempts} attempt(s))`;
  return {
    card: {
      ref: seatTickSourceGapRef(source),
      kind: "source-unreadable",
      instance: gap.since,
      detail: source === "pull-requests"
        ? `The open pull requests of this project's finished lanes have not been readable since ${since}`
        /* The children card names the condition AND what it means (#1465):
           these tokens call for different hands — a blocked migration wants
           the legacy file looked at, a torn ledger wants nothing, a departed
           child wants the seat's spawn records checked. */
        : `The seat's spawned children have not been fully accountable since ${since}: `
          + seatTickChildrenGapClause(gap.gap as SeatTickChildrenGap),
    },
    gap: { ...gap, reported: true },
  };
}

/**
 * One check's decision, plus the standing tick-settings card.
 *
 * The card is composed here rather than inside each branch because it is not a
 * conclusion about the board at all: it is what the settings say, and it is
 * owed identically whether the check woke the seat, skipped it or found
 * nothing.
 */
export function seatTickDecision(input: SeatTickCheckInput): SeatTickDecision {
  const decision = decide(input);
  return { ...decision, cards: [...decision.cards, ...settingsCards(input)] };
}

function decide(input: SeatTickCheckInput): SeatTickDecision {
  const at = new Date(input.now).toISOString();
  const unchanged = { ...input.state, lastCheckAt: at };

  if (!input.seat) {
    return {
      verdict: { kind: "no-seat", detail: "the project has open work and no active orchestrator seat" },
      state: { ...unchanged, seatEpoch: null },
      cards: [{
        /* The same ref the conversation monitor raises this condition under, so
           the two mechanisms cannot double-card one missing orchestrator. */
        ref: ORCHESTRATOR_ALERT_REF,
        kind: "no-seat",
        detail: "No active orchestrator seat holds this project, so the tick has nothing to wake",
      }],
    };
  }

  /* A tick that landed after the current turn would be acting on evidence the
     turn has already superseded. Drop it: no delivery, no cursor advance, no
     stall memory, and the next check re-reads everything. */
  if (seatTurnProgressing(input.seat)) {
    return { verdict: { kind: "skipped", reason: "seat-busy" }, state: unchanged, cards: [] };
  }

  /* The seal (#1285) rides on every verdict from here down, a skipped check
     excepted — that one returns above and remembers nothing, deliberately. It
     is not a record of anything having been sent: it says this check looked at
     the history in front of the cursor and found nothing owed in it, which is
     a conclusion a quiet check is as entitled to as a wake. */
  const base: SeatTickProjectState = {
    ...unchanged,
    seatEpoch: input.seat.seatEpoch,
    eventsThrough: dischargedThrough(input.events, unchanged.eventsThrough),
  };
  const stalled = stalledLanes(input);
  const stalledKids = stalledChildren(input);
  /* The stall MEMORY records every stall this check saw, eligible or not: it
     answers "was this stalled at the previous check too", which is a fact
     about the child rather than about what a wake may carry. */
  const stalledNow = [...stalled.map((entry) => entry.pipeline.id), ...stalledKids.map((entry) => childStallId(entry.child))];
  const ownLanes = ownSettledLanes(input);
  /* The children both paths may list, each put through the one eligibility
     test (#1783 round two), and what fails it counted by reason and never
     named. The harvest is per owed outcome and then collapsed to one entry per
     child (#1783), so the two clauses about the CHILD are applied to the rows
     and the clause about what a wake already showed is applied to the line
     that stands for them. */
  const skipped = new Map<string, SeatTickChildSkip>();
  const skip = (child: SeatTickChildInput, reason: SeatTickChildSkip): void => {
    const held = skipped.get(child.conversationId);
    /* One reason per child, the most fundamental of them: a child whose
       transcript cannot be read is that, whatever else is also true of it. */
    if (!held || SEAT_TICK_CHILD_SKIPS.indexOf(reason) < SEAT_TICK_CHILD_SKIPS.indexOf(held)) {
      skipped.set(child.conversationId, reason);
    }
  };
  const settledChildren = terminalChildren(input);
  const owedRows = settledChildren.filter((child) => {
    const reason = childSkipReason(child, input.seat!, child.outcomeId ?? null, EMPTY_SHOWN);
    if (reason) skip(child, reason);
    return reason === null;
  });
  const shown = new Set(input.state.childrenShown ?? []);
  const harvest = collapseHarvest(owedRows).filter((entry) => {
    const reason = childSkipReason(entry.child, input.seat!, entry.child.outcomeId ?? null, shown);
    if (reason) skip(entry.child, reason);
    return reason === null;
  });
  const offeredChildStalls = stalledKids.filter((entry) => {
    const reason = childSkipReason(entry.child, input.seat!, null, shown);
    if (reason) skip(entry.child, reason);
    return reason === null;
  });
  /* The interval agenda's own list of running children is the same list one
     more time, so it takes the two clauses that are facts about the CHILD
     (#1783 round two). Without them a child the stall path just declined to
     name — its transcript unreadable, its last record weeks before the
     designation — walked straight back onto the agenda one line lower, as
     "spawned child running". The third clause is deliberately not applied
     here: what a seat was shown an hour ago is not a reason to stop saying
     which of its workers are open, and the interval wake carries these only
     when nothing sharper displaced them. */
  const runningChildren = input.children.filter(isRunningChild).filter((child) => {
    const reason = childSkipReason(child, input.seat!, null, EMPTY_SHOWN);
    if (reason) skip(child, reason);
    return reason === null;
  });
  /* A child one path declined and another listed is LISTED, and the summary
     counts what the wake left out. A worker whose host died over an open turn
     reaches both paths under two different states, so without this the same
     wake would name it and say it had held it back. */
  for (const child of [...harvest.map((entry) => entry.child), ...offeredChildStalls.map((entry) => entry.child), ...runningChildren]) {
    skipped.delete(child.conversationId);
  }
  const skippedChildren = {
    stale: countSkipped(skipped, "stale"),
    unreadable: countSkipped(skipped, "unreadable"),
    unchanged: countSkipped(skipped, "unchanged"),
  };
  /* A stall is only reported once it survived a second check, so a lane between
     two attempts is never called stuck. */
  const persistedStalls = stalled.filter((entry) => input.state.stalledSeen.includes(entry.pipeline.id));
  const persistedChildStalls = offeredChildStalls.filter((entry) => input.state.stalledSeen.includes(childStallId(entry.child)));
  const unknownChildren = input.children.filter((child) => child.status === "unknown").length;
  const unstarted = input.tasks.filter((task) => isUnstarted(task, input.now, input.policy.backlogAfterMs));
  const backlog = input.tasks.filter((task) => task.status === "assigned" && !task.owned).length - unstarted.length;
  const openWork = hasOpenWork(input);
  const wakeDue = seatTickWakeDue(input.state.lastWakeAt, input.now, input.settings.wakeIntervalMs);

  const observed: SeatTickProjectState = { ...base, stalledSeen: stalledNow };

  /* Ticking is off for this project, so no wake and no proposal — and the
     check still runs, still reads the board and still writes its journal line.
     That is the difference the operator has to be able to see: a tick that is
     off keeps saying so every check, while a tick that broke says nothing at
     all. The stall memory above is kept fresh for the same reason: when the
     tick is turned back on it decides from what it has been watching rather
     than from a blank row. */
  if (!input.settings.enabled) {
    return {
      verdict: {
        kind: "quiet",
        detail: input.settings.reason
          ? `ticking is off for this project: ${input.settings.reason}`
          : "ticking is off for this project",
      },
      state: quiet(observed, at),
      cards: [],
    };
  }

  const laneEvents = input.events.filter(isOwedEvent);
  const candidates: SeatTickWakeReason[] = [];
  if (wakeDue) {
    /* A verdict the seat cannot decide without leads the wake — and waits for
       the wake like everything else. Routine progress never wakes on its own,
       and neither does an event whose lane has finished.

       The count beside it is what the seat reads as "how much is there", so it
       counts what is owed and nothing else (#1285): "and 18 more" over a page
       that was almost entirely closed lanes described a queue that did not
       exist. A live event further down the journal than this check reads is
       NOT announced here; the pages of history in front of it are sealed away
       by the check itself at no cost, and the check that reaches it names it.
       A wake that says only "something is waiting further down" is the empty
       agenda this whole mechanism exists to stop sending. */
    /* First, and ahead of the lane events, because it is the seat's own work
       (#1749): a lane it launched that settled and is standing there is the
       obligation the tick was blind to for the whole of the evidence in that
       issue, while five slots went to children of seats two weeks retired. */
    if (ownLanes.length > 0) {
      const first = ownLanes[0]!;
      const more = ownLanes.length > 1 ? ` and ${ownLanes.length - 1} more` : "";
      candidates.push({ kind: "own-lane-settled", detail: `a lane you launched is ${first.settled}${more}` });
    }
    if (laneEvents.length > 0) {
      const first = laneEvents[0]!;
      const more = laneEvents.length > 1 ? ` and ${laneEvents.length - 1} more` : "";
      candidates.push({ kind: "lane-event", detail: `${first.type} since the last delivered wake${more}` });
    }
    /* A finished standalone child (#1465), the lane event's counterpart for a
       seat with no lanes: "your worker finished, go harvest it", once. Once,
       because the cursor that discharges it is written by a DELIVERED wake and
       the gather removes what the cursor names; a wake that never landed leaves
       the child here for the next check. Same interval, same guard. */
    if (harvest.length > 0) {
      const first = harvest[0]!;
      const more = harvest.length > 1 ? ` and ${harvest.length - 1} more` : "";
      candidates.push({ kind: "child-terminal", detail: `a spawned child ${first.child.outcome ?? "finished"} and its outcome is unharvested${more}` });
    }
    /* The mirror image (#1289), and it is a wake reason rather than a silence
       for one reason: a lane that finished with its pull request unmerged is
       the seat's next obligation, and the tick could not see one. It takes no
       shortcut around the bound — same interval above, same retry guard below —
       and it clears itself when the pull request merges or closes.

       This is the ONE reason a pull-request gap withholds, and it withholds it
       by having nothing to name: an unreadable source carries no rows, so the
       clause below is simply false (#1298). Every other candidate is composed
       from evidence this check did read. */
    if (input.pullRequests.length > 0) {
      const first = input.pullRequests[0]!;
      const more = input.pullRequests.length > 1 ? ` and ${input.pullRequests.length - 1} more` : "";
      candidates.push({
        kind: "unmerged-pr",
        detail: `pull request #${first.number}${more} left open by a lane that finished`,
      });
    }
    if (persistedStalls.length > 0 || persistedChildStalls.length > 0) {
      candidates.push({ kind: "stalled", detail: (persistedStalls[0] ?? persistedChildStalls[0])!.reason });
    }
    if (unstarted.length > 0) {
      /* The excluded count travels with the reason so a seat reading "2" beside
         a board showing twenty-nine assigned cards can see why, rather than
         concluding the tick cannot count. */
      const held = backlog > 0 ? `, and ${backlog} older than the backlog bound the wake no longer names` : "";
      candidates.push({ kind: "unstarted-task", detail: `${unstarted.length} assigned board task(s) nothing has started${held}` });
    }
    /* The interval is a floor on wakes, never a licence to speak with nothing
       to say. Reaching here with no candidate means no lane event, no persisted
       stall and no unstarted task, so an interval wake would carry exactly the
       open lanes and the signals. A board whose only open work is an inbox card
       — open work, but work the seat is told not to touch, because the
       operator's move to assigned is what starts it — leaves that agenda empty,
       and an hourly wake with an empty agenda is the burnt-quota tick this
       replaces. */
    /* The running children here are the ones the agenda could actually NAME —
       the filtered list composed above, not the raw one. An agenda whose only
       entry is a child the same check has already declined to name carries
       nothing, and a wake carrying nothing is what this clause refuses. */
    const intervalAgenda = input.pipelines.some(isOpenLane) || runningChildren.length > 0 || input.signals.length > 0;
    if (openWork && intervalAgenda && candidates.length === 0) {
      candidates.push({ kind: "interval", detail: "the wake interval elapsed while work is open" });
    }
  }

  const cards: SeatTickCard[] = [];
  const reasons: SeatTickWakeReason[] = [];
  let guardHeld = 0;
  for (const reason of candidates) {
    if (guardCount(input.state, reason.kind, input.changeFingerprint) >= input.policy.retryGuard) {
      guardHeld += 1;
      cards.push({
        ref: seatTickRetryGuardRef(reason.kind),
        kind: "retry-guard",
        detail: `Wakes for "${reason.kind}" stopped producing any board or pipeline change; the tick has stopped re-sending it until state moves`,
      });
      continue;
    }
    reasons.push(reason);
  }

  /* What this check could not read, said once on the board and on every wake
     that goes out while it stands (#1298). The card is the "once": a source
     that has been failing since before the wake interval is not a blip, and
     twenty-three journal lines nobody was reading is what the operator got
     instead of being told. */
  const gaps = evidenceGaps(input);
  const gapReport = sourceGapReport(input, "pull-requests");
  if (gapReport) cards.push(gapReport.card);
  const childrenReport = sourceGapReport(input, "children");
  if (childrenReport) cards.push(childrenReport.card);
  /* The row this check writes says the outage is UNREPORTED, and it says so
     even while the card for it is being raised. Marking it reported here is a
     claim about a board write that has not happened yet and that the controller
     catches when it fails — after which the tick remembers having told the
     operator something nobody was ever told, and the report is suppressed for
     the rest of the outage. So the reported row leaves separately and the
     controller writes it once the card is confirmed on the board. */
  const state = observed;
  const reportedSourceGap = gapReport?.gap ?? null;
  const reportedChildrenGap = childrenReport?.gap ?? null;

  /* The wake goes FIRST, and it goes out while a source is unreadable (#1298).
     Every reason it carries was decided from evidence this check did read, and
     the gaps beside them say what it could not — so the hour a delivered wake
     buys is bought by a wake that named real work and named its own blind
     spot. The trade the previous shape refused was a different one: a wake
     with nothing but the failed read behind it. That one is still refused,
     because the reason resting on the failed source is never composed at all.

     The guard and the interval are untouched by any of it: the reasons here
     passed both, and a gap adds none. */
  if (reasons.length > 0) {
    const all = wakeItems({ input, ownLanes, stalled: persistedStalls, stalledChildren: persistedChildStalls, harvest, runningChildren, laneEvents, unstarted });
    return {
      verdict: {
        kind: "wake",
        reasons,
        items: all.slice(0, input.policy.itemsPerWake),
        deferred: Math.max(0, all.length - input.policy.itemsPerWake),
        skippedChildren,
        gaps,
      },
      state,
      cards,
      reportedSourceGap,
      reportedChildrenGap,
    };
  }

  /* Nothing else was owed, so the unreadable source is the whole story — and
     quiet is a conclusion this check cannot draw. It ends as an error that
     costs nothing: no delivery, no wake stamp, no retry-guard count, no claim
     of quiet in the row. The hourly bound belongs to wakes that were actually
     sent, and a failed read still cannot spend it. It stays ahead of every
     verdict below, each of which says nothing is owed. */
  if (gaps.length > 0) {
    const first = gaps[0]!;
    const subject = first.source === "children"
      ? "the seat's spawned children"
      : "the open pull requests of this project's finished lanes";
    const clause = first.source === "children" ? `: ${seatTickChildrenGapClause(first.gap as SeatTickChildrenGap)}` : "";
    return {
      verdict: {
        kind: "error",
        detail: `${subject} could not be read (${first.gap})${clause}, so nothing owed is not established`,
      },
      state,
      cards,
      reportedSourceGap,
      reportedChildrenGap,
    };
  }

  /* Nothing left to wake on, and every outcome below this line is a statement
     that nothing is owed — each of them resting on evidence the check above
     has already shown it could read. */
  if (guardHeld > 0) {
    return { verdict: { kind: "quiet", detail: "every wake reason is held by the retry guard" }, state: quiet(state, at), cards };
  }

  /* A child the registry cannot place is named in the line and nowhere else
     (#1465): it is not owed, and it is not settled either. */
  const unplaced = unknownChildren > 0 ? `; ${unknownChildren} spawned child(ren) in an unknown state` : "";

  if (!openWork) {
    const idle = { ...quiet(state, at), idleSince: input.state.idleSince ?? at };
    /* The proposal is a wake too — it resumes a host and spends a turn — so it
       waits out the same hour on top of its own 24-hour slot. */
    if (wakeDue && elapsed(input.state.lastProposalAt, input.now, input.policy.proposalIntervalMs)) {
      return {
        verdict: { kind: "proactive", detail: `no open lane, no unblocked task, and the proposal slot is due${unplaced}` },
        state: idle,
        cards: [],
      };
    }
    return { verdict: { kind: "quiet", detail: `the board is done and the proposal slot is not due${unplaced}` }, state: idle, cards: [] };
  }

  return { verdict: { kind: "quiet", detail: `nothing owed${unplaced}` }, state: { ...quiet(state, at), idleSince: null }, cards: [] };
}

function quiet(state: SeatTickProjectState, at: string): SeatTickProjectState {
  return { ...state, quietSince: state.quietSince ?? at };
}

/**
 * The agenda, in the order the per-wake bound cuts it (#1749).
 *
 * The bound is five, and the order is therefore the whole of what a seat is
 * told. It used to run lane events, then every unharvested child, then the
 * pull requests and the parked lanes — so a seat holding forty historical
 * children got five of those and nothing else, check after check, while its own
 * completed lane sat on an approved pull request nobody merged and a second
 * lane stood parked on a decision.
 *
 * So the seat's OWN settled work goes first: the lanes it launched that
 * settled, then the pull requests their finishing left open. Both are bounded
 * by what the seat itself started, both are things only this seat can close
 * out, and putting them at the head is what makes "always fits in the item
 * window" true without a second budget — the slice below takes the head.
 */
function wakeItems(context: {
  input: SeatTickCheckInput;
  ownLanes: readonly SeatTickOwnLaneInput[];
  stalled: { pipeline: SeatTickPipelineInput; reason: string }[];
  stalledChildren: { child: SeatTickChildInput; reason: string }[];
  /** One entry per terminal child, in harvest order, oldest outcome first. */
  harvest: readonly SeatTickHarvestEntry[];
  /** The running children the interval agenda may name (#1783 round two):
      every one of them readable and no older than this seat. */
  runningChildren: readonly SeatTickChildInput[];
  laneEvents: readonly SeatTickEventInput[];
  unstarted: SeatTickTaskInput[];
}): SeatTickItem[] {
  const { input } = context;
  const items: SeatTickItem[] = [];
  /* Named, not merely counted (#1289). The twelve hours were spent because the
     seat had no way to know a pull request was waiting; a wake that says one is
     and leaves the seat to rediscover which would have cost most of the same
     turn. The lane that produced it travels with it for the same reason. */
  for (const pullRequest of input.pullRequests) {
    items.push({
      kind: "pull-request",
      id: `#${pullRequest.number}`,
      label: `${pullRequest.title} — open pull request from ${pullRequest.pipelineTitle}, unmerged since that lane finished`,
    });
  }
  /* A lane whose open pull request is already on the agenda is that pull
     request: the item above names the lane it came from and says what to do
     with it, and spending a second of five slots to say the lane it names
     completed is how an agenda of five carries three facts. */
  const pulled = new Set(input.pullRequests.map((pullRequest) => pullRequest.pipelineId));
  for (const lane of context.ownLanes) {
    if (pulled.has(lane.id)) continue;
    /* The provisioned lane is the create call's own answer arriving late
       (#1799), so it says so in the line's kind. Nothing else about it is
       special: it rides the same reason, the same agenda order and the same
       per-wake bound as every other own-lane line, and the bound cutting it is
       what leaves it unannounced and offerable next time. */
    items.push({ kind: lane.settled === "provisioned" ? "provisioning" : "pipeline", id: lane.id, label: ownLaneLabel(lane) });
  }
  for (const event of context.laneEvents) {
    items.push({ kind: "event", id: event.pipelineId ?? event.type, label: `${event.type}: ${event.summary}` });
  }
  /* Oldest outcome first (#1465), so the per-wake bound holds back the newest
     and the child that has waited longest is harvested first. Only the items
     that fit are recorded as harvested when the wake lands; the rest stay owed. */
  for (const entry of context.harvest) {
    /* One line per child, with its latest state and every owed outcome behind
       it (#1783). */
    items.push({
      kind: "child",
      id: entry.child.conversationId,
      outcomeId: entry.child.outcomeId,
      outcomeIds: entry.outcomeIds,
      stateTokens: [childStateToken(entry.child, entry.child.outcomeId ?? null), childStateToken(entry.child, null)],
      label: `${entry.child.title} — spawned child ${entry.child.outcome ?? "finished"}, outcome unharvested`,
    });
  }
  /* A lane parked on a decision is open, so it can be BOTH the seat's own
     settled work and a persisted stall. It is one lane and one obligation, and
     the item at the head already says what stopped it. */
  const owned = new Set(context.ownLanes.map((lane) => lane.id));
  for (const entry of context.stalled) {
    if (owned.has(entry.pipeline.id)) continue;
    items.push({ kind: "pipeline", id: entry.pipeline.id, label: `${entry.pipeline.title} — ${entry.reason}` });
  }
  /* One line per child here too (#1783 round two). A child whose host died
     over an open turn can hold owed outcomes AND be reported stalled — the
     harvest reads its ledger, the liveness plane reads its turn — and the
     harvest line above already names it and says what to do with it. */
  for (const entry of context.stalledChildren) {
    if (items.some((item) => item.kind === "child" && item.id === entry.child.conversationId)) continue;
    items.push({
      kind: "child",
      id: entry.child.conversationId,
      stateTokens: [childStateToken(entry.child, null)],
      label: `${entry.child.title} — ${entry.reason}`,
    });
  }
  for (const task of context.unstarted) {
    items.push({ kind: "task", id: task.id, label: `${task.title} — assigned, nothing started it` });
  }
  /* On an interval wake the open lanes are the agenda; they carry no reason of
     their own, so they come last and only when nothing sharper displaced them. */
  for (const pipeline of input.pipelines) {
    if (!isOpenLane(pipeline)) continue;
    if (items.some((item) => item.id === pipeline.id)) continue;
    items.push({ kind: "pipeline", id: pipeline.id, label: `${pipeline.title} — open` });
  }
  for (const child of context.runningChildren) {
    if (items.some((item) => item.id === child.conversationId)) continue;
    items.push({ kind: "child", id: child.outcomeId ?? child.conversationId, label: `${child.title} — spawned child running` });
  }
  for (const signal of input.signals) {
    items.push({ kind: "signal", id: signal.id, label: signal.label });
  }
  return items;
}

/**
 * Everything a wake will change if — and only if — it lands.
 *
 * Separated from the commit itself because the two can happen in different
 * checks. A send the delivery layer accepted but kept lands later, at the
 * holder's pace, and the check that observes the landing has its own decision
 * about its own board. Committing that check's fingerprint and cursor for a
 * message raised minutes earlier would credit the seat with the wrong wake, so
 * the raising check writes the plan down and the landing applies it verbatim.
 */
export function seatTickWakeCommitPlan(
  verdict: SeatTickVerdict,
  context: {
    fingerprint: string;
    eventsThrough: number;
    /** The terminal children the check saw (#1465). Only those the wake
        actually names — inside the per-wake bound — are recorded as harvested
        by its landing; a child the bound held back stays owed. */
    terminalChildren?: readonly string[];
  },
): SeatTickWakeCommit | null {
  const { fingerprint, eventsThrough } = context;
  if (verdict.kind === "proactive") return { proposal: true, reasons: [], fingerprint, eventsThrough, children: [], announcedLanes: [], shownChildren: [] };
  if (verdict.kind !== "wake") return null;
  const terminal = new Set(context.terminalChildren ?? []);
  /* What each child line SHOWS, for the clause that asks whether anything has
     moved since (#1783 round two). It is recorded by the landing and by
     nothing else: a wake the layer never delivered showed the seat nothing. */
  const shownChildren = [...new Set(verdict.items.flatMap((item) => item.stateTokens ?? []))];
  /* Every outcome the line stood for, not just the one that described it
     (#1783): a child the wake showed once with its latest state was shown all
     of what it was owed on, so a landing acknowledges all of it. Leaving the
     rest owed is what put the same child on the next wake unchanged. */
  const children = verdict.items
    .filter((item) => item.kind === "child")
    .flatMap((item) => (item.outcomeIds?.length ? item.outcomeIds : [item.outcomeId ?? item.id]))
    .filter((id) => terminal.has(id));
  /* Read off the items the wake actually CARRIES, never off the check's own
     list (#1799): a provisioned lane the per-wake bound held back was not
     announced, and recording it here would be the announcement nobody ever
     received. Same rule the harvested children live under. */
  const announcedLanes = verdict.items.filter((item) => item.kind === "provisioning").map((item) => item.id);
  return { proposal: false, reasons: verdict.reasons.map((reason) => reason.kind), fingerprint, eventsThrough, children, announcedLanes, shownChildren };
}

/**
 * The half of the state transition that only a LANDED wake earns.
 *
 * Kept apart from {@link seatTickDecision} on purpose, and it is the reason the
 * two halves exist at all. A wake whose seat epoch moved between the decision
 * and the send is refused at the send; a wake the delivery layer held or queued
 * is somewhere other than the seat, and stays that way until the layer holding
 * it says otherwise. Neither may leave a record saying the seat was woken, and
 * neither may advance the event cursor — an acknowledged event is never offered
 * again, so acking one before it landed is how a rotation loses the lane event
 * its successor needed.
 *
 * Landing is also what settles the outstanding wake: a message the seat has is
 * no longer a payload waiting somewhere for a seat that may be replaced before
 * it arrives.
 */
export function seatTickWakeCommit(
  state: SeatTickProjectState,
  commit: SeatTickWakeCommit,
  now: number,
): SeatTickProjectState {
  const at = new Date(now).toISOString();
  const eventsThrough = Math.max(state.eventsThrough ?? 0, commit.eventsThrough);
  if (commit.proposal) {
    return {
      ...state,
      lastWakeAt: at,
      lastProposalAt: at,
      lastWakeReasons: [],
      lastWakeFingerprint: commit.fingerprint,
      quietSince: null,
      eventsThrough,
      outstandingWake: null,
      releasedWake: null,
    };
  }

  const carried = commit.reasons;
  /* A wake that changed nothing, counted the same way the guard reads it — an
     hour whose pull-request half was unreadable is an hour that showed no
     movement, so it accrues rather than resetting (#1298). A blind source
     cannot postpone the guard any more than it can walk around it. */
  const fruitless = !seatTickBoardMoved(state.lastWakeFingerprint, commit.fingerprint);
  const wakesWithoutChange: Partial<Record<SeatTickWakeReasonKind, number>> = {};
  for (const kind of SEAT_TICK_WAKE_REASON_KINDS) {
    if (!carried.includes(kind)) continue;
    wakesWithoutChange[kind] = fruitless ? (state.wakesWithoutChange[kind] ?? 0) + 1 : 0;
  }
  return {
    ...state,
    lastWakeAt: at,
    lastWakeReasons: carried,
    lastWakeFingerprint: commit.fingerprint,
    wakesWithoutChange,
    quietSince: null,
    idleSince: null,
    eventsThrough,
    outstandingWake: null,
    /* The landing moves the stamp, which is a new identity for every later
       wake on its own; the marker has done its work (#1672). */
    releasedWake: null,
    harvestedChildren: harvested(state.harvestedChildren, commit.children),
    childrenShown: childrenShown(state.childrenShown ?? [], commit.shownChildren ?? []),
    announcedLanes: announcedLanes(state.announcedLanes ?? [], commit.announcedLanes ?? []),
  };
}

/** The lanes announced after a landing (#1799), newest last and bounded. */
function announcedLanes(before: readonly string[], announced: readonly string[]): string[] {
  return [...new Set([...before.filter((id) => !announced.includes(id)), ...announced])]
    .slice(-SEAT_TICK_ANNOUNCED_LANES_LIMIT);
}

/** The harvest cursor after a landing (#1465): the children this wake named,
    appended once each. Durable outcome rows retain acknowledgment history. */
function harvested(before: readonly string[], named: readonly string[]): string[] {
  const merged = [...before.filter((id) => !named.includes(id)), ...named];
  return [...new Set(merged)];
}

/**
 * What the seat has been shown, after a landing (#1783 round two).
 *
 * The tokens this wake carried for a child replace whatever an earlier wake
 * recorded about that child — it has one current state, whichever heading it
 * was shown under — newest last, bounded. The bound is what keeps a project's
 * row from growing with every worker it has ever spawned; past it the oldest
 * child may be offered once more, which is a repeated line rather than a lost
 * obligation.
 */
function childrenShown(before: readonly string[], shown: readonly string[]): string[] {
  const conversation = (token: string) => token.slice(0, token.lastIndexOf("@"));
  const replaced = new Set(shown.map(conversation));
  const merged = [...before.filter((token) => !replaced.has(conversation(token))), ...shown];
  return merged.slice(-SEAT_TICK_CHILDREN_SHOWN_LIMIT);
}
