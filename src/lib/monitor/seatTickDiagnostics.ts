import { canonicalOrchestratorProject, orchestratorSeatFor } from "@/lib/orchestrator/seats";

import { readSeatTickRecords, SEAT_TICK_RUN_HISTORY } from "./journalStore";
import { redactMonitorText } from "./redact";
import { SEAT_TICK_WAKE_INTERVAL_MS } from "./seatTick";
import { seatTickAttemptExits } from "./seatTickController";
import { effectiveSeatTickSettings, readSeatTickSettings } from "./seatTickSettings";
import { wakeRecordPorts, wakeStateFromRecord, type SeatTickWakeObservation } from "./seatTickSources";
import { readSeatTickState } from "./seatTickState";
import type { SeatTickOutstandingWake, SeatTickProjectState, SeatTickRunRecord } from "./types";

/**
 * One project's seat tick, read whole and read only.
 *
 * Until this existed the only way to learn why a project was not being woken
 * was to open the accounting database and the delivery record by hand: the
 * journal names the deferral, the row names the attempt, the record names the
 * operation, and the runtime journal names what became of it — four stores,
 * none of them reachable through the Viewer. This puts the four beside each
 * other, with the holder's current answer and what would end each attempt,
 * in the same words the board card uses.
 *
 * Inert by construction: the holder is asked through {@link wakeRecordPorts}
 * with `end: false`, so an in-flight send is reported as it rests and never
 * ended, and a journal verdict is reported as what it proves and never
 * written onto the record. Ending and writing belong to the check.
 */
export interface SeatTickAttemptDiagnostic {
  slot: "outstanding" | "retired";
  clientMessageId: string;
  conversationId: string;
  seatEpoch: number;
  /** The operation handle the tick recorded at the send, which is null for
      every send whose transport answered without one. The record's own
      handle is in the observation. */
  operationId: string | null;
  preparedAt: string | null;
  dispatch: SeatTickOutstandingWake["dispatch"] | null;
  /** The payload's size, never the payload: it is a wake addressed to a seat. */
  textLength: number;
  commit: { proposal: boolean; reasons: string[]; eventsThrough: number; children: number };
  retiredAt: string | null;
  supersededBy: { conversationId: string; seatEpoch: number } | null;
  /** Whether this attempt holds back the project's next wake right now: an
      outstanding attempt always does, a retired one only while it is
      addressed to the conversation that is the seat again (#1594). */
  withholds: boolean;
  observation: SeatTickWakeObservation | { state: "unreadable"; reason: string };
  /** What would end it, in the card's own words. */
  exits: string[];
}

export interface SeatTickDiagnostics {
  project: string;
  at: string;
  seat: { conversationId: string | null; seatEpoch: number } | null;
  settings: {
    enabled: boolean;
    wakeIntervalMs: number;
    reason: string | null;
    until: string | null;
    updatedAt: string | null;
    isDefault: boolean;
    /** The prompt's size, never the prompt: it is the seat's own instruction. */
    monitorPromptLength: number;
  };
  state: {
    seatEpoch: number | null;
    lastCheckAt: string | null;
    lastWakeAt: string | null;
    eventsThrough: number | null;
    /** The attempt the last release left behind, whose key the next wake's
        identity is derived from (#1672). */
    releasedWake: { clientMessageId: string; releasedAt: string } | null;
    accounting: { revision: number; gap: string | null } | null;
  };
  attempts: SeatTickAttemptDiagnostic[];
  /** This project's newest checks, oldest first. */
  journal: SeatTickRunRecord[];
}

export interface SeatTickDiagnosticsPorts {
  now?: () => number;
  readState?: (project: string) => SeatTickProjectState;
  settings?: typeof readSeatTickSettings;
  seatFor?: typeof orchestratorSeatFor;
  records?: (limit: number) => SeatTickRunRecord[];
  /** The holder, asked without ending or writing anything. */
  observe?: (wake: SeatTickOutstandingWake) => Promise<SeatTickWakeObservation>;
}

export const SEAT_TICK_DIAGNOSTICS_DEFAULT_LIMIT = 20;
export const SEAT_TICK_DIAGNOSTICS_MAX_LIMIT = 200;

export async function seatTickDiagnostics(project: string, limit: number, ports: SeatTickDiagnosticsPorts = {}): Promise<SeatTickDiagnostics> {
  const canonical = canonicalOrchestratorProject(project);
  const now = (ports.now ?? Date.now)();
  const state = (ports.readState ?? readSeatTickState)(canonical);
  const settings = effectiveSeatTickSettings((ports.settings ?? readSeatTickSettings)(canonical), now, SEAT_TICK_WAKE_INTERVAL_MS);
  const active = (ports.seatFor ?? orchestratorSeatFor)(canonical).active ?? null;
  const seat = active ? { conversationId: active.conversationId ?? null, seatEpoch: active.seatEpoch } : null;
  const observe = ports.observe ?? ((wake: SeatTickOutstandingWake) => wakeStateFromRecord(wake, wakeRecordPorts({ end: false })));

  const attempts: SeatTickAttemptDiagnostic[] = [];
  const describe = async (slot: SeatTickAttemptDiagnostic["slot"], wake: SeatTickOutstandingWake, retired: { retiredAt: string; supersededBy: SeatTickAttemptDiagnostic["supersededBy"] } | null): Promise<void> => {
    let observation: SeatTickAttemptDiagnostic["observation"];
    try {
      observation = await observe(wake);
    } catch (error) {
      observation = { state: "unreadable", reason: redactMonitorText(error instanceof Error ? error.message : "unknown error") };
    }
    attempts.push({
      slot,
      clientMessageId: wake.clientMessageId,
      conversationId: wake.conversationId,
      seatEpoch: wake.seatEpoch,
      operationId: wake.operationId,
      preparedAt: wake.preparedAt ?? null,
      dispatch: wake.dispatch ?? null,
      textLength: wake.text?.length ?? 0,
      commit: { proposal: wake.commit.proposal, reasons: [...wake.commit.reasons], eventsThrough: wake.commit.eventsThrough, children: wake.commit.children.length },
      retiredAt: retired?.retiredAt ?? null,
      supersededBy: retired?.supersededBy ?? null,
      withholds: slot === "outstanding" || wake.conversationId === seat?.conversationId,
      observation,
      exits: seatTickAttemptExits("evidence" in observation ? observation.evidence : null),
    });
  };
  if (state.outstandingWake) await describe("outstanding", state.outstandingWake, null);
  for (const entry of state.retiredWakes ?? []) await describe("retired", entry.wake, { retiredAt: entry.retiredAt, supersededBy: entry.supersededBy });

  const bounded = Math.min(Math.max(1, Math.floor(limit)), SEAT_TICK_DIAGNOSTICS_MAX_LIMIT);
  const journal = (ports.records ?? readSeatTickRecords)(SEAT_TICK_RUN_HISTORY)
    .filter((record) => record.project === canonical)
    .slice(-bounded);

  return {
    project: canonical,
    at: new Date(now).toISOString(),
    seat,
    settings: {
      enabled: settings.enabled,
      wakeIntervalMs: settings.wakeIntervalMs,
      reason: settings.reason,
      until: settings.until,
      updatedAt: settings.updatedAt,
      isDefault: settings.isDefault,
      monitorPromptLength: settings.monitorPrompt?.length ?? 0,
    },
    state: {
      seatEpoch: state.seatEpoch,
      lastCheckAt: state.lastCheckAt,
      lastWakeAt: state.lastWakeAt,
      eventsThrough: state.eventsThrough,
      releasedWake: state.releasedWake ?? null,
      accounting: state.accounting ? { revision: state.accounting.revision, gap: state.accounting.gap } : null,
    },
    attempts,
    journal,
  };
}
