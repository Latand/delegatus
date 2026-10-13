import type { StoredSession } from "./storage";

export const CALL_RETENTION_COUNT = 50;
export const CALL_RETENTION_MS = 30 * 86400_000;
export function callEndedAt(session: StoredSession): number {
  const closed = session.events.findLast(event => event.type === "session.closed");
  return session.endedAt ?? (closed ? session.createdAt + closed.atMs : session.createdAt);
}
export const safelyClosed = (session: StoredSession) => session.closed && !session.remoteOpen && !session.mintUncertain;
