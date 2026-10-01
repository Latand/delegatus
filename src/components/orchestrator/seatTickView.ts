import type { BoardMaintenanceAnswer } from "@/lib/boardMaintenance/answer";
import type { MaintenanceFailureKind } from "@/lib/boardMaintenance/types";
import type { MessageKey, TFunction } from "@/lib/i18n";
import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";
import type { SeatTickWakeReasonKind } from "@/lib/monitor/types";

/*
 * What the seat tick control SAYS, as a pure function of the settings answer
 * (#1681). Shared unchanged by the desktop chip and popover and by the phone's
 * row and sheet, so the two surfaces cannot word one tick two ways.
 *
 * The whole point of this module is the separation the issue asks for:
 *
 *   - the CHIP FACE is the configured schedule and nothing else — «hourly»,
 *     «off», «5 min». It never moves because the tick is unhealthy.
 *   - the DOT is the actual state and nothing else. It never moves because the
 *     schedule changed.
 *
 * So an enabled tick that has not checked in three cadences reads as enabled
 * AND stale, in one line, with neither fact borrowing the other's words. And a
 * fact the Viewer does not have is the word «unknown», never an age computed
 * from a missing instant.
 */

export type SeatTickStateKind = "healthy" | "stale" | "blocked" | "paused" | "unknown";
/** The dot beside the chip face: success, warning, muted for off, hollow for
    a state nothing has recorded. */
export type SeatTickTone = "ok" | "warn" | "muted" | "unknown";

export interface SeatTickReading {
  state: SeatTickStateKind;
  tone: SeatTickTone;
  /** The chip face's one word: the configured schedule. */
  chip: string;
  /** The configured clause of the closed summary («every 60 min», «off since 2h»). */
  configured: string;
  /** The closed summary without the «Tick:» prefix, for a surface that has
      already said what it is about — the phone's row inside the seat sheet. */
  summary: string;
  /** The closed summary: one line, no id, no path, no journal text. */
  line: string;
  /** The sentence at the top of the Actual section. */
  sentence: string;
  /** The status block's wake line: the headline with its dot, and the one
      detail line under it (last and next wake, or the blocker once, or the
      clause that explains a stale reading). */
  status: { headline: string; detail: string | null };
  /** The last delivery the journal holds, for Details. */
  lastDelivery: string;
  /** What holds the next wake back, in one clause, or null. */
  blocker: string | null;
  /** The record departs from the default, so Restore default has something to
      restore and a reason is owed for the next change. */
  offDefault: boolean;
}

const REASONS: Record<SeatTickWakeReasonKind, MessageKey> = {
  "lane-event": "seatTick.reason.laneEvent",
  "unmerged-pr": "seatTick.reason.unmergedPr",
  stalled: "seatTick.reason.stalled",
  "unstarted-task": "seatTick.reason.unstartedTask",
  interval: "seatTick.reason.interval",
  "child-terminal": "seatTick.reason.childTerminal",
  "own-lane-settled": "seatTick.reason.ownLaneSettled",
  "deploy-settled": "seatTick.reason.deploySettled",
  "maintenance-settled": "seatTick.reason.maintenanceSettled",
  "permission-request": "seatTick.reason.permissionRequest",
};

/** Every reason key, so the parity test can hold all of them in both locales. */
export const SEAT_TICK_REASON_KEYS: readonly MessageKey[] = Object.values(REASONS);

const DISPATCH: Record<"active" | "refused" | "returned", MessageKey> = {
  active: "seatTick.dispatch.active",
  refused: "seatTick.dispatch.refused",
  returned: "seatTick.dispatch.returned",
};

/** The delivery outcomes the tick's journal actually writes. Anything else is
    shown verbatim: a machine token the operator can search for beats a word
    this module invented for it. */
const OUTCOMES: Record<string, MessageKey> = {
  landed: "seatTick.outcome.landed",
  delivered: "seatTick.outcome.landed",
  "deferred-outstanding": "seatTick.outcome.deferred",
  queued: "seatTick.outcome.queued",
  held: "seatTick.outcome.held",
  uncertain: "seatTick.outcome.uncertain",
  failed: "seatTick.outcome.failed",
  dropped: "seatTick.outcome.dropped",
  revoked: "seatTick.outcome.revoked",
};

/** `fmtAge`'s own forms, from an instant rather than from an mtime, so an age
    in the popover reads exactly as an age on a card does. */
export function seatTickAge(iso: string | null, now: number, t: TFunction): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 90) return t("time.agoSec", { n: Math.round(seconds) });
  if (seconds < 5400) return t("time.agoMin", { n: Math.round(seconds / 60) });
  if (seconds < 129_600) return t("time.agoHour", { n: Math.round(seconds / 3600) });
  return t("time.agoDay", { n: Math.round(seconds / 86_400) });
}

/** An instant as local wall-clock time, with the date when it is not today.
    The only absolute time the control shows, and it shows it where an expiry
    or a `setBy` stamp is the thing being read. */
export function seatTickLocalTime(iso: string | null, now: number, locale: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return at.toLocaleString(locale === "uk" ? "uk-UA" : "en-GB", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * An interval as a schedule, collapsed only where it collapses EXACTLY and
 * into more than one unit: 120 minutes is «2 h», 90 minutes stays «90 min»,
 * and the default hour stays «60 min» rather than becoming «1 h». A rounded
 * number would be the control telling the operator a cadence they did not set.
 */
export function seatTickIntervalWord(minutes: number, t: TFunction): string {
  if (minutes >= 2880 && minutes % 1440 === 0) return t("seatTick.everyDay", { n: minutes / 1440 });
  if (minutes >= 120 && minutes % 60 === 0) return t("seatTick.everyHour", { n: minutes / 60 });
  return t("seatTick.everyMin", { n: minutes });
}

function reasonWords(reasons: readonly SeatTickWakeReasonKind[], t: TFunction): string {
  return reasons.map((reason) => (REASONS[reason] ? t(REASONS[reason]) : reason)).join(", ");
}

function outcomeWord(outcome: string, t: TFunction): string {
  const key = OUTCOMES[outcome];
  return key ? t(key) : outcome;
}

/** The first thing holding the next wake back, in the order an operator would
    act on them: an attempt nobody has landed, then the guard that stops a
    fruitless reason repeating, then evidence the check cannot read, then an
    accounting import that refuses every prepare. */
function blockerOf(answer: SeatTickSettingsAnswer, now: number, t: TFunction): string | null {
  const state = answer.state;
  if (!state) return null;
  if (state.outstandingWake) {
    const age = seatTickAge(state.outstandingWake.preparedAt, now, t) ?? t("seatTick.unknown");
    const dispatch = state.outstandingWake.dispatch;
    return dispatch
      ? t("seatTick.blocker.unresolvedDispatch", { age, dispatch: t(DISPATCH[dispatch]) })
      : t("seatTick.blocker.unresolved", { age });
  }
  const guarded = state.retryGuard[0];
  if (guarded) {
    return t("seatTick.blocker.retryGuard", { reason: reasonWords([guarded.kind], t), wakes: guarded.wakes });
  }
  if (state.sourceGap) {
    const since = seatTickAge(state.sourceGap.since, now, t) ?? t("seatTick.unknown");
    const source = t(state.sourceGap.source === "pull-requests" ? "seatTick.source.pullRequests" : "seatTick.source.children");
    return t("seatTick.blocker.sourceGap", { source, since, gap: state.sourceGap.gap });
  }
  if (state.accountingGap) {
    return t(state.accountingGap === "legacy-migration-pending" ? "seatTick.blocker.migrationPending" : "seatTick.blocker.migrationBlocked");
  }
  return null;
}

/**
 * Whether the tick's own checks have stopped for this project.
 *
 * A fact about the ROW, and deliberately independent of whether wakes are
 * enabled: a check keeps running and keeps stamping `lastCheckAt` for a
 * disabled project (`seatTickDecision`), so «off» and «the tick itself is
 * down» are two different things and a paused project has to be able to say
 * both. Null when there is no row to measure.
 */
function checksStopped(answer: SeatTickSettingsAnswer, now: number): boolean | null {
  const state = answer.state;
  if (!state) return null;
  const stale = answer.policy.staleAfterMinutes;
  const at = state.lastCheckAt ? Date.parse(state.lastCheckAt) : Number.NaN;
  /* No check on a row that exists is stale, not unknown: the row proves the
     tick has looked at this project before and has not since. */
  if (!Number.isFinite(at)) return true;
  /* Checks off in this Viewer: nothing will refresh that stamp, so however
     recent it is, the tick is not running. */
  return stale === null || now - at > stale * 60_000;
}

function stateKind(answer: SeatTickSettingsAnswer, blocker: string | null, stopped: boolean | null): SeatTickStateKind {
  if (!answer.effective.enabled) return "paused";
  if (blocker) return "blocked";
  if (stopped === null) return "unknown";
  return stopped ? "stale" : "healthy";
}

const TONE: Record<SeatTickStateKind, SeatTickTone> = {
  healthy: "ok",
  stale: "warn",
  blocked: "warn",
  paused: "muted",
  unknown: "unknown",
};

/** The dot: the state's own tone, except that a paused tick nothing is
    checking any more is a warning rather than the muted grey of a tick that is
    quiet on purpose and working. The dot reports the ACTUAL state, so it
    cannot keep reporting the configured intent once the checks have gone. */
function toneOf(kind: SeatTickStateKind, stopped: boolean | null): SeatTickTone {
  return kind === "paused" && stopped === true ? "warn" : TONE[kind];
}

/**
 * When the next wake is due, in one clause (#1771).
 *
 * Read beside the last DELIVERED wake above it, and that pairing is the whole
 * point: a tick can look enabled, checking and recently delivering while every
 * wake it prepares is refused, and the two rows together are what makes that
 * visible without asking the seat. The seat's own mute day was read off the
 * board as «healthy» for hours.
 *
 * Derived from the same interval the check applies and the same stamp only a
 * LANDED wake moves, so it says nothing the row cannot prove: with no row it
 * is unknown, with the tick off there is nothing to be due, with the next wake
 * fenced it is held, and with the interval already spent it is the next check —
 * never an invented instant.
 */
function nextWakeValue(answer: SeatTickSettingsAnswer, blocker: string | null, now: number, t: TFunction): string {
  const state = answer.state;
  if (!state) return t("seatTick.unknown");
  if (!answer.effective.enabled) return t("seatTick.nextWake.off");
  if (blocker) return t("seatTick.nextWake.blocked");
  const last = state.lastWakeAt ? Date.parse(state.lastWakeAt) : Number.NaN;
  if (!Number.isFinite(last)) return t("seatTick.nextWake.due");
  const due = last + answer.effective.wakeIntervalMinutes * 60_000;
  if (due <= now) return t("seatTick.nextWake.due");
  const minutes = Math.max(1, Math.round((due - now) / 60_000));
  return minutes >= 90
    ? t("seatTick.nextWake.inHour", { n: Math.round(minutes / 60) })
    : t("seatTick.nextWake.inMin", { n: minutes });
}

function lastWakeValue(answer: SeatTickSettingsAnswer, now: number, t: TFunction): string {
  const state = answer.state;
  const wakeAge = seatTickAge(state?.lastWakeAt ?? null, now, t);
  const reasons = state ? reasonWords(state.lastWakeReasons, t) : "";
  return wakeAge === null
    ? (state ? t("seatTick.never") : t("seatTick.unknown"))
    : reasons ? t("seatTick.row.wakeWithReasons", { age: wakeAge, reasons }) : wakeAge;
}

function lastDeliveryOf(answer: SeatTickSettingsAnswer, now: number, t: TFunction): string {
  const deliveryAge = seatTickAge(answer.lastDelivery?.at ?? null, now, t);
  return answer.lastDelivery && deliveryAge
    ? t("seatTick.row.delivery", { outcome: outcomeWord(answer.lastDelivery.outcome, t), age: deliveryAge })
    /* No delivery in the journal's window is not proof that none ever
       happened: the journal is bounded, so it is reported as what it is. */
    : answer.journalError ? t("seatTick.unknown") : answer.state ? t("seatTick.row.noDelivery") : t("seatTick.unknown");
}

/** The second line of the wake status. It states each fact once: a blocker
    or a stale tick is explained here and nowhere else in the panel. */
function statusDetail(
  answer: SeatTickSettingsAnswer,
  kind: SeatTickStateKind,
  blocker: string | null,
  stopped: boolean | null,
  sentence: string,
  now: number,
  t: TFunction,
): string | null {
  if (kind === "blocked") return t("seatTick.status.held", { blocker: blocker ?? t("seatTick.unknown") });
  if (kind === "unknown") return sentence;
  if (kind === "stale" || (kind === "paused" && stopped === true)) {
    const every = answer.policy.checkIntervalMinutes;
    return every === null ? t("seatTick.status.checksOff") : t("seatTick.status.staleHint", { every });
  }
  if (kind === "paused") return null;
  const last = t("seatTick.status.lastWake", { value: lastWakeValue(answer, now, t) });
  return `${last} · ${t("seatTick.status.nextWake", { value: nextWakeValue(answer, blocker, now, t) })}`;
}

function sentenceOf(
  answer: SeatTickSettingsAnswer,
  kind: SeatTickStateKind,
  blocker: string | null,
  stopped: boolean | null,
  now: number,
  t: TFunction,
): string {
  const checkAge = seatTickAge(answer.state?.lastCheckAt ?? null, now, t);
  switch (kind) {
    case "paused": {
      /* TWO clauses, because they rest on two different things. The pause is
         the SETTING, which the record proves. Whether checks are still running
         is the ACTUAL state, which only the row can say — and «checks still
         run» asserted over a row that stopped being stamped hours ago, or over
         no row at all, is exactly the conflation this module exists to refuse.
         So the pause is stated, and then what is actually known about the
         checks is stated beside it. */
      const age = seatTickAge(answer.effective.updatedAt, now, t);
      const pause = age ? t("seatTick.sentence.pausedSince", { age }) : t("seatTick.sentence.paused");
      const checks = stopped === null
        ? (answer.stateError ? t("seatTick.sentence.unknownUnreadable") : t("seatTick.sentence.unknownNoRow"))
        : stopped
          ? (checkAge ? t("seatTick.sentence.pausedStopped", { check: checkAge }) : t("seatTick.sentence.pausedNoCheck"))
          : t("seatTick.sentence.pausedChecking");
      return `${pause} ${checks}`;
    }
    case "blocked":
      return t("seatTick.sentence.blocked", { blocker: blocker ?? t("seatTick.unknown") });
    case "stale": {
      const every = answer.policy.checkIntervalMinutes;
      if (every === null) return t("seatTick.sentence.staleChecksOff");
      return checkAge
        ? t("seatTick.sentence.stale", { age: checkAge, every })
        : t("seatTick.sentence.staleNoCheck", { every });
    }
    case "unknown":
      return answer.stateError ? t("seatTick.sentence.unknownUnreadable") : t("seatTick.sentence.unknownNoRow");
    default:
      return checkAge ? t("seatTick.sentence.healthy", { age: checkAge }) : t("seatTick.sentence.healthyNoAge");
  }
}

/**
 * The whole reading. `failed` is a settings read that did not answer at all —
 * distinct from an answer whose STATE is unknown, because the first says
 * nothing about the tick and the second is a fact about it.
 */
export function seatTickReading(
  read: { answer: SeatTickSettingsAnswer | null; failed: boolean },
  now: number,
  t: TFunction,
): SeatTickReading {
  if (!read.answer) {
    const summary = t(read.failed ? "seatTick.summary.unreadable" : "seatTick.summary.loading");
    return {
      state: "unknown",
      tone: "unknown",
      chip: t(read.failed ? "seatTick.chip.unreadable" : "seatTick.chip.loading"),
      configured: t("seatTick.unknown"),
      summary,
      line: t("seatTick.line", { summary }),
      sentence: summary,
      status: { headline: t("seatTick.status.wakes", { summary }), detail: null },
      lastDelivery: t("seatTick.unknown"),
      blocker: null,
      offDefault: false,
    };
  }
  const answer = read.answer;
  const { effective } = answer;
  const blocker = blockerOf(answer, now, t);
  const stopped = checksStopped(answer, now);
  const kind = stateKind(answer, blocker, stopped);
  const interval = seatTickIntervalWord(effective.wakeIntervalMinutes, t);

  /* The face: the SCHEDULE, in as few characters as the incumbent row can
     spare. «hourly» only where the default really is the hour. */
  const chip = !effective.enabled
    ? t("seatTick.chip.off")
    : effective.isDefault && answer.defaultWakeIntervalMinutes === 60
      ? t("seatTick.chip.hourly")
      : interval;

  const offAge = seatTickAge(effective.updatedAt, now, t);
  const configured = effective.enabled
    ? interval
    : offAge ? t("seatTick.offSince", { age: offAge }) : t("seatTick.chip.off");

  const checkAge = seatTickAge(answer.state?.lastCheckAt ?? null, now, t);
  /* A paused tick whose checks have stopped says so on the closed line too:
     the summary is the only thing most readings are ever read from. */
  const staleClause = checkAge ? t("seatTick.line.stale", { age: checkAge }) : t("seatTick.line.staleNoCheck");
  const actual = kind === "blocked"
    ? t("seatTick.line.blocked", { blocker: blocker ?? t("seatTick.unknown") })
    : kind === "stale" || (kind === "paused" && stopped === true)
      ? staleClause
      : kind === "unknown"
        ? t("seatTick.line.unknown")
        : checkAge ? t("seatTick.line.lastCheck", { age: checkAge }) : t("seatTick.line.unknown");

  const summary = t("seatTick.summary", { configured, actual });
  const sentence = sentenceOf(answer, kind, blocker, stopped, now, t);
  /* A blocked tick names its blocker once, in the detail line; the headline
     keeps the plain last-check clause. */
  const quiet = checkAge ? t("seatTick.line.lastCheck", { age: checkAge }) : t("seatTick.line.unknown");
  const headlineSummary = kind === "blocked" ? t("seatTick.summary", { configured, actual: quiet }) : summary;
  return {
    state: kind,
    tone: toneOf(kind, stopped),
    chip,
    configured,
    summary,
    line: t("seatTick.line", { summary }),
    sentence,
    status: { headline: t("seatTick.status.wakes", { summary: headlineSummary }), detail: statusDetail(answer, kind, blocker, stopped, sentence, now, t) },
    lastDelivery: lastDeliveryOf(answer, now, t),
    blocker,
    offDefault: !effective.isDefault,
  };
}

/*
 * The board maintenance timer's reading (#2162), as a pure function of the
 * `maintenance` block the settings answer carries. Like the tick's reading it
 * holds the words and the tone and nothing else: every rule about when a run
 * is due lives on the server, which sends `nextRunAt` and `waitingOn` already
 * decided, so no arithmetic about intervals is repeated here.
 */

export type MaintenanceStateKind = "off" | "on" | "running";

/** One piece of a status line. A link segment is the "3 need you ↗" and
    "Accounts ↗" the operator can act on; the line joins its segments with
    a middle dot. */
export type StatusSegment =
  | { kind: "text"; text: string }
  | { kind: "card"; text: string; taskId: string }
  | { kind: "accounts"; text: string };

export interface MaintenanceReading {
  state: MaintenanceStateKind;
  /** The dot: a failed last run or an unreadable run store is a warning, a
      switched-off timer is muted, anything else is quiet green. */
  tone: SeatTickTone;
  /** The status block's maintenance line: the headline with its dot and the
      second line's segments (result, links, next run). */
  status: { headline: string; segments: StatusSegment[] };
  /** The group's "Last run" row, and the links that belong under it. */
  last: { text: string; links: StatusSegment[] };
  /** The group's "Next run" row. */
  next: string;
  /** The card the live run, or else the last ended run, is on. Null when there
      is none or the run never got a card. */
  cardTaskId: string | null;
  /** The run store could not be read; the setting still answers. */
  warning: string | null;
}

/** Every failure kind has a row: the record type makes a new kind a compile
    error here rather than a blank result line. */
export const MAINTENANCE_FAILURES: Record<MaintenanceFailureKind, MessageKey> = {
  "no-account": "seatTick.maintenance.failure.noAccount",
  "no-repository": "seatTick.maintenance.failure.noRepository",
  "launch-refused": "seatTick.maintenance.failure.launchRefused",
  "launch-failed": "seatTick.maintenance.failure.launchFailed",
  "host-died": "seatTick.maintenance.failure.hostDied",
  "turn-error": "seatTick.maintenance.failure.turnError",
  "agent-fail": "seatTick.maintenance.failure.agentFail",
  "needs-decision": "seatTick.maintenance.failure.needsDecision",
  "timed-out": "seatTick.maintenance.failure.timedOut",
};

/** Why nothing is scheduled, or null while a time can be named. Shared by the
    group's "Next run" row and the status line so the two cannot word one wait
    two ways. */
function maintenanceWait(m: BoardMaintenanceAnswer, t: TFunction): string | null {
  if (!m.enabled) return t("seatTick.maintenance.next.off");
  if (m.live) return t("seatTick.maintenance.next.afterRun");
  if (m.waitingOn === "wakes-off") return t("seatTick.maintenance.pausedWakesOff");
  if (m.waitingOn === "deployment") return t("seatTick.maintenance.next.waitingDeployment");
  if (m.waitingOn === "no-seat") return t("seatTick.maintenance.next.waitingNoSeat");
  return null;
}

function maintenanceNext(m: BoardMaintenanceAnswer, now: number, locale: string, t: TFunction): string {
  const wait = maintenanceWait(m, t);
  if (wait) return wait;
  const at = seatTickLocalTime(m.nextRunAt, now, locale);
  /* No instant means the tick's checks are off in this Viewer: nothing will
     start a run, and an invented time would say otherwise. */
  if (!at) return t("seatTick.maintenance.next.checksOff");
  return m.lastRun ? t("seatTick.maintenance.next.at", { time: at }) : t("seatTick.maintenance.next.firstRun", { time: at });
}

/** The next run as the status line's last segment: "next ≈ 08:34", or the
    one wait that holds it back. Null when there is nothing to say (off, or a
    run that is live). */
function maintenanceNextShort(m: BoardMaintenanceAnswer, now: number, locale: string, t: TFunction): string | null {
  if (!m.enabled || m.live) return null;
  const wait = maintenanceWait(m, t);
  if (wait) return wait;
  const at = seatTickLocalTime(m.nextRunAt, now, locale);
  if (!at) return t("seatTick.maintenance.next.checksOff");
  if (m.lastRun?.state === "failed") return t("seatTick.maintenance.status.retry", { time: at });
  return t(m.lastRun ? "seatTick.maintenance.status.next" : "seatTick.maintenance.status.firstRun", { time: at });
}

export function maintenanceReading(
  m: BoardMaintenanceAnswer | null | undefined,
  now: number,
  locale: string,
  t: TFunction,
): MaintenanceReading | null {
  if (!m) return null;
  const last = m.lastRun;
  const failed = last?.state === "failed";
  const warning = m.runsError ? t("seatTick.maintenance.runsUnreadable") : null;
  const state: MaintenanceStateKind = m.live ? "running" : m.enabled ? "on" : "off";
  const paused = m.waitingOn === "wakes-off";
  const since = seatTickLocalTime(m.live?.launchedAt ?? m.live?.claimedAt ?? null, now, locale);
  const endedAt = last ? seatTickLocalTime(last.endedAt ?? last.claimedAt, now, locale) ?? t("seatTick.unknown") : null;
  const reason = last?.failure ? t(MAINTENANCE_FAILURES[last.failure.kind] ?? "seatTick.maintenance.failure.unknown") : t("seatTick.maintenance.failure.unknown");
  const noAccount = failed && last?.failure?.kind === "no-account";
  const attention = !failed && last && last.attentionCount > 0 && last.taskId
    ? ({ kind: "card", text: t("seatTick.maintenance.needYou", { count: last.attentionCount }), taskId: last.taskId } satisfies StatusSegment)
    : null;
  const accounts = noAccount ? ({ kind: "accounts", text: t("seatTick.maintenance.accounts") } satisfies StatusSegment) : null;

  /* The status line. */
  const segments: StatusSegment[] = [];
  let headline: string;
  if (state === "off") {
    headline = t("seatTick.maintenance.status.off");
  } else if (state === "running") {
    headline = since ? t("seatTick.maintenance.status.running", { time: since }) : t("seatTick.maintenance.status.runningNoTime");
    if (m.pauseReason) segments.push({ kind: "text", text: t("seatTick.maintenance.pausedWakesOff") });
  } else {
    const result = last && endedAt
      ? t(failed ? "seatTick.maintenance.status.failed" : "seatTick.maintenance.status.done", { time: endedAt })
      : t("seatTick.maintenance.status.never");
    headline = t("seatTick.maintenance.status.every", { n: m.intervalHours, result });
    if (last && failed) segments.push({ kind: "text", text: reason });
    else if (last) segments.push({ kind: "text", text: t("seatTick.maintenance.status.changed", { n: last.counts.tasks }) });
    if (attention) segments.push(attention);
    else if (last && !failed && !paused) segments.push({ kind: "text", text: t("seatTick.maintenance.status.nobody") });
    if (accounts) segments.push(accounts);
  }
  const nextShort = maintenanceNextShort(m, now, locale, t);
  if (nextShort && state !== "running") segments.push({ kind: "text", text: nextShort });

  /* The group's last-run row. */
  const lastText = last && endedAt
    ? failed
      ? t("seatTick.maintenance.lastFailedWhy", { time: endedAt, reason })
      : t("seatTick.maintenance.lastDone", { time: endedAt, n: last.counts.tasks })
    : t("seatTick.never");
  const links: StatusSegment[] = [];
  if (attention) links.push(attention);
  if (accounts) links.push(accounts);

  return {
    state,
    tone: failed || warning ? "warn" : state === "off" || paused ? "muted" : "ok",
    status: { headline, segments },
    last: { text: lastText, links },
    next: maintenanceNext(m, now, locale, t),
    cardTaskId: m.live?.taskId ?? last?.taskId ?? null,
    warning,
  };
}
