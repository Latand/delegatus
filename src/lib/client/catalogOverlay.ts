import type { FileEntry } from "@/lib/types";

/**
 * A runtime overlay replaces single rows of an admitted catalog and keeps every
 * position (docs/design/composer-session-isolation.md, "Where the array goes").
 * Whoever makes such an array says which positions it replaced, so a reader of
 * the previous array can follow by index instead of reading the catalog again.
 */
const replacements = new WeakMap<readonly FileEntry[], { from: readonly FileEntry[]; positions: readonly number[] }>();

/** How many publications a reader may skip before it reads the catalog again. A
 * record holds the array it came from, so this also bounds what stays alive. */
export const REPLACEMENT_LINEAGE = 8;

export function recordReplacedRows(from: readonly FileEntry[], next: readonly FileEntry[], positions: readonly number[]): void {
  if (from === next) return;
  replacements.set(next, { from, positions });
  let node: readonly FileEntry[] = next;
  for (let step = 0; step < REPLACEMENT_LINEAGE; step++) {
    const record = replacements.get(node);
    if (!record) return;
    node = record.from;
  }
  replacements.delete(node);
}

/** The facts membership and identity readings use. */
function sameIdentity(a: FileEntry, b: FileEntry): boolean {
  return a.path === b.path && a.conversationId === b.conversationId && a.project === b.project
    && a.migratedTo === b.migratedTo && a.generation === b.generation;
}

/** The positions at which `next` replaced a row of `previous`, or null when
 * `next` has to be read in full: another admission, another order or a row whose
 * identity changed. */
export function replacedRows(previous: readonly FileEntry[], next: readonly FileEntry[]): readonly number[] | null {
  if (previous === next) return [];
  const positions = new Set<number>();
  let node = next;
  for (let step = 0; node !== previous; step++) {
    const record = step < REPLACEMENT_LINEAGE ? replacements.get(node) : undefined;
    if (!record) return null;
    for (const position of record.positions) positions.add(position);
    node = record.from;
  }
  if (previous.length !== next.length) return null;
  for (const position of positions) if (!sameIdentity(previous[position]!, next[position]!)) return null;
  return [...positions];
}

/**
 * An ordered subset of a catalog (its visible generations, one project) that
 * costs the rows an overlay replaced. `select` answers the full read; it must
 * return rows of its input, in the input's order.
 */
export function createCatalogSelection(select: (rows: FileEntry[]) => FileEntry[]): (source: FileEntry[]) => FileEntry[] {
  let held: { source: FileEntry[]; selected: FileEntry[]; at: Map<number, number> } | undefined;
  return (source) => {
    const replaced = held && replacedRows(held.source, source);
    if (held && replaced) {
      /* A selection that was the catalog itself stays the catalog itself. */
      if (held.selected === held.source) {
        held = { source, selected: source, at: held.at };
        return source;
      }
      let selected = held.selected;
      const changed: number[] = [];
      for (const position of replaced) {
        const index = held.at.get(position);
        if (index === undefined) continue;
        const row = source[position]!;
        if (selected[index] === row) continue;
        if (selected === held.selected) selected = selected.slice();
        selected[index] = row;
        changed.push(index);
      }
      recordReplacedRows(held.selected, selected, changed);
      held = { source, selected, at: held.at };
      return selected;
    }
    const answer = select(source);
    /* An equal answer keeps the array its reader already holds. */
    const selected = held && held.selected.length === answer.length && answer.every((row, index) => row === held!.selected[index])
      ? held.selected : answer;
    const at = new Map<number, number>();
    for (let position = 0, index = 0; position < source.length && index < selected.length; position++) {
      if (source[position] === selected[index]) at.set(position, index++);
    }
    held = { source, selected, at };
    return selected;
  };
}

/** A reading of identity facts alone (which conversations a project holds)
 * stands while a catalog's rows are only replaced. */
export function createCatalogReading<T>(read: (rows: FileEntry[]) => T): (source: FileEntry[]) => T {
  let held: { source: FileEntry[]; value: T } | undefined;
  return (source) => {
    const value = held && replacedRows(held.source, source) ? held.value : read(source);
    held = { source, value };
    return value;
  };
}
