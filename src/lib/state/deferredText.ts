/** A cached record keeps its structure and short values. Each string longer
 * than the bound becomes a read-through property that takes its text from the
 * stored row on access, so the cache holds no long text. Enumeration, JSON
 * serialization and structured cloning still see the complete record. */

type Path = readonly (string | number)[];

function textAt(root: unknown, path: Path): string | undefined {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return typeof value === "string" ? value : undefined;
}

/** Rewrites `record` in place and freezes it. `source` returns the complete
 * decoded row the record was built from; `changed` reports a row that no
 * longer holds the text. Returns the UTF-16 bytes the record stops holding. */
export function deferLongText(record: unknown, minLength: number, source: () => unknown, changed: () => never): number {
  let released = 0;
  const visit = (node: unknown, path: Path): void => {
    if (!node || typeof node !== "object" || Object.isFrozen(node)) return;
    for (const key of Object.keys(node)) {
      const value = (node as Record<string, unknown>)[key];
      const at = [...path, Array.isArray(node) ? Number(key) : key];
      if (typeof value === "string" && value.length > minLength) {
        released += value.length * 2;
        Object.defineProperty(node, key, { enumerable: true, configurable: false,
          get: () => textAt(source(), at) ?? changed() });
      } else visit(value, at);
    }
    Object.freeze(node);
  };
  visit(record, []);
  return released;
}
