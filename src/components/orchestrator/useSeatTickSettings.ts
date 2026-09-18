"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";

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
  untilMinutes?: number | null;
}

export interface SeatTickSettingsRead {
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
  refresh: () => Promise<void>;
  /** True when the record now holds the change. */
  save: (change: SeatTickChange) => Promise<boolean>;
  clearError: () => void;
}

/** Every answer this tab has read, keyed by project, so a chip and the sheet
    that opens over it show one reading instead of racing two. */
const readings = new Map<string, SeatTickSettingsAnswer>();

export function resetSeatTickSettingsCacheForTests(): void {
  readings.clear();
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

export async function fetchSeatTickSettings(project: string, signal?: AbortSignal): Promise<SeatTickSettingsAnswer> {
  const response = await fetch(`${SETTINGS_URL}?project=${encodeURIComponent(project)}`, {
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
  return {
    ...answer,
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

export function useSeatTickSettings(project: string, enabled: boolean): SeatTickSettingsRead {
  const [stored, setStored] = useState<{ project: string; answer: SeatTickSettingsAnswer } | null>(
    () => {
      const cached = readings.get(project);
      return cached ? { project, answer: cached } : null;
    },
  );
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<{ project: string; answer: SeatTickSettingsAnswer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* One save at a time: two in flight would race to decide which read-back is
     the record, and the loser would put a superseded reading on screen. */
  const inFlight = useRef(false);

  /* Answers carry the project they answered for, so a project switch drops the
     previous project's reading HERE, in render — never a frame of another
     project's schedule under this project's name. */
  const current = stored && stored.project === project ? stored.answer : readings.get(project) ?? null;
  const shown = pending && pending.project === project ? pending.answer : current;

  const settle = useCallback((target: string, answer: SeatTickSettingsAnswer) => {
    readings.set(target, answer);
    setStored({ project: target, answer });
    setFailed(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      settle(project, await fetchSeatTickSettings(project));
    } catch {
      /* Keep the last read-back; the control simply stops advancing and says
         so with its own tone. */
      setFailed(true);
    }
  }, [project, settle]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = () => {
      void fetchSeatTickSettings(project, controller.signal)
        .then((answer) => settle(project, answer))
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
    };
  }, [project, enabled, settle]);

  const save = useCallback(async (change: SeatTickChange): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setError(null);
    const before = readings.get(project) ?? null;
    if (before) setPending({ project, answer: optimistic(before, change) });
    try {
      const response = await fetch(SETTINGS_URL, {
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
  }, [project, refresh, settle]);

  return {
    answer: shown,
    record: current,
    failed,
    saving: pending !== null && pending.project === project,
    error,
    refresh,
    save,
    clearError: useCallback(() => setError(null), []),
  };
}
