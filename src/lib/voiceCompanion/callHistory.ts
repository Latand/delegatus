import { reportHeaderName } from "@/lib/projects/settings";
import type { Locale } from "./contract";
import type { CompanionStorage, StoredSession } from "./storage";
import type { CompanionTranscriptRecords } from "./transcriptRecord";
import { callActions, type DerivedAction, type RetainedCall } from "./callHistoryTypes";
import { CALL_RETENTION_COUNT, callEndedAt } from "./retention";

/*
 * The owner's voice call history (GitHub #2975, `callHistoryTypes.ts`): each retained call and what it did, read
 * from the call journals. It carries names, states, reasons and links only; no words of the call, no request text,
 * no tool arguments or results and no report text, so a private part of a call adds nothing here that its record
 * does not already show without content.
 */

/* What each settled journal yielded, while its file is unchanged. Only this module reads or writes it; it holds at
   most twice the retained calls and drops the entry read longest ago. A call still held in memory is read afresh. */
const derived = new Map<string, { stamp: string; actions: DerivedAction[]; truncated: boolean }>();
const DERIVED_LIMIT = CALL_RETENTION_COUNT * 2;
function journal(records: CompanionTranscriptRecords, session: StoredSession): { actions: DerivedAction[]; truncated: boolean } | null {
  const stamp = records.stamp(session.id);
  const held = stamp ? derived.get(session.id) : undefined;
  if (held && held.stamp === stamp) return held;
  let record: ReturnType<CompanionTranscriptRecords["read"]>;
  try { record = records.read(session.id); } catch { derived.delete(session.id); return null; }
  // Every journal begins with its start entry: none at all is a record this Viewer cannot show.
  if (!record.entries.length) return null;
  const value = { actions: callActions(record.entries, session.createdAt), truncated: record.truncated };
  if (stamp) {
    derived.delete(session.id); derived.set(session.id, { stamp, ...value });
    for (const key of derived.keys()) { if (derived.size <= DERIVED_LIMIT) break; derived.delete(key); }
  }
  return value;
}

/** The retained calls `owns` admits, newest first; of calls started in the same millisecond, the one stored last. */
export function retainedCalls(storage: CompanionStorage, records: CompanionTranscriptRecords, owns: (session: StoredSession) => boolean,
  names: (project: string, locale: Locale) => string = reportHeaderName): RetainedCall[] {
  const known = new Map<string, string>();
  const name = (project: string, locale: Locale) => {
    const key = `${locale}\n${project}`;
    if (!known.has(key)) { let value = project; try { value = names(project, locale); } catch { /* the key stands for its name */ } known.set(key, value); }
    return known.get(key)!;
  };
  return Object.values(storage.read().sessions).filter(owns).reverse().sort((a, b) => b.createdAt - a.createdAt).map(session => {
    const read = journal(records, session);
    return { sessionId: session.id, startedAt: session.createdAt, endedAt: session.closed ? callEndedAt(session) : null, project: name(session.project, session.locale),
      live: !session.closed, truncated: read?.truncated ?? false,
      actions: read ? read.actions.map(({ projectKey, projectName, ...action }) => ({ ...action, project: projectName ?? (projectKey ? name(projectKey, session.locale) : null) })) : null };
  });
}
