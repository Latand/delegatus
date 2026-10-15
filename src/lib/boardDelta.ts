/** Versioned, structural patches for the complete board summary. No server imports. */
export const BOARD_PROTOCOL_HEADER = "x-llv-board-protocol";
export const BOARD_SCOPE_HEADER = "x-llv-board-scope";

type RecordValue = Record<string, unknown>;
type Key = string | number;
export type BoardChange =
  | { replace: unknown }
  | { object: Array<[string, BoardChange]>; remove: string[] }
  | { array: Array<[Key, BoardChange]>; key: string; count: number; order?: Array<Key | [number, number]> };
export interface BoardDelta { v: 2; base: string; etag: string; change?: BoardChange }

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(rows: unknown[], key: string): Key[] | undefined {
  const result: Key[] = [];
  const seen = new Set<Key>();
  for (const row of rows) {
    const id = object(row) && Object.hasOwn(row, key) ? row[key] : undefined;
    if ((typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id))) || seen.has(id as Key)) return;
    seen.add(id as Key);
    result.push(id as Key);
  }
  return result;
}

/** Stable identities are checked on both sides. Ambiguous arrays travel whole.
 * In particular a run's attempts use n; their containing run uses stageId. */
function arrayKey(before: unknown[], after: unknown[]): string | undefined {
  for (const key of ["path", "id", "project", "stageId", "n"]) {
    if ((before.length || after.length) && keys(before, key) && keys(after, key)) return key;
  }
}

/** Inputs are JSON values. Comparisons never stringify retained reports/scaffolds. */
export function diffBoardValue(before: unknown, after: unknown): BoardChange | undefined {
  if (before === after) return;
  if (object(before) && object(after)) {
    const changes: Array<[string, BoardChange]> = [];
    const remove = Object.keys(before).filter(key => !Object.hasOwn(after, key));
    for (const [key, value] of Object.entries(after)) {
      const change = Object.hasOwn(before, key) ? diffBoardValue(before[key], value) : { replace: value };
      if (change) changes.push([key, change]);
    }
    return changes.length || remove.length ? { object: changes, remove } : undefined;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const key = arrayKey(before, after);
    if (key) {
      const baseKeys = keys(before, key)!;
      const order = keys(after, key)!;
      const previous = new Map(baseKeys.map((id, i) => [id, before[i]]));
      const changes: Array<[Key, BoardChange]> = [];
      after.forEach((value, i) => {
        const id = order[i];
        const change = previous.has(id) ? diffBoardValue(previous.get(id), value) : { replace: value };
        if (change) changes.push([id, change]);
      });
      if (!changes.length && baseKeys.length === order.length && baseKeys.every((id, i) => id === order[i])) return;
      const sameOrder = baseKeys.length === order.length && baseKeys.every((id, i) => id === order[i]);
      const positions = new Map(baseKeys.map((id, i) => [id, i]));
      const compact: Array<Key | [number, number]> = [];
      for (const id of order) {
        const index = positions.get(id);
        const last = compact.at(-1);
        if (index === undefined) compact.push(id);
        else if (Array.isArray(last) && last[0] + last[1] === index) last[1]++;
        else compact.push([index, 1]);
      }
      return { array: changes, key, count: before.length, ...(sameOrder ? {} : { order: compact }) };
    }
    if (before.length === after.length && before.every((value, i) => !diffBoardValue(value, after[i]))) return;
  }
  return { replace: after };
}

function own(target: RecordValue, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Applies into new containers, keeping every untouched subtree by reference.
 * A refusal leaves the caller's certified base and optimistic edits intact. */
function apply(before: unknown, change: BoardChange): unknown {
  if (!object(change)) throw new Error("invalid board patch");
  if (Object.hasOwn(change, "replace")) return (change as { replace: unknown }).replace;
  if ("object" in change) {
    if (!object(before) || !Array.isArray(change.object) || !Array.isArray(change.remove)) throw new Error("board object base mismatch");
    const next = { ...before };
    const seen = new Set<string>();
    for (const key of change.remove) {
      if (typeof key !== "string" || !Object.hasOwn(before, key) || seen.has(key)) throw new Error("board removal mismatch");
      seen.add(key);
      delete next[key];
    }
    for (const [key, patch] of change.object) {
      if (typeof key !== "string" || seen.has(key) || (!Object.hasOwn(before, key) && !Object.hasOwn(patch, "replace"))) throw new Error("board field mismatch");
      seen.add(key);
      own(next, key, apply(Object.hasOwn(before, key) ? before[key] : undefined, patch));
    }
    return next;
  }
  if (!("array" in change) || !Array.isArray(before) || !Number.isSafeInteger(change.count) || (change.order !== undefined && !Array.isArray(change.order)) || !Array.isArray(change.array)) throw new Error("board array base mismatch");
  const ids = keys(before, change.key);
  if (!ids || ids.length !== change.count) throw new Error("board array identity mismatch");
  const rows = new Map(ids.map((id, i) => [id, before[i]]));
  const changed = new Set<Key>();
  for (const [id, patch] of change.array) {
    if (changed.has(id) || (!rows.has(id) && !Object.hasOwn(patch, "replace"))) throw new Error("board row mismatch");
    changed.add(id);
    rows.set(id, apply(rows.get(id), patch));
  }
  const seen = new Set<Key>();
  const order: Key[] = [];
  if (change.order === undefined) order.push(...ids);
  else for (const item of change.order) {
    if (!Array.isArray(item)) { order.push(item); continue; }
    const [start, length] = item;
    if (item.length !== 2 || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 || start + length > ids.length) throw new Error("board order range mismatch");
    for (let i = start; i < start + length; i++) order.push(ids[i]);
  }
  const next = order.map(id => {
    if (seen.has(id) || !rows.has(id)) throw new Error("board order mismatch");
    seen.add(id);
    const row = rows.get(id);
    if (!object(row) || !Object.hasOwn(row, change.key) || row[change.key] !== id) throw new Error("board row identity changed");
    return row;
  });
  if ([...changed].some(id => !seen.has(id))) throw new Error("board patch has an unused row");
  return next;
}

export function diffBoard(previous: RecordValue, next: RecordValue, base: string, etag: string): BoardDelta {
  const change = diffBoardValue(previous, next);
  return { v: 2, base, etag, ...(change ? { change } : {}) };
}

export function applyBoardDelta(previous: RecordValue, delta: BoardDelta): RecordValue {
  if (delta?.v !== 2) throw new Error("board protocol is not supported");
  const next = Object.hasOwn(delta, "change") ? apply(previous, delta.change!) : previous;
  if (!object(next)) throw new Error("board root is not an object");
  return next;
}
