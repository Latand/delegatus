/** A cached record keeps its structure and short values. Each string longer
 * than the bound becomes a read-through property that takes its text from the
 * stored row on access, so the cache holds no long text. Enumeration, JSON
 * serialization and structured cloning still see the complete record. */

type Path = readonly (string | number)[];

/** Heap one deferred string costs beyond the record's own bytes: its
 * accessor, the closure and the path it keeps. Measured on a production-shaped
 * archive at about 191 bytes each. */
export const DEFERRED_TEXT_ACCESSOR_BYTES = 192;

function textAt(root: unknown, path: Path): string | undefined {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return typeof value === "string" ? value : undefined;
}

export type DeferredTextSource = {
  /** The complete decoded row the record was built from. Throws once that
   * row was rewritten, removed or its database replaced. */
  built(): unknown;
  /** The complete decoded row as stored now, for serialization of a record
   * whose own version is gone. Throws when no such row exists. */
  current(): unknown;
  /** Whether an error of `built` means the record's version is gone. */
  moved(error: unknown): boolean;
};

/** Rewrites `record` in place and freezes it. Returns the UTF-16 bytes the
 * record stops holding and the number of strings it defers.
 *
 * A text read needs the row version the record was built from; `built`
 * refuses any other, so a record never mixes its values with a later
 * version's text. `JSON.stringify` of the record goes through `toJSON`, which
 * serializes the complete row in one read: the built version, or the current
 * row whole once the built version is gone. */
export function deferLongText(record: unknown, minLength: number, source: DeferredTextSource): { released: number; deferred: number } {
  let released = 0, deferred = 0;
  const visit = (node: unknown, path: Path): void => {
    if (!node || typeof node !== "object" || Object.isFrozen(node)) return;
    for (const key of Object.keys(node)) {
      const value = (node as Record<string, unknown>)[key];
      const at = [...path, Array.isArray(node) ? Number(key) : key];
      if (typeof value === "string" && value.length > minLength) {
        released += value.length * 2;
        deferred += 1;
        Object.defineProperty(node, key, { enumerable: true, configurable: false, get: () => {
          const text = textAt(source.built(), at);
          if (text === undefined) throw new Error("deferred text is missing from its row version");
          return text;
        } });
      } else visit(value, at);
    }
    if (path.length === 0 && deferred > 0 && !Array.isArray(node) && !Object.hasOwn(node, "toJSON")) {
      Object.defineProperty(node, "toJSON", { enumerable: false, configurable: false, writable: false, value: () => {
        try { return source.built(); }
        catch (error) { if (!source.moved(error)) throw error; return source.current(); }
      } });
    }
    Object.freeze(node);
  };
  visit(record, []);
  return { released, deferred };
}
