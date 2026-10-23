/* Project keys inside transfer records (docs/design/install-memory-transfer.md
   §2.3). Both durable key shapes, `repo-<32 hex>` and `dir-<32 hex>`, are
   distinctive enough to be found anywhere in a record: in a row key
   (`s:role:<key>:builder`, `binding:codex:a:<key>`), in a field
   (`source.project`) or in a JSON-encoded row key (`["<key>","uk"]`). One
   rewrite over the record's text therefore remaps every store the same way,
   and no store needs a remap of its own that could drift from its schema. */

export const PROJECT_KEY_PATTERN = /\b(?:repo|dir)-[0-9a-f]{32}\b/g;

export function projectKeysIn(text: string): string[] {
  return [...new Set(text.match(PROJECT_KEY_PATTERN) ?? [])];
}

/** The text with every project key replaced through `map`; keys the map does not name stay. */
export function remapText(text: string, map: (key: string) => string): string {
  return text.replace(PROJECT_KEY_PATTERN, key => map(key));
}

/** A JSON value with every project key replaced through `map`. */
export function remapValue<T>(value: T, map: (key: string) => string): T {
  if (value === undefined) return value;
  const text = JSON.stringify(value);
  const next = remapText(text, map);
  return next === text ? value : JSON.parse(next) as T;
}

/** Follow an alias chain to its end; a cycle resolves to the start. */
export function resolveAliasChain(project: string, aliases: Readonly<Record<string, string>>): string {
  let current = project;
  const seen = new Set<string>();
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current]!;
  }
  return seen.has(current) ? project : current;
}
