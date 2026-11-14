"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";
import type { SeatNoteRemoval } from "@/lib/monitor/seatTickInstructions";

/**
 * One project's seat tick settings, read and written through the one route
 * (#1681).
 *
 * The save contract is the issue's, and it is the whole reason this is a hook
 * rather than four `fetch` calls in a component:
 *
 * - **The displayed values are the RECORD's.** Every answer, on a read and on
 *   a write alike, is what the route read back from the stored record. The
 *   echo of a request is never adopted.
 * - **Optimistic display, with rollback.** While a save is in flight the
 *   control shows what was sent, so the chip does not sit on a value the
 *   operator has already changed. A refusal, a failure or a lost reply puts
 *   the last read-back values back, shows the server's own text, and triggers
 *   ONE re-read — so a write that landed despite a lost reply is on screen a
 *   moment later instead of being retried blindly.
 */
export const SEAT_TICK_POLL_MS = 60_000;

/** The change fields the route takes. `untilMinutes` is minutes from now, as
    the `seat_tick_settings` tool's own argument is. */
export interface SeatTickChange {
  autonomy?: { enabled?: boolean; hours?: number | null; proactive?: { enabled: boolean } };
  /** Turbo (docs/design/turbo-mode.md): saved on its own, at once, never with the panel's Save. */
  turbo?: Record<string, unknown>;
  release?: { enabled?: boolean; askBeforePublish?: boolean; minChanges?: number | string | null; minGapHours?: number | string | null; hold?: string | null };
  autoRotate?: { enabled?: boolean; thresholdPercent?: number | string | null };
  enabled?: boolean;
  /**
   * Minutes, or `null` for the default — and a `string` for an entry that is
   * neither, which is handed to the server AS TYPED so the module names it in
   * the refusal. Coercing it here is how a typo becomes a silent restore of
   * the default: `Number("abc")` and `Number("1e400")` both serialise to JSON
   * `null`, which the module reads as «restore the default».
   */
  wakeIntervalMinutes?: number | string | null;
  reason?: string | null;
  clearUnknownInstructions?: boolean;
  replaceOtherInstructions?: boolean;
  removeSeatNotes?: SeatNoteRemoval[];
  untilMinutes?: number | null;
  /**
   * The board maintenance timer (#2162). `intervalHours` follows the same
   * rule as `wakeIntervalMinutes`: a number, `null` for the default, and a
   * `string` for an entry that is neither, handed over as typed so the server
   * names it instead of a `null` restoring the default.
   */
  maintenance?: { enabled?: boolean; intervalHours?: number | string | null };
  curation?: { enabled?: boolean; intervalHours?: number | string | null };
}

export interface SeatTickSettingsRead {
  /** The project this read and every save through it belong to. */
  project: string;
  /** What to DISPLAY: the last read-back record, or the optimistic overlay of
      a save in flight. Null until the first answer for this project. */
  answer: SeatTickSettingsAnswer | null;
  /**
   * What the record actually holds — the last read-back, never an overlay.
   *
   * The form binds to THIS (the issue: «a form bound to the stored record,
   * never to the echo of a send»), so a save in flight cannot make the fields
   * follow their own optimistic display, and a refusal rolls the display back
   * without rewriting what the operator has in hand to correct.
   */
  record: SeatTickSettingsAnswer | null;
  /** The newest read did not answer at all — which says nothing about the
      tick, so it is reported separately from a state the tick has not
      recorded. */
  failed: boolean;
  saving: boolean;
  /** The server's refusal, verbatim, or the transport failure that replaced
      it. Cleared by the next save and by `clearError`. */
  error: string | null;
  /** Which group of the form the refusal in `error` belongs to: the one whose
      Save was pressed, so it is shown beside the fields to correct. */
  errorScope: "tick" | "maintenance" | "autoRotate" | "turbo";
  refresh: () => Promise<void>;
  /** True when the record now holds the change. False when it does not, and
      also, sending nothing, when another save is still in flight. */
  save: (change: SeatTickChange) => Promise<boolean>;
  /**
   * A save that waits its turn instead of being turned away: once no save is
   * in flight, `build` is handed the record as it then stands and returns the
   * change to send, or null to send nothing. Resolves to null when nothing was
   * sent, otherwise as `save` does — so a false here is always the route's.
   */
  saveAfter: (build: (record: SeatTickSettingsAnswer) => SeatTickChange | null) => Promise<boolean | null>;
  clearError: () => void;
}

/** One tab owns at most 64 project/view readings, evicting the oldest.
    A summary never supplies the editable panel record. */
const readings = new Map<string, SeatTickSettingsAnswer | null>();

export function resetSeatTickSettingsCacheForTests(): void {
  readings.clear();
}

function scheduleSignature(answer: SeatTickSettingsAnswer): string {
  const { settings, effective } = answer;
  return JSON.stringify([
    settings.enabled, settings.wakeIntervalMinutes, settings.reason, settings.until, settings.updatedAt,
    effective.enabled, effective.wakeIntervalMinutes, effective.reason, effective.until, effective.isDefault, effective.lapsed, effective.updatedAt,
  ]);
}

/**
 * The reading kept for `key`, except a panel record the closed control's
 * summary has already overtaken: a summary read at or after the panel's own
 * moment that shows a different schedule means the panel record is older than
 * what the operator sees on the closed switch. Reopening the panel must never
 * put that older record on the face or in the form, so it reads as absent until
 * a panel read answers. The panel entry is not deleted: it stays, ignored,
 * until the next panel answer replaces it.
 */
function keptReading(key: string): SeatTickSettingsAnswer | null {
  const kept = readings.get(key) ?? null;
  if (!kept || !key.endsWith(":panel")) return kept;
  const summary = readings.get(`${key.slice(0, -":panel".length)}:summary`);
  if (!summary || scheduleSignature(summary) === scheduleSignature(kept)) return kept;
  return Date.parse(summary.at) >= Date.parse(kept.at) ? null : kept;
}

const SETTINGS_URL = "/api/monitor/seat-tick/settings";

async function readError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    return typeof body?.error === "string" && body.error ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Whether a 200 body is actually the answer.
 *
 * A readable receipt is the only thing that settles a read here. Every 200 the
 * route emits carries the record and its effective reading; a 200 that does
 * not is a truncated body, a proxy's own page, or a shape this client does not
 * understand — and none of them say anything about the tick. Adopting one
 * would have the control dereference a record it does not have, which on the
 * desktop takes the whole incumbent row down with it.
 */
function isAnswer(value: unknown): value is SeatTickSettingsAnswer {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<SeatTickSettingsAnswer>;
  return typeof body.project === "string"
    && typeof body.defaultWakeIntervalMinutes === "number"
    && typeof body.settings === "object" && body.settings !== null
    && typeof body.effective === "object" && body.effective !== null
    && typeof body.policy === "object" && body.policy !== null;
}

export async function fetchSeatTickSettings(project: string, signal?: AbortSignal, view: "panel" | "summary" = "panel"): Promise<SeatTickSettingsAnswer> {
  const response = await fetch(`${SETTINGS_URL}?project=${encodeURIComponent(project)}${view === "summary" ? "&view=summary" : ""}`, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error((await readError(response)) ?? `seat tick settings read failed: ${response.status}`);
  const body = (await response.json().catch(() => null)) as unknown;
  if (!isAnswer(body)) throw new Error("the seat tick settings answer could not be read");
  return body;
}

/**
 * What the control shows WHILE a save is in flight: the last read-back answer
 * with the sent fields laid over it.
 *
 * Display only, and deliberately shallow — it is not a second settings model
 * and nothing persists from it. It answers one question: does the chip show
 * the value the operator just chose, or the value it is replacing. The
 * authoritative reading replaces it wholesale when the route answers, and the
 * previous answer replaces it wholesale when the route refuses.
 */
function optimistic(answer: SeatTickSettingsAnswer, change: SeatTickChange): SeatTickSettingsAnswer {
  /* An interval the server is about to refuse has nothing to display
     optimistically, so the record's own keeps the screen until the refusal
     lands and rolls the display back. */
  const interval = typeof change.wakeIntervalMinutes === "string" ? undefined : change.wakeIntervalMinutes;
  const settings = {
    ...answer.settings,
    ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
    ...(interval !== undefined ? { wakeIntervalMinutes: interval } : {}),
    ...(change.reason !== undefined ? { reason: change.reason } : {}),
  };
  const isDefault = settings.enabled && settings.wakeIntervalMinutes === null;
  const sentHours = typeof change.maintenance?.intervalHours === "number" ? change.maintenance.intervalHours : undefined;
  /* Answers from a server older than the timer carry no block; there is
     nothing to lay the change over then, and the form is not shown either. */
  const maintenance = answer.maintenance && change.maintenance
    ? {
      ...answer.maintenance,
      ...(change.maintenance.enabled !== undefined ? { enabled: change.maintenance.enabled } : {}),
      ...(sentHours !== undefined ? { intervalHours: sentHours } : {}),
      ...(change.maintenance.intervalHours === null ? { intervalHours: answer.maintenance.defaultIntervalHours } : {}),
    }
    : answer.maintenance;
  return {
    ...answer,
    ...(maintenance ? { maintenance } : {}),
    ...(answer.curation && change.curation ? { curation: { ...answer.curation,
      ...(change.curation.enabled !== undefined ? { enabled: change.curation.enabled } : {}),
      ...(typeof change.curation.intervalHours === "number" ? { intervalHours: change.curation.intervalHours } : {}),
      ...(change.curation.intervalHours === null ? { intervalHours: answer.curation.defaultIntervalHours } : {}) } } : {}),
    ...(answer.release && change.release ? { release: { ...answer.release,
      ...(typeof change.release.enabled === "boolean" ? { enabled: change.release.enabled } : {}),
      ...(typeof change.release.askBeforePublish === "boolean" ? { askBeforePublish: change.release.askBeforePublish } : {}),
      ...(typeof change.release.minChanges === "number" ? { minChanges: change.release.minChanges } : {}),
      ...(typeof change.release.minGapHours === "number" ? { minGapHours: change.release.minGapHours } : {}) } } : {}),
    ...(answer.autoRotate && change.autoRotate ? { autoRotate: { ...answer.autoRotate,
      ...(change.autoRotate.enabled !== undefined ? { enabled: change.autoRotate.enabled } : {}),
      ...(typeof change.autoRotate.thresholdPercent === "number" ? { thresholdPercent: change.autoRotate.thresholdPercent } : {}),
      ...(change.autoRotate.thresholdPercent === null ? { thresholdPercent: answer.autoRotate.defaultPercent } : {}) } } : {}),
    settings,
    effective: {
      ...answer.effective,
      enabled: isDefault ? true : settings.enabled,
      wakeIntervalMinutes: isDefault ? answer.defaultWakeIntervalMinutes : settings.wakeIntervalMinutes ?? answer.defaultWakeIntervalMinutes,
      reason: isDefault ? null : settings.reason,
      isDefault,
    },
  };
}

export function useSeatTickSettings(project: string, enabled: boolean, view: "panel" | "summary" = "panel"): SeatTickSettingsRead {
  const key = `${project}:${view}`;
  const [stored, setStored] = useState<{ project: string; answer: SeatTickSettingsAnswer } | null>(
    () => {
      const cached = keptReading(key);
      return cached ? { project: key, answer: cached } : null;
    },
  );
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<{ project: string; answer: SeatTickSettingsAnswer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorScope, setErrorScope] = useState<"tick" | "maintenance" | "autoRotate" | "turbo">("tick");
  /* One save at a time: two in flight would race to decide which read-back is
     the record, and the loser would put a superseded reading on screen. */
  const inFlight = useRef(false);
  const flight = useRef<Promise<boolean> | null>(null);
  /* The answer this hook instance received while it was enabled. The
     overtaken-record rule exists for a record cached from an EARLIER open; an
     answer the current open received is the panel's own and stays, whatever
     the closed control's summary poll sees meanwhile (a monitor note or a
     reason line moves `updatedAt` without touching the form). Cleared when the
     hook is disabled, so the next open starts from the rule again. */
  const [ownShown, setOwnShown] = useState<SeatTickSettingsAnswer | null>(null);
  const own = useRef<SeatTickSettingsAnswer | null>(null);
  const setOwn = useCallback((answer: SeatTickSettingsAnswer | null) => {
    own.current = answer;
    setOwnShown(answer);
  }, []);
  /* For the save paths, which run outside render and read the newest answer. */
  const kept = useCallback((): SeatTickSettingsAnswer | null => {
    const cached = readings.get(key) ?? null;
    return cached && cached === own.current ? cached : keptReading(key);
  }, [key]);

  /* Answers carry the project they answered for, so a project switch drops the
     previous project's reading HERE, in render — never a frame of another
     project's schedule under this project's name. */
  const cachedNow = readings.get(key) ?? null;
  const current = readings.has(key) ? (cachedNow && cachedNow === ownShown ? cachedNow : keptReading(key)) : (stored && stored.project === key ? stored.answer : null);
  const shown = pending && pending.project === key ? pending.answer : current;

  const settle = useCallback((target: string, answer: SeatTickSettingsAnswer) => {
    readings.delete(`${target}:${view}`);
    readings.set(`${target}:${view}`, answer);
    // A full receipt is also authoritative for the closed control.
    if (answer.view !== "summary") readings.set(`${target}:summary`, answer);
    else if (answer.changed) readings.set(`${target}:panel`, null);
    while (readings.size > 64) readings.delete(readings.keys().next().value!);
    if (view === "panel" && enabled) setOwn(answer);
    setStored({ project: `${target}:${view}`, answer });
    setFailed(false);
  }, [view, enabled, setOwn]);

  const refresh = useCallback(async () => {
    try {
      settle(project, await fetchSeatTickSettings(project, undefined, view));
    } catch {
      /* Keep the last read-back; the control simply stops advancing and says
         so with its own tone. */
      setFailed(true);
    }
  }, [project, view, settle]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = () => {
      void fetchSeatTickSettings(project, controller.signal, view)
        .then((answer) => { if (!controller.signal.aborted) settle(project, answer); })
        .catch(() => {
          /* An abort is this effect being torn down, not the server failing. */
          if (!controller.signal.aborted) setFailed(true);
        });
    };
    load();
    const timer = setInterval(load, SEAT_TICK_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
      setOwn(null);
    };
  }, [project, enabled, view, settle, setOwn]);

  const write = useCallback(async (change: SeatTickChange): Promise<boolean> => {
    inFlight.current = true;
    setError(null);
    const only = (scope: string) => Object.keys(change).length > 0 && Object.keys(change).every((key) => key === scope);
    setErrorScope(only("turbo") ? "turbo" : Object.keys(change).length > 0 && Object.keys(change).every((key) => key === "autoRotate") ? "autoRotate" : Object.keys(change).length > 0 && Object.keys(change).every((key) => key === "maintenance") ? "maintenance" : "tick");
    const before = kept();
    if (before) setPending({ project: key, answer: optimistic(before, change) });
    try {
      const response = await fetch(`${SETTINGS_URL}${view === "summary" ? "?view=summary" : ""}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, ...change }),
      });
      if (!response.ok) {
        /* The server's own words, and only the server's: a refusal rewritten
           here is a rule this control would then own a second copy of. */
        setError((await readError(response)) ?? `the save was refused (${response.status})`);
        setPending(null);
        await refresh();
        return false;
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isAnswer(body)) {
        /* Accepted, unreadable: the write may well have landed, so nothing is
           sent again — the record is read instead. */
        setError("the save was accepted but its answer could not be read");
        setPending(null);
        await refresh();
        return false;
      }
      settle(project, body);
      setPending(null);
      return true;
    } catch {
      setError("the save got no answer; nothing more was sent");
      setPending(null);
      /* A lost reply proves nothing about the record, so the record is read
         rather than the write repeated. */
      await refresh();
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [project, key, view, kept, refresh, settle]);

  const save = useCallback((change: SeatTickChange): Promise<boolean> => {
    if (inFlight.current) return Promise.resolve(false);
    const done = write(change);
    flight.current = done;
    return done;
  }, [write]);

  const saveAfter = useCallback(async (build: (record: SeatTickSettingsAnswer) => SeatTickChange | null): Promise<boolean | null> => {
    /* A save that settles has already put its read-back in `readings`, so the
       record handed over is the one that write came back with. */
    while (inFlight.current) await flight.current;
    const record = kept();
    const change = record ? build(record) : null;
    return change ? save(change) : null;
  }, [kept, save]);

  return {
    project,
    answer: shown,
    record: current,
    failed,
    saving: pending !== null && pending.project === key,
    error,
    errorScope,
    refresh,
    save,
    saveAfter,
    clearError: useCallback(() => setError(null), []),
  };
}
