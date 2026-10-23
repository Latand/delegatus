import { canonicalProject } from "@/lib/projects/aliases";
import { statePath } from "@/lib/configDir";
import { openCurrentDatabase } from "@/lib/state/currentDatabase";
import { candidateState } from "./importCuration";
import type { ImportCandidate } from "./importTypes";

type HistoryOptions = { byContent?: boolean; sameImport?: boolean };

/** Worker-only history lookup, outside the write lock: the keys of stored
 * candidates of equal content and part. The curator changes dispositions only,
 * never content, so the write rereads exactly these rows by key. */
export function importHistoryKeys(candidates: readonly ImportCandidate[], options: HistoryOptions = {}): Map<string, string[]> {
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = openCurrentDatabase(statePath("state.sqlite"), () => new sqlite.Database(statePath("state.sqlite"), { readonly: true, strict: true }));
  try {
    const query = db.query<{ row_key: string; part: number; anchor: string }, [string, number, string]>(`SELECT row_key,
      json_extract(value_json,'$.part.index') AS part, json_extract(value_json,'$.anchor') AS anchor FROM state_rows
      WHERE collection='role_memory_import' AND row_key LIKE 'c:%'
      AND json_extract(value_json,'$.contentSha256')=? AND (? OR json_extract(value_json,'$.importId')<>?)`);
    return new Map(candidates.map(candidate => [candidate.id, query.all(candidate.contentSha256, options.sameImport ? 1 : 0, candidate.importId)
      .filter(row => row.part === candidate.part.index && row.anchor === candidate.anchor).map(row => row.row_key)]));
  } finally { db.close(); }
}

/** An identical hash must also retain the same applicability and anchor; undo
 * re-pending always defeats the shortcut. `priors` are the rows as committed
 * when the candidate is written, so an outcome the curator committed meanwhile
 * covers it. `occurrences` limits it to the occurrences that write adds. Each
 * copy names the candidate whose curator outcome it repeats, so a report counts
 * that outcome once. */
export function inheritImportDispositions(candidate: ImportCandidate, priors: readonly ImportCandidate[], options: HistoryOptions & { occurrences?: ReadonlySet<string> } = {}) {
  for (const prior of priors) {
    if (prior.contentSha256 !== candidate.contentSha256 || prior.part.index !== candidate.part.index || prior.anchor !== candidate.anchor
      || (!options.sameImport && prior.importId === candidate.importId) || candidateState(prior).state === "pending") continue;
    for (const occurrence of candidate.occurrences) {
      if (options.occurrences && !options.occurrences.has(occurrence.id)) continue;
      // The sync (§4.9) matches on normalized content, which the hash already fixed; the import, on the whole file.
      const old = prior.occurrences.find(o => (options.byContent || o.sha256 === occurrence.sha256) && (o.project ? canonicalProject(o.project) : null) === (occurrence.project ? canonicalProject(occurrence.project) : null) && o.type === occurrence.type && o.writer.kind === occurrence.writer.kind && o.writer.roleId === occurrence.writer.roleId);
      if (!old || candidate.dispositions.some(d => d.occurrences.includes(occurrence.id))) continue;
      const disposition = prior.dispositions.findLast(d => d.occurrences.includes(old.id));
      if (disposition) candidate.dispositions.push({ ...disposition, occurrences: [occurrence.id], inheritedFrom: disposition.inheritedFrom ?? prior.id });
    }
  }
}
