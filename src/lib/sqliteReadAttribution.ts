import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import { emptyReadTotals, readAttribution, type ReadTotals } from "./readAttribution";

type Connection = { id: number; reader: string; counters: ReadTotals };
type Shared = { next: number; connections: WeakMap<object, () => Connection | undefined>; observed: WeakSet<object> };
const global = globalThis as typeof globalThis & { __delegatusSqliteReaders?: Shared };
const shared = global.__delegatusSqliteReaders ??= { next: 0, connections: new WeakMap(), observed: new WeakSet() };
// Only fixed collection names may enter diagnostics. SQL, bindings, filenames
// and decoded values are never retained by the recorder.
const collections = new Set(["pipelines", "pipelines_archive", "deliveryOperationOwners", "tasks", "flows", "workflows",
  "entries", "receipts", "conversations", "deliveries", "launches", "memberships", "attention", "board", "accounts"]);

export function bindSqliteReadIdentity(handle: object, current: () => object): void {
  shared.connections.set(handle, () => shared.connections.get(current())?.());
}

/** Decorate the real instance, keeping Bun native receivers, statement cache,
 * transaction helpers, and caller-owned connection lifetime intact. */
export function observeSqlite<T extends Database>(db: T, reader: string): T {
  if (shared.connections.has(db)) return db;
  const identity = { id: ++shared.next, reader, counters: emptyReadTotals() };
  shared.connections.set(db, () => identity);
  const measure = <R>(name: string, work: () => R) => readAttribution.sync(name, work, identity.id, 0, true, identity.counters);
  const nativeCall = (method: "query" | "prepare" | "exec" | "run" | "serialize" | "close") => {
    const original = db[method], own = Object.hasOwn(db, method), prototype = Object.getPrototypeOf(db);
    // Keep instance adapters and late prototype guards in the call path.
    // Capturing a bound prototype function would bypass an installed guard.
    return (...args: unknown[]) => Reflect.apply(own ? original : Reflect.get(prototype, method, db), db, args);
  };
  const observeStatement = (statement: Statement, sql: string) => {
    if (shared.observed.has(statement)) return statement;
    shared.observed.add(statement);
    // A mixed IN list or a later bind slot cannot name one collection.
    const selector = /\bcollection\s*(?:=\s*\?(?:1)?(?!\d)|IN\s*\(\s*\?(?:1)?\s*\))/i.exec(sql);
    const boundCollection = !!selector && selector.index + selector[0].indexOf("?") === sql.indexOf("?");
    const literalCollections = [...collections].filter(name => sql.includes(`'${name}'`));
    const literalCollection = literalCollections.length === 1 ? literalCollections[0] : undefined;
    const name = (args: SQLQueryBindings[]) => {
      const bound = boundCollection && typeof args[0] === "string" && collections.has(args[0]) ? args[0] : literalCollection;
      return `${reader}${bound ? `.${bound}` : ""}`;
    };
    for (const method of ["all", "get", "run", "values"] as const) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, { configurable: true, writable: true,
        value: (...args: SQLQueryBindings[]) => measure(`${name(args)}.${method}`, () => original(...args)) });
    }
    const iterate = statement.iterate.bind(statement);
    Object.defineProperty(statement, "iterate", { configurable: true, writable: true, value: (...args: SQLQueryBindings[]) => {
      const iterator = iterate(...args);
      const label = `${name(args)}.iterate`;
      return new Proxy(iterator, { get(target, property) {
        if (property === Symbol.iterator) return function (this: unknown) { return this; };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? (...values: unknown[]) => measure(label, () => value.apply(target, values)) : value;
      } });
    } });
    return statement;
  };
  for (const method of ["query", "prepare"] as const) {
    const original = nativeCall(method);
    Object.defineProperty(db, method, { configurable: true, writable: true, value: (sql: string, ...args: unknown[]) =>
      observeStatement(measure(`${reader}.prepare`, () => original(sql, ...args)) as Statement, sql) });
  }
  for (const method of ["exec", "run", "serialize", "close"] as const) {
    const original = nativeCall(method);
    Object.defineProperty(db, method, { configurable: true, writable: true, value: (...args: unknown[]) =>
      measure(`${reader}.${method}`, () => original(...args)) });
  }
  return db;
}

export function parseSqliteJson(value: string, db?: object, fallback = "sqlite") {
  const identity = db && shared.connections.get(db)?.();
  return readAttribution.sync(`${identity?.reader ?? fallback}.json`, () => JSON.parse(value), identity?.id ?? 0, Buffer.byteLength(value), false, identity?.counters);
}

export function sqliteReadCounters(db: object) {
  const identity = shared.connections.get(db)?.();
  return identity ? { connection: identity.id, reader: identity.reader, ...identity.counters } : null;
}
