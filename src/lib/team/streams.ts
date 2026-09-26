import type { NextRequest } from "next/server";

import { teamActor } from "./actor";
import { requestSession, sessionIsLive } from "./sessions";
import { existingTeamStore } from "./store";

/*
 * An event stream a member opened ends with the member's session (§9). The
 * identity gate runs once, when the connection opens; a live transcript or
 * runtime stream can then stay open for hours. This re-reads the session row
 * every `STREAM_SESSION_RECHECK_MS` and closes the stream once the session is
 * revoked, expired or idle, or its member is no longer active. The browser's
 * reconnect then meets the gate, which asks for a sign-in.
 *
 * Only a stream opened on a member session is watched. An agent, a Viewer
 * service, a bearer read and a solo install get the source stream untouched.
 */

export const STREAM_SESSION_RECHECK_MS = 30_000;

type StreamRequest = Pick<NextRequest, "headers" | "cookies">;

function watchedSessionId(req: StreamRequest): string | null {
  try {
    if (teamActor(req).kind !== "member") return null;
    return requestSession(req)?.session.id ?? null;
  } catch {
    return null;
  }
}

/** Whether the session is still live. An unreadable store answers no: the
    stream closes and the reconnect is judged by the gate, which fails closed. */
export function streamSessionLive(sessionId: string, nowMs = Date.now()): boolean {
  try {
    const store = existingTeamStore();
    if (!store) return false;
    const session = store.session(sessionId);
    if (!session || !sessionIsLive(session, nowMs)) return false;
    return store.member(session.memberId)?.status === "active";
  } catch {
    return false;
  }
}

export function sessionBoundStream(
  req: StreamRequest,
  signal: AbortSignal,
  open: (signal: AbortSignal) => ReadableStream<Uint8Array>,
  recheckMs = STREAM_SESSION_RECHECK_MS,
): ReadableStream<Uint8Array> {
  const sessionId = watchedSessionId(req);
  if (!sessionId) return open(signal);

  const ended = new AbortController();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    signal.removeEventListener("abort", forward);
  };
  /* The client went away: nothing is left to watch. */
  const forward = () => {
    stop();
    ended.abort();
  };
  if (signal.aborted) ended.abort();
  else signal.addEventListener("abort", forward, { once: true });
  const reader = open(ended.signal).getReader();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (ended.signal.aborted) return;
      timer = setInterval(() => {
        if (streamSessionLive(sessionId)) return;
        stop();
        ended.abort();
        reader.cancel().catch(() => undefined);
        try { controller.close(); } catch { /* already closed */ }
      }, recheckMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stop();
          try { controller.close(); } catch { /* the session check closed it */ }
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        stop();
        try { controller.error(error); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      stop();
      ended.abort();
      return reader.cancel(reason);
    },
  });
}
