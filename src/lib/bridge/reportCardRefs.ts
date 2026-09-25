/*
 * Which card ids a report body names (#2146). Pure, so the report log's read
 * and the evidence fixtures resolve cards the same way.
 */

export interface ReportLogCard {
  id: string;
  kind: "pipeline" | "task";
}

/** Ids a body can name: a word made of letters, digits, dots, dashes and underscores. */
const ID_TOKEN = /[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]|[A-Za-z0-9]/g;

/** The known card ids a body names, each once, in the order they appear. */
export function reportCardRefs(body: string, known: ReadonlyMap<string, ReportLogCard["kind"]>): ReportLogCard[] {
  const found = new Map<string, ReportLogCard>();
  if (known.size === 0) return [];
  for (const match of body.matchAll(ID_TOKEN)) {
    const kind = known.get(match[0]);
    if (kind && !found.has(match[0])) found.set(match[0], { id: match[0], kind });
  }
  return [...found.values()];
}
