/** In-memory Codex reducer journal. A read is tied to the preceding write at
 * its source coordinate, including a lookup which found nothing. Inserting an
 * older write invalidates just that interval's readers. Payloads and rows stay
 * shared; there is no copy of the historical maps at a page boundary. */
type Family = "exec-result" | "exec-child" | "user-bucket" | "pending-exec" | "frontier" | "call" | "row" | "reasoning" | "agent" | "image" | "represented" | "user" | "service" | "ledger" | "size" | "representation";
type Version = {
  at: number; value: unknown; readers: Set<Effect>; priority: number;
  left: Version | null; right: Version | null; next: Version | null;
};
type Slot = { family: Family; key: string; root: Version | null; initial: Version; last: Version; count: number; clone: (value: never) => unknown };

function version(at: number, value: unknown): Version {
  let priority = at | 0;
  priority = Math.imul(priority ^ (priority >>> 16), 0x45d9f3b);
  priority = Math.imul(priority ^ (priority >>> 16), 0x45d9f3b);
  priority = (priority ^ (priority >>> 16)) >>> 0;
  return { at, value, priority, readers: new Set(), left: null, right: null, next: null };
}
function merge(left: Version | null, right: Version | null): Version | null {
  if (!left) return right;
  if (!right) return left;
  if (left.priority < right.priority) { left.right = merge(left.right, right); return left; }
  right.left = merge(left, right.left); return right;
}
function insert(root: Version | null, node: Version): Version {
  if (!root) return node;
  if (node.at < root.at) {
    root.left = insert(root.left, node);
    if (root.left.priority < root.priority) {
      const next = root.left; root.left = next.right; next.right = root; return next;
    }
  } else {
    root.right = insert(root.right, node);
    if (root.right.priority < root.priority) {
      const next = root.right; root.right = next.left; next.left = root; return next;
    }
  }
  return root;
}
function remove(root: Version | null, at: number): Version | null {
  if (!root) return null;
  if (root.at === at) return merge(root.left, root.right);
  if (at < root.at) root.left = remove(root.left, at);
  else root.right = remove(root.right, at);
  return root;
}
type Effect = {
  at: number;
  run: () => void;
  reads: Map<Slot, Version>;
  writes: Set<Slot>;
  rows: number[];
  reason: string;
  normalized: Map<string, { input: unknown; value: unknown }>;
};

function equal(a: unknown, b: unknown, itemEqual: (a: unknown, b: unknown) => boolean): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    const right = [...b];
    return [...a].every((value, index) => Object.is(value, right[index]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i], itemEqual));
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && (k === "item" || k === "event"
    ? itemEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    : equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], itemEqual)));
}

export interface CodexHistoryStats {
  rawLines: number;
  rawBytes: number;
  reusedLines: number;
  effectVisits: number;
  effectChecks: number;
  rowPatches: number;
  decodeMs: number;
  replayMs: number;
  verifyMs: number;
  projectionMs: number;
  resets: Record<string, number>;
  replayByDependency: Record<string, number>;
  effects: number;
  slots: number;
  versions: number;
  /** UTF-8 JSON size of the terminal scalar frontier and its live lists. */
  checkpointBytes: number;
  frontier: { users: number; execs: number; pendingMembers: number; roundMembers: number; sizes: number };
}

export class CodexHistory {
  constructor(private readonly itemEqual: (a: unknown, b: unknown) => boolean = Object.is) {}
  private same(a: unknown, b: unknown): boolean { return equal(a, b, this.itemEqual); }
  private slots = new Map<Family, Map<string, Slot>>();
  private effects = new Map<number, Effect>();
  private effectRoot: Version | null = null;
  private active: Effect | null = null;
  private local = new Map<Slot, { before: unknown; value: unknown; written: boolean }>();
  private pending = new Set<Effect>();
  private pendingHeap: Effect[] = [];
  private nextRow = 0;
  private ordinal = 0;
  private normalizationOrdinals = new Map<string, number>();
  revision = 0;
  readonly stats: Omit<CodexHistoryStats, "effects" | "slots" | "versions" | "checkpointBytes" | "frontier"> = {
    rawLines: 0, rawBytes: 0, reusedLines: 0, effectVisits: 0, effectChecks: 0, rowPatches: 0,
    decodeMs: 0, replayMs: 0, verifyMs: 0, projectionMs: 0, resets: {}, replayByDependency: {},
  };

  private slot<T>(family: Family, key: string, initial?: T, clone: (value: T) => T = v => v): Slot {
    let table = this.slots.get(family);
    if (!table) this.slots.set(family, table = new Map());
    let slot = table.get(key);
    if (!slot) {
      const first = version(-Infinity, initial);
      slot = { family, key, root: null, initial: first, last: first, count: 0, clone: clone as Slot["clone"] };
      table.set(key, slot);
    }
    return slot;
  }

  private preceding(slot: Slot, at: number): Version {
    let found = slot.initial;
    for (let node = slot.root; node;) {
      if (node.at < at) { found = node; node = node.right; }
      else node = node.left;
    }
    return found;
  }

  private read<T>(slot: Slot): T {
    if (!this.active) return slot.last.value as T;
    const held = this.local.get(slot);
    if (held) return held.value as T;
    const version = this.preceding(slot, this.active.at);
    this.active.reads.set(slot, version);
    version.readers.add(this.active);
    const value = slot.clone(version.value as never);
    this.local.set(slot, { before: version.value, value, written: false });
    return value as T;
  }

  private write(slot: Slot, value: unknown): void {
    if (!this.active) {
      const initial = slot.initial;
      if (!this.same(initial.value, value)) {
        const replacement = version(-Infinity, value);
        replacement.next = initial.next;
        slot.initial = replacement;
        if (slot.last === initial) slot.last = replacement;
        for (const reader of initial.readers) this.invalidate(reader, slot);
      }
      return;
    }
    // An overwrite does not read the value it replaces.
    const held = this.local.get(slot);
    this.local.set(slot, { before: held?.before, value, written: true });
  }

  private invalidate(effect: Effect, slot: Slot): void {
    if (effect === this.active) return;
    effect.reason = `${slot.family}:${slot.key}`;
    if (this.pending.has(effect)) return;
    this.pending.add(effect);
    const heap = this.pendingHeap;
    heap.push(effect);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (heap[parent].at <= effect.at) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = effect;
  }

  private nextPending(): Effect {
    const heap = this.pendingHeap;
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].at < heap[child].at) child += 1;
        if (last.at <= heap[child].at) break;
        heap[index] = heap[child]; index = child;
      }
      heap[index] = last;
    }
    this.pending.delete(first);
    return first;
  }

  fields<T extends object>(family: "frontier" | "ledger", initial: T, clones: Partial<{ [K in keyof T]: (value: T[K]) => T[K] }> = {}): T {
    const cells = new Map<PropertyKey, Slot>();
    for (const key of Object.keys(initial) as (keyof T & string)[]) cells.set(key, this.slot(family, key, initial[key], clones[key]));
    return new Proxy(initial, {
      get: (_target, key) => this.read(cells.get(key)!),
      set: (_target, key, value) => { this.write(cells.get(key)!, value); return true; },
    });
  }

  map<T>(family: Exclude<Family, "frontier" | "ledger">, clone?: (value: T | undefined) => T | undefined): Map<string, T> {
    const cell = (key: string) => this.slot<T | undefined>(family, key, undefined, clone);
    const entries = function* (self: CodexHistory): Generator<[string, T]> {
      for (const [key, slot] of self.slots.get(family) ?? []) {
        const value = self.read<T | undefined>(slot);
        if (value !== undefined) yield [key, value];
      }
    };
    const lookup = (key: string) => this.read<T | undefined>(cell(key));
    const write = (key: string, value: T | undefined) => this.write(cell(key), value);
    const iterate = () => entries(this);
    return new class extends Map<string, T> {
      override get(key: string): T | undefined { return lookup(key); }
      override has(key: string): boolean { return lookup(key) !== undefined; }
      override set(key: string, value: T): this { write(key, value); return this; }
      override delete(key: string): boolean { const present = this.has(key); if (present) write(key, undefined); return present; }
      override clear(): void { for (const key of this.keys()) this.delete(key); }
      override *keys(): MapIterator<string> { for (const [key] of iterate()) yield key; }
      override *values(): MapIterator<T> { for (const [, value] of iterate()) yield value; }
      override entries(): MapIterator<[string, T]> { return iterate(); }
      override [Symbol.iterator](): MapIterator<[string, T]> { return iterate(); }
      override get size(): number { return [...iterate()].length; }
      override forEach(callback: (value: T, key: string, map: Map<string, T>) => void, thisArg?: unknown): void {
        for (const [key, value] of iterate()) callback.call(thisArg, value, key, this);
      }
    }();
  }

  /** Row slots are stable across reapplication even if an echo suppresses an
   * emission or an orphan completion starts attaching to an older call. */
  rowId(): number {
    const effect = this.active!;
    if (effect.rows[this.ordinal] === undefined) {
      effect.rows[this.ordinal] = this.nextRow++;
    }
    return effect.rows[this.ordinal];
  }
  emitted(): void { this.ordinal += 1; }

  /** Emission order is independent of the birth coordinate used by React.
   * Late harness classification can emit a row anchored to an earlier line. */
  *rows<T>(): Generator<T> {
    const stack: Version[] = [];
    let node = this.effectRoot;
    const rows = this.slots.get("row");
    while (node || stack.length) {
      while (node) { stack.push(node); node = node.left; }
      node = stack.pop()!;
      for (const id of (node.value as Effect).rows) {
        const value = rows?.get(String(id))?.last.value;
        if (value !== undefined) yield value as T;
      }
      node = node.right;
    }
  }

  record(at: number, run: () => void): void {
    const effect: Effect = { at, run, reads: new Map(), writes: new Set(), rows: [], reason: "page", normalized: new Map() };
    this.effects.set(at, effect);
    this.effectRoot = insert(this.effectRoot, version(at, effect));
    this.apply(effect);
  }

  private apply(effect: Effect): void {
    for (const [slot, version] of effect.reads) { version.readers.delete(effect); }
    effect.reads.clear();
    this.active = effect;
    this.ordinal = 0;
    this.normalizationOrdinals.clear();
    this.local = new Map();
    try {
      effect.run();
      const writes = new Map<Slot, unknown>();
      for (const [slot, held] of this.local) if (held.written || !this.same(held.before, held.value)) writes.set(slot, held.value);
      // A former overwrite can become a read-through after a prepend. Keep
      // its equal output as a forwarding barrier: its own read will reapply
      // it if ingress changes, while downstream readers retain their provider.
      for (const slot of effect.writes) if (!writes.has(slot) && effect.reads.has(slot)) {
        const old = this.preceding(slot, effect.at).next;
        const held = this.local.get(slot);
        if (old?.at === effect.at && held && this.same(old.value, held.value)) writes.set(slot, held.value);
      }
      for (const slot of new Set([...effect.writes, ...writes.keys()])) {
        const prev = this.preceding(slot, effect.at);
        const old = prev.next?.at === effect.at ? prev.next : undefined;
        const present = writes.has(slot);
        const value = writes.get(slot);
        if (old && present && this.same(old.value, value)) continue;
        this.revision += 1;
        if (old) {
          for (const reader of old.readers) this.invalidate(reader, slot);
          slot.root = remove(slot.root, effect.at);
          prev.next = old.next;
          if (slot.last === old) slot.last = prev;
          slot.count -= 1;
        }
        if (present) {
          const next = prev.next?.at ?? Infinity;
          for (const reader of prev.readers) if (reader.at > effect.at && reader.at <= next) this.invalidate(reader, slot);
          const node = version(effect.at, value);
          node.next = prev.next;
          prev.next = node;
          slot.root = insert(slot.root, node);
          if (!node.next) slot.last = node;
          slot.count += 1;
        }
        if (slot.family === "row") this.stats.rowPatches += 1;
      }
      effect.writes = new Set(writes.keys());
    } finally {
      this.active = null;
      this.local.clear();
    }
  }

  settle(): void {
    const began = performance.now();
    while (this.pending.size) {
      // Pending effects are the changed frontier's readers, never a scan of
      // the retained suffix. Source order also prevents duplicate output.
      const first = this.nextPending();
      this.stats.effectChecks += 1;
      let changed = false;
      for (const [slot, version] of first.reads) {
        const now = this.preceding(slot, first.at);
        if (!this.same(now.value, version.value)) { changed = true; break; }
        if (now !== version) {
          version.readers.delete(first);
          now.readers.add(first);
          first.reads.set(slot, now);
        }
      }
      if (!changed) continue;
      this.stats.effectVisits += 1;
      const family = first.reason.split(":", 1)[0];
      this.stats.replayByDependency[family] = (this.stats.replayByDependency[family] ?? 0) + 1;
      this.apply(first);
    }
    this.stats.replayMs += performance.now() - began;
  }

  diagnostics(): CodexHistoryStats {
    let slots = 0, versions = 0;
    for (const table of this.slots.values()) for (const slot of table.values()) { slots += 1; versions += slot.count + 1; }
    const value = (family: Family, key: string) => this.slots.get(family)?.get(key)?.last.value;
    const pending = value("ledger", "pending") as { length: number } | null;
    const round = value("ledger", "round") as { members: { length: number } | null } | null;
    const users = [...(this.slots.get("user")?.values() ?? [])].map(slot => slot.last.value).filter(Boolean);
    const frontier = {
      users: users.length,
      execs: (value("frontier", "pendingExecIds") as string[] | undefined)?.length ?? 0,
      pendingMembers: pending?.length ?? 0, roundMembers: round?.members?.length ?? 0,
      sizes: (value("ledger", "sizeOrder") as string[] | undefined)?.length ?? 0,
    };
    const ids = (value: unknown): string[] => {
      const out: string[] = [];
      for (let node = value as { id: string; previous: unknown } | null; node; node = node.previous as typeof node) out.push(node.id);
      return out.reverse();
    };
    const checkpointBytes = new TextEncoder().encode(JSON.stringify({
      scalars: [...(this.slots.get("frontier")?.values() ?? [])].map(slot => slot.key === "unstructuredUsers" ? ids(slot.last.value) : slot.last.value instanceof Set ? [...slot.last.value] : slot.last.value),
      ledger: [...(this.slots.get("ledger")?.values() ?? [])].map(slot => slot.key === "pending" ? ids(slot.last.value)
        : slot.key === "round" && slot.last.value ? { ...(slot.last.value as object), members: ids((slot.last.value as { members: unknown }).members) } : slot.last.value),
      frontier, users,
    })).length;
    return { ...this.stats, resets: { ...this.stats.resets }, replayByDependency: { ...this.stats.replayByDependency }, effects: this.effects.size, slots, versions, checkpointBytes, frontier };
  }

  partial(value: boolean): void { this.write(this.slot("ledger", "fresh", value), value); }

  /** Cache state-independent decoding/redaction on the operation which owns
   * it. A changed target still reapplies the semantic reducer to these facts. */
  normalize<T>(kind: string, input: unknown, compute: () => T): T {
    if (!this.active) return compute();
    const ordinal = this.normalizationOrdinals.get(kind) ?? 0;
    this.normalizationOrdinals.set(kind, ordinal + 1);
    const key = `${kind}:${ordinal}`;
    const held = this.active.normalized.get(key);
    if (held && this.same(held.input, input)) return held.value as T;
    const value = compute();
    this.active.normalized.set(key, { input, value });
    return value;
  }
}
