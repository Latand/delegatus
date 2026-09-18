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

export interface SeatTickRow {
  label: string;
  value: string;
}

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
  /** The four read-only rows, in the order an operator reads them. */
  rows: SeatTickRow[];
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
};

/** Every reason key, so the parity test can hold all six in both locales. */
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

function rowsOf(answer: SeatTickSettingsAnswer, blocker: string | null, now: number, t: TFunction): SeatTickRow[] {
  const unknown = t("seatTick.unknown");
  const state = answer.state;
  const checkAge = seatTickAge(state?.lastCheckAt ?? null, now, t);
  const wakeAge = seatTickAge(state?.lastWakeAt ?? null, now, t);
  const reasons = state ? reasonWords(state.lastWakeReasons, t) : "";
  const deliveryAge = seatTickAge(answer.lastDelivery?.at ?? null, now, t);
  return [
    { label: t("seatTick.row.lastCheck"), value: checkAge ?? unknown },
    {
      label: t("seatTick.row.lastWake"),
      value: wakeAge === null
        ? (state ? t("seatTick.never") : unknown)
        : reasons ? t("seatTick.row.wakeWithReasons", { age: wakeAge, reasons }) : wakeAge,
    },
    {
      label: t("seatTick.row.lastDelivery"),
      value: answer.lastDelivery && deliveryAge
        ? t("seatTick.row.delivery", { outcome: outcomeWord(answer.lastDelivery.outcome, t), age: deliveryAge })
        /* No delivery in the journal's window is not proof that none ever
           happened: the journal is bounded, so it is reported as what it is. */
        : answer.journalError ? unknown : state ? t("seatTick.row.noDelivery") : unknown,
    },
    { label: t("seatTick.row.blocker"), value: blocker ?? (state ? t("seatTick.none") : unknown) },
  ];
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
      rows: [],
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
  return {
    state: kind,
    tone: toneOf(kind, stopped),
    chip,
    configured,
    summary,
    line: t("seatTick.line", { summary }),
    sentence: sentenceOf(answer, kind, blocker, stopped, now, t),
    rows: rowsOf(answer, blocker, now, t),
    blocker,
    offDefault: !effective.isDefault,
  };
}
