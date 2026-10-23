import { reportHeaderName } from "@/lib/projects/settings";
import type { Locale } from "./contract";
import type { CompanionStorage, StoredSession } from "./storage";
import type { CompanionTranscriptRecords } from "./transcriptRecord";
import { callActions, type DerivedAction, type RetainedCall } from "./callHistoryTypes";
import { CALL_RETENTION_COUNT, callEndedAt } from "./retention";
import { CHAIN_LIMIT } from "./callResume";

/*
 * The owner's voice call history (GitHub #2975, `callHistoryTypes.ts`): each retained call and what it did, read
 * from the call journals. It carries names, states, reasons and links only; no words of the call, no request text,
 * no tool arguments or results and no report text, so a private part of a call adds nothing here that its record
 * does not already show without content.
 */

/* What each settled journal yielded, while its file is unchanged. Only this module reads or writes it; it holds at
   most twice the retained calls and drops the entry read longest ago. A call still held in memory is read afresh. */
type Part = { actions: DerivedAction[]; truncated: boolean; resumes: string | null };
const derived = new Map<string, Part & { stamp: string }>();
const DERIVED_LIMIT = CALL_RETENTION_COUNT * 2;
function journal(records: CompanionTranscriptRecords, session: StoredSession): Part | null {
  const stamp = records.stamp(session.id);
  const held = stamp ? derived.get(session.id) : undefined;
  if (held && held.stamp === stamp) return held;
  let record: ReturnType<CompanionTranscriptRecords["read"]>;
  try { record = records.read(session.id); } catch { derived.delete(session.id); return null; }
  // Every journal begins with its start entry: none at all is a record this Viewer cannot show.
  if (!record.entries.length) return null;
  const resumes = record.entries.find(entry => entry.kind === "session_start")?.data.resumes;
  const value = { actions: callActions(record.entries, session.createdAt), truncated: record.truncated, resumes: typeof resumes === "string" ? resumes : null };
  if (stamp) {
    derived.delete(session.id); derived.set(session.id, { stamp, ...value });
    for (const key of derived.keys()) { if (derived.size <= DERIVED_LIMIT) break; derived.delete(key); }
  }
  return value;
}

/** Calls whose state row is gone but whose journal records who started them (`CompanionTranscriptRecords.sessions`,
 * read only for ids the state does not hold). A journal that names no owner, or cannot be read, proves no owner and
 * is left out. */
function journalOnly(records: CompanionTranscriptRecords, known: Record<string, StoredSession>): StoredSession[] {
  return records.ids().filter(id => !known[id]).flatMap(id => {
    try { const session = records.journalSession(id); return session ? [session] : []; } catch { return []; }
  });
}

/** The retained calls `owns` admits, newest first; of calls started in the same millisecond, the one stored last.
 * A call that dropped and was resumed is one row across its parts, as its record is (`callResume.ts`): the row is the
 * last part, which the session route opens with the whole call, from the first part's start. Each earlier part's
 * action ids carry its part's id, as the record's rows do. */
export function retainedCalls(storage: CompanionStorage, records: CompanionTranscriptRecords, owns: (session: StoredSession) => boolean,
  names: (project: string, locale: Locale) => string = reportHeaderName): RetainedCall[] {
  const stored = storage.read().sessions;
  const known = new Map<string, string>();
  const name = (project: string, locale: Locale) => {
    const key = `${locale}\n${project}`;
    if (!known.has(key)) { let value = project; try { value = names(project, locale); } catch { /* the key stands for its name */ } known.set(key, value); }
    return known.get(key)!;
  };
  const owned = [...journalOnly(records, stored), ...Object.values(stored)].filter(owns).reverse().sort((a, b) => b.createdAt - a.createdAt);
  const parts = new Map(owned.map(session => [session.id, { session, read: journal(records, session) }]));
  /* A part another owned part continues stands inside that call. */
  const continued = new Set([...parts.values()].flatMap(({ session, read }) => read?.resumes && read.resumes !== session.id && parts.has(read.resumes) ? [read.resumes] : []));
  return owned.filter(session => !continued.has(session.id)).map(session => {
    const chain = [parts.get(session.id)!];
    /* The walk `callChain` takes: back through owned, readable parts, each once, up to its limit. */
    for (let previous = chain[0]!.read?.resumes; previous && chain.length < CHAIN_LIMIT;) {
      const part = parts.get(previous);
      if (!part?.read || chain.some(row => row.session.id === previous)) break;
      chain.unshift(part);
      previous = part.read.resumes;
    }
    const first = chain[0]!.session;
    const read = chain.at(-1)!.read;
    const actions = read ? chain.flatMap(({ session: part, read: each }) => {
      const prefix = part.id === session.id ? "" : `${part.id}.`;
      return each!.actions.map(({ projectKey, projectName, ...action }) => ({ ...action, id: prefix + action.id, requestId: action.requestId === null ? null : prefix + action.requestId,
        project: projectName ?? (projectKey ? name(projectKey, part.locale) : null) }));
    }) : null;
    return { sessionId: session.id, startedAt: first.createdAt, endedAt: session.closed ? callEndedAt(session) : null, project: name(first.project, first.locale),
      live: !session.closed, truncated: chain.some(row => row.read?.truncated), actions };
  });
}
