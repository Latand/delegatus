"use client";

import { createContext, useContext, useEffect, useState } from "react";

import type { Locale, TFunction } from "@/lib/i18n";

import { getRuntimeBus, isRuntimeUiEnabled } from "./runtimeBus";
import { useRuntimeSelector } from "./useRuntime";

function streamLastEvent(): number | null {
  if (typeof window === "undefined" || !isRuntimeUiEnabled()) return null;
  return getRuntimeBus().getState().lastEventAt ?? null;
}

/*
 * Can this tab reach the server right now (#2071,
 * docs/design/skeletons-and-transitions.md D7)?
 *
 * One derived state, from what the tab already watches: the runtime stream's
 * connection and the `/api/files` failure streak. No request is added. A
 * deploy restarts the server for tens of seconds; during that window the
 * board keeps what it last had and says, quietly, that it is reconnecting.
 * Only a long outage turns loud.
 *
 * - `ok`: no files read is failing, and the stream is live, off, or
 *   `degraded`. Degraded is the stream's healthy fallback: it polls the
 *   snapshot every ten seconds, so the data on screen is fresh and saying
 *   otherwise would be false for as long as SSE stays blocked (a proxy).
 * - `reconnecting`: a files read failed while less than a minute has passed
 *   since the first failure, or the stream has been `reconnecting` for more
 *   than two seconds (the floor keeps a one-off blip from drawing anything).
 * - `offline`: a minute or more of failures, or the stream says offline; the
 *   stream's own `OFFLINE_AFTER_MS`.
 *
 * The time a reconnecting line shows is the last good answer: the last files
 * success for a files streak, the stream's last event for a stream outage.
 */

export const RECONNECT_FLOOR_MS = 2_000;
export const OFFLINE_AFTER_MS = 60_000;

export type ServerReachKind = "ok" | "reconnecting" | "offline";

export interface ServerReach {
  kind: ServerReachKind;
  /** Epoch ms of the last good answer the screen still shows, when known. */
  lastGoodAt: number | null;
}

export const SERVER_REACH_OK: ServerReach = { kind: "ok", lastGoodAt: null };

export interface ServerReachInput {
  /** The runtime stream's connection, or "live" when the stream is off. */
  connection: "live" | "reconnecting" | "degraded" | "offline";
  /** When the stream left "live", or null while it is live. */
  streamDownSince: number | null;
  /** The stream's last event or heartbeat before it went down, when known. */
  streamLastEventAt: number | null;
  /** The files failure streak's first failure, or null while reads answer. */
  filesFailingSince: number | null;
  /** The last good files answer, when known. */
  filesLastSuccessAt: number | null;
  now: number;
}

export function deriveServerReach(input: ServerReachInput): ServerReach {
  const { connection, streamDownSince, streamLastEventAt, filesFailingSince, filesLastSuccessAt, now } = input;
  const lastGoodAt = filesFailingSince !== null ? filesLastSuccessAt : streamLastEventAt;
  if (connection === "offline") return { kind: "offline", lastGoodAt };
  if (filesFailingSince !== null) {
    return { kind: now - filesFailingSince >= OFFLINE_AFTER_MS ? "offline" : "reconnecting", lastGoodAt };
  }
  if (connection === "reconnecting" && streamDownSince !== null && now - streamDownSince >= RECONNECT_FLOOR_MS) {
    return { kind: "reconnecting", lastGoodAt };
  }
  return SERVER_REACH_OK;
}

/** The next moment the derived state can change without any input changing:
    the stream crossing the floor, or the files streak crossing a minute. */
export function nextReachBoundary(input: ServerReachInput): number | null {
  const { connection, streamDownSince, filesFailingSince, now } = input;
  const candidates: number[] = [];
  if (filesFailingSince !== null && now - filesFailingSince < OFFLINE_AFTER_MS) candidates.push(filesFailingSince + OFFLINE_AFTER_MS);
  if (connection === "reconnecting" && streamDownSince !== null && now - streamDownSince < RECONNECT_FLOOR_MS) {
    candidates.push(streamDownSince + RECONNECT_FLOOR_MS);
  }
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * The Viewer's one reading of the reach, from the files answer it already
 * holds and the stream connection. Re-renders only when the state changes:
 * the stream is read through a primitive selector, and the thresholds are
 * met by one timer, not a clock.
 */
export function useDerivedServerReach(files: { catalogFailures: number; failingSince?: number; lastSuccessAt?: number | null }): ServerReach {
  const connection = useRuntimeSelector<ServerReachInput["connection"]>((state) => (state.enabled ? state.connection : "live"), "live");
  /* When the stream went down, and its last event before that. Read once at
     the transition, so a stream event never re-renders the Viewer. */
  const [streamDown, setStreamDown] = useState<{ since: number; lastEventAt: number | null } | null>(null);
  const down = connection === "reconnecting";
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setStreamDown((current) => (down ? current ?? { since: Date.now(), lastEventAt: streamLastEvent() } : null));
  }, [down]);
  const streamDownSince = streamDown?.since ?? null;
  const filesFailingSince = files.catalogFailures > 0 ? files.failingSince ?? null : null;
  const [now, setNow] = useState(() => Date.now());
  const input: ServerReachInput = { connection, streamDownSince, streamLastEventAt: streamDown?.lastEventAt ?? null, filesFailingSince, filesLastSuccessAt: files.lastSuccessAt ?? null, now };
  const boundary = nextReachBoundary(input);
  useEffect(() => {
    if (boundary === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, boundary - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [boundary]);
  const reach = deriveServerReach({ ...input, now: Math.max(now, filesFailingSince ?? 0, streamDownSince ?? 0) });
  return useStableReach(reach);
}

function useStableReach(reach: ServerReach): ServerReach {
  const [held, setHeld] = useState(reach);
  if (held.kind !== reach.kind || held.lastGoodAt !== reach.lastGoodAt) {
    setHeld(reach);
    return reach;
  }
  return held;
}

/** «reconnecting · showing 14:02», or «reconnecting…» with no known time.
    The clock is the one the phone banner uses. */
export function reachLineText(t: TFunction, locale: Locale, reach: ServerReach): string {
  let time = "";
  if (reach.lastGoodAt) {
    try {
      time = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(reach.lastGoodAt));
    } catch {
      time = "";
    }
  }
  return time ? t("reach.reconnecting", { time }) : t("reach.reconnectingShort");
}

const ServerReachContext = createContext<ServerReach>(SERVER_REACH_OK);

export const ServerReachProvider = ServerReachContext.Provider;

/** The reach the Viewer derived; `ok` outside it (tests, isolated mounts). */
export function useServerReach(): ServerReach {
  return useContext(ServerReachContext);
}
