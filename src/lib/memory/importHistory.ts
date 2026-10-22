import { canonicalProject } from "@/lib/projects/aliases";
import { statePath } from "@/lib/configDir";
import { openCurrentDatabase } from "@/lib/state/currentDatabase";
import { candidateState } from "./importCuration";
import type { ImportCandidate } from "./importTypes";

/** Worker-only history lookup. An identical hash must also retain the same
 * applicability and anchor; undo re-pending always defeats the shortcut. */
export function inheritImportDispositions(candidate: ImportCandidate, options: { byContent?: boolean; sameImport?: boolean } = {}) {
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = openCurrentDatabase(statePath("state.sqlite"), () => new sqlite.Database(statePath("state.sqlite"), { readonly: true, strict: true }));
  try {
    const rows = db.query<{ value_json: string }, [string, number, string]>(`SELECT value_json FROM state_rows
      WHERE collection='role_memory_import' AND row_key LIKE 'c:%'
      AND json_extract(value_json,'$.contentSha256')=? AND (? OR json_extract(value_json,'$.importId')<>?)`)
      .iterate(candidate.contentSha256, options.sameImport ? 1 : 0, candidate.importId);
    for (const item of rows) {
      const prior = JSON.parse(item.value_json) as ImportCandidate;
      if (prior.part.index !== candidate.part.index || prior.anchor !== candidate.anchor || candidateState(prior).state === "pending") continue;
      for (const occurrence of candidate.occurrences) {
        // The sync (§4.9) matches on normalized content, which the query already fixed; the import, on the whole file.
        const old = prior.occurrences.find(o => (options.byContent || o.sha256 === occurrence.sha256) && (o.project ? canonicalProject(o.project) : null) === (occurrence.project ? canonicalProject(occurrence.project) : null) && o.type === occurrence.type && o.writer.kind === occurrence.writer.kind && o.writer.roleId === occurrence.writer.roleId);
        if (!old || candidate.dispositions.some(d => d.occurrences.includes(occurrence.id))) continue;
        const disposition = prior.dispositions.findLast(d => d.occurrences.includes(old.id));
        if (disposition) candidate.dispositions.push({ ...disposition, occurrences: [occurrence.id] });
      }
    }
  } finally { db.close(); }
}
