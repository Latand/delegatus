import { seatTickSettingsCardText } from "./cards";
import { readSeatTickRecords, SEAT_TICK_RUN_HISTORY } from "./journalStore";
import { SEAT_TICK_WAKE_INTERVAL_MS, seatTickPolicy, seatTickSettingsCardDetail } from "./seatTick";
import {
  defaultSeatTickSettings,
  effectiveSeatTickSettings,
  readSeatTickSettings,
  type SeatTickSettings,
  type SeatTickSettingsActor,
} from "./seatTickSettings";
import { peekSeatTickState } from "./seatTickState";
import type { SeatTickProjectState, SeatTickRunRecord, SeatTickWakeReasonKind } from "./types";

/**
 * One project's seat tick as a browser control needs to read it (#1681): the
 * CONFIGURED settings, which are editable, beside the ACTUAL state, which is
 * not.
 *
 * Three properties this module exists to keep, all of them the issue's:
 *
 * - **One settings model.** The configured half is
 *   {@link readSeatTickSettings} and {@link effectiveSeatTickSettings} — the
 *   same record and the same reading the `seat_tick_settings` tool and every
 *   check use. Nothing here holds a second copy of what a tick setting is.
 * - **Enabled is never healthy.** The actual half comes from the persisted row
 *   ({@link peekSeatTickState}) and the tick's own journal, and it is reported
 *   as separate facts rather than folded into the settings. A tick that is on
 *   and has not checked in fifteen minutes has to be readable as both.
 * - **A value the Viewer does not have reads as unknown.** `state` is null for
 *   a project the tick has never recorded, and every instant on it may be
 *   null. Nothing here computes an age, a next wake or a health verdict from
 *   an absent fact; the client renders the nulls as the word.
 *
 * Inert by construction: the row is PEEKED, so asking about a name nobody has
 * ticked mints no accounting row, and nothing in here writes, ends a send or
 * asks the runtime host. The heavier per-attempt reading stays where it
 * already lives — `GET /api/monitor/seat-tick` — and this answer only links to
 * it.
 */

/** Three missed checks: past this, the tick itself may be down rather than
    merely quiet. At the default five-minute cadence it is the issue's fifteen
    minutes, and it is derived from the policy rather than restated, so a
    Viewer running a different cadence reports its own number. */
const STALE_CHECKS = 3;

export interface SeatTickActualState {
  /** When a check last decided anything for this project. */
  lastCheckAt: string | null;
  lastWakeAt: string | null;
  lastWakeReasons: SeatTickWakeReasonKind[];
  /**
   * A wake the delivery layer accepted and nothing has landed. `dispatch` is
   * the admission state only — never the token, which is a durable credential
   * for the one controller allowed inside transport.
   */
  outstandingWake: { preparedAt: string | null; dispatch: "active" | "refused" | "returned" | null } | null;
  /** Reason kinds whose wakes have changed nothing often enough for the retry
      guard to hold them back, with the run each has reached. */
  retryGuard: Array<{ kind: SeatTickWakeReasonKind; wakes: number }>;
  /** An evidence source failing since `since`; the reasons resting on it are
      withdrawn while it stands. */
  sourceGap: { source: "pull-requests" | "children"; gap: string; since: string } | null;
  /** The accounting import's own gap. A blocked import refuses every prepare,
      so nothing is woken until the legacy file is fixed. */
  accountingGap: string | null;
}

/** The newest check this project recorded. Bounded fields only: the verdict,
    why it woke, what became of the send and the one publication-safe clause
    the journal keeps. */
export interface SeatTickLastRun {
  at: string;
  verdict: SeatTickRunRecord["verdict"];
  reasons: SeatTickWakeReasonKind[];
  delivery: { outcome: string } | null;
  detail: string | null;
}

export interface SeatTickSettingsAnswer {
  project: string;
  /** Whether this request wrote the record. A read, and a change with no
      fields, answer false — as the tool's does. */
  changed: boolean;
  at: string;
  /** Who a change from this request is recorded as. Server-derived; a body
      cannot name it. */
  actor: SeatTickSettingsActor;
  /** The stored record, read back after any write. */
  settings: SeatTickSettings;
  /** The record as a check reads it, with its expiry already applied. */
  effective: {
    enabled: boolean;
    wakeIntervalMinutes: number;
    reason: string | null;
    monitorPrompt: string | null;
    until: string | null;
    isDefault: boolean;
    /** Whether anyone has ever written this project's row. */
    configured: boolean;
    /** Whether the reading above is the default again because an expiry
        passed. */
    lapsed: boolean;
    updatedAt: string | null;
  };
  /** What a project nobody configured runs on, so the control can show what
      Restore default restores before it is pressed. */
  defaults: SeatTickSettings;
  defaultWakeIntervalMinutes: number;
  monitorPromptLength: number;
  /** The board card these settings stand under, in the card's own words, or
      null while the project is on the default. */
  cardText: string | null;
  policy: {
    /** How often a check runs at all; null when checks are off in this Viewer. */
    checkIntervalMinutes: number | null;
    /** How old a last check may be before the tick reads as stale rather than
        quiet; null when checks are off. */
    staleAfterMinutes: number | null;
    /** Fruitless wakes of one reason before the guard holds it back. */
    retryGuardWakes: number;
  };
  /** The tick's own record for this project, or null when it has never
      recorded one — which is an unknown, not a quiet tick. */
  state: SeatTickActualState | null;
  /** Why the row could not be read, when it could not. The settings still
      answer: one unreadable store must not take the controls away. */
  stateError: string | null;
  lastRun: SeatTickLastRun | null;
  /**
   * The newest check that actually SENT something, and what became of it.
   *
   * Separate from {@link lastRun} because the newest check is usually quiet:
   * reading the last delivery off it would report "no delivery" for a project
   * whose wake landed ten minutes ago.
   */
  lastDelivery: { at: string; outcome: string } | null;
  journalError: string | null;
}

export interface SeatTickSettingsAnswerPorts {
  now?: () => number;
  settings?: typeof readSeatTickSettings;
  readState?: (project: string) => SeatTickProjectState;
  records?: (limit: number) => SeatTickRunRecord[];
  policy?: typeof seatTickPolicy;
}

/**
 * Whether the tick has recorded anything at all for this project.
 *
 * A peeked row for a name nobody has ticked is the EMPTY row, and reporting
 * its nulls as facts would read as "checked never, woken never" — which is a
 * claim about a tick that may simply never have looked. Unknown is the honest
 * answer, so the empty row has to stay distinguishable from a real one.
 */
function recorded(row: SeatTickProjectState): boolean {
  return row.seatEpoch !== null
    || row.lastCheckAt !== null
    || row.lastWakeAt !== null
    || row.eventsThrough !== null
    || row.outstandingWake !== null
    || row.accounting !== undefined;
}

function actualState(row: SeatTickProjectState, retryGuardWakes: number): SeatTickActualState {
  const guarded = Object.entries(row.wakesWithoutChange ?? {})
    .flatMap(([kind, wakes]) => (typeof wakes === "number" && wakes >= retryGuardWakes
      ? [{ kind: kind as SeatTickWakeReasonKind, wakes }]
      : []));
  /* One gap, the one an operator would look at first: the pull-request source
     withdraws a named obligation, the children source withdraws a harvest. */
  const gap = row.pullRequestGap
    ? { source: "pull-requests" as const, gap: row.pullRequestGap.gap, since: row.pullRequestGap.since }
    : row.childrenGap
      ? { source: "children" as const, gap: row.childrenGap.gap, since: row.childrenGap.since }
      : null;
  return {
    lastCheckAt: row.lastCheckAt,
    lastWakeAt: row.lastWakeAt,
    lastWakeReasons: [...(row.lastWakeReasons ?? [])],
    outstandingWake: row.outstandingWake
      ? { preparedAt: row.outstandingWake.preparedAt ?? null, dispatch: row.outstandingWake.dispatch?.state ?? null }
      : null,
    retryGuard: guarded,
    sourceGap: gap,
    accountingGap: row.accounting?.gap ?? null,
  };
}

/**
 * The whole answer, for a project named canonically by the caller.
 *
 * Each store is read in its own try: an unreadable row or journal reports as
 * null beside its error, and the settings still answer. The settings read is
 * the one failure the caller has to handle, because without it there is
 * nothing to show and nothing to edit.
 */
export function seatTickSettingsAnswer(
  project: string,
  changed: boolean,
  actor: SeatTickSettingsActor,
  ports: SeatTickSettingsAnswerPorts = {},
): SeatTickSettingsAnswer {
  const now = (ports.now ?? Date.now)();
  /* Read back from the record: what a later check will read, never the echo of
     what a caller sent. */
  const settings = (ports.settings ?? readSeatTickSettings)(project);
  const effective = effectiveSeatTickSettings(settings, now, SEAT_TICK_WAKE_INTERVAL_MS);
  const policy = (ports.policy ?? seatTickPolicy)();
  const checkIntervalMinutes = policy ? Math.max(1, Math.round(policy.checkIntervalMs / 60_000)) : null;
  const retryGuardWakes = policy?.retryGuard ?? 2;

  let state: SeatTickActualState | null = null;
  let stateError: string | null = null;
  try {
    const row = (ports.readState ?? peekSeatTickState)(project);
    state = recorded(row) ? actualState(row, retryGuardWakes) : null;
  } catch (error) {
    stateError = error instanceof Error ? error.message : "the tick's record could not be read";
  }

  let lastRun: SeatTickLastRun | null = null;
  let lastDelivery: { at: string; outcome: string } | null = null;
  let journalError: string | null = null;
  try {
    const own = (ports.records ?? readSeatTickRecords)(SEAT_TICK_RUN_HISTORY).filter((entry) => entry.project === project);
    const record = own.at(-1) ?? null;
    lastRun = record
      ? {
        at: record.at,
        verdict: record.verdict,
        reasons: [...record.reasons],
        delivery: record.delivery ? { outcome: record.delivery.outcome } : null,
        detail: record.detail,
      }
      : null;
    const sent = [...own].reverse().find((entry) => entry.delivery !== null) ?? null;
    lastDelivery = sent?.delivery ? { at: sent.at, outcome: sent.delivery.outcome } : null;
  } catch (error) {
    journalError = error instanceof Error ? error.message : "the tick's journal could not be read";
  }

  return {
    project,
    changed,
    at: new Date(now).toISOString(),
    actor,
    settings,
    effective: {
      enabled: effective.enabled,
      wakeIntervalMinutes: Math.round(effective.wakeIntervalMs / 60_000),
      reason: effective.reason,
      monitorPrompt: effective.monitorPrompt,
      until: effective.until,
      isDefault: effective.isDefault,
      configured: effective.configured,
      lapsed: effective.lapsed,
      updatedAt: effective.updatedAt,
    },
    defaults: defaultSeatTickSettings(project),
    defaultWakeIntervalMinutes: Math.round(SEAT_TICK_WAKE_INTERVAL_MS / 60_000),
    monitorPromptLength: settings.monitorPrompt?.length ?? 0,
    /* The card the board carries while this stands, composed from the same
       helper the check composes it with. Null on the default, where there is
       no card to raise. */
    cardText: effective.configured && !effective.isDefault
      ? seatTickSettingsCardText({
        project,
        detail: seatTickSettingsCardDetail(effective),
        reason: effective.reason,
        until: effective.until,
        setBy: effective.setBy,
        updatedAt: effective.updatedAt,
      })
      : null,
    policy: {
      checkIntervalMinutes,
      staleAfterMinutes: checkIntervalMinutes === null ? null : checkIntervalMinutes * STALE_CHECKS,
      retryGuardWakes,
    },
    state,
    stateError,
    lastRun,
    lastDelivery,
    journalError,
  };
}
