/**
 * The oldest SQLite Delegatus must run on, as a library a test can load.
 *
 * On macOS bun:sqlite uses the SQLite that Apple ships with the system, and
 * Bun requires macOS 13. The macOS 13 SDK ships SQLite 3.39.5, an Apple build
 * of the upstream 3.39 line whose last upstream release is 3.39.4; macOS 14
 * and 15 ship 3.43.2. On Linux and Windows Bun links its own, much newer,
 * SQLite and `Database.setCustomSQLite` does nothing, so a statement that
 * needs a newer SQLite never fails there. This fixture builds 3.39.4 from the
 * official amalgamation (pinned by the SHA3-256 the release log publishes for
 * `sqlite3.c`) and exposes it through a `bun:sqlite`-shaped module over
 * bun:ffi, so the real stores can be run against it with `mock.module`.
 */
import { CString, dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MINIMUM_SQLITE = {
  version: "3.39.4",
  /** What Apple ships on the oldest macOS Bun supports (13); same 3.39 feature set. */
  appleVersion: "3.39.5",
  url: "https://www.sqlite.org/2022/sqlite-amalgamation-3390400.zip",
  member: "sqlite-amalgamation-3390400/sqlite3.c",
  /** https://www.sqlite.org/releaselog/3_39_4.html, "SHA3-256 for sqlite3.c". */
  sqlite3cSha3: "f65082298127e2ddae6539beb94f5204b591df64ba2c7da83c7d0faffd6959d8",
} as const;

const LIBRARY_ENV = "LLV_MINIMUM_SQLITE_LIBRARY";

function libraryName(): string {
  return process.platform === "darwin" ? "libsqlite3.dylib" : process.platform === "win32" ? "sqlite3.dll" : "libsqlite3.so";
}

/**
 * The path of a minimum-version SQLite shared library: `LLV_MINIMUM_SQLITE_LIBRARY`
 * when set, else a build in `directory` (default: the OS temp root), downloaded
 * and compiled once. Throws when it cannot be built: the guard never passes by
 * skipping.
 */
export function minimumSqliteLibrary(directory = path.join(os.tmpdir(), "delegatus-minimum-sqlite-3390400")): string {
  const preset = process.env[LIBRARY_ENV];
  if (preset) {
    if (!fs.existsSync(preset)) throw new Error(`${LIBRARY_ENV} names ${preset}, which does not exist`);
    return preset;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  /* Whatever is in this directory is compiled and loaded into the process. */
  const owner = fs.lstatSync(directory);
  if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid()) || (owner.mode & 0o022) !== 0) {
    throw new Error(`${directory} is not a directory only this user can write; pass another or set ${LIBRARY_ENV}`);
  }
  const library = path.join(directory, libraryName());
  if (fs.existsSync(library)) return library;
  const archive = path.join(directory, `amalgamation-${process.pid}.zip`);
  const source = path.join(directory, "sqlite3.c");
  const verified = (text: Buffer) => {
    const digest = new Bun.CryptoHasher("sha3-256").update(text).digest("hex");
    if (digest !== MINIMUM_SQLITE.sqlite3cSha3) throw new Error(`sqlite3.c has SHA3-256 ${digest}, expected ${MINIMUM_SQLITE.sqlite3cSha3} (${MINIMUM_SQLITE.url})`);
    return text;
  };
  if (fs.existsSync(source)) verified(fs.readFileSync(source));
  else {
    execFileSync("curl", ["-sSfL", "--retry", "3", "-o", archive, MINIMUM_SQLITE.url], { stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 });
    const text = verified(execFileSync("unzip", ["-p", archive, MINIMUM_SQLITE.member], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }));
    fs.writeFileSync(`${source}.partial-${process.pid}`, text);
    fs.renameSync(`${source}.partial-${process.pid}`, source);
    fs.rmSync(archive, { force: true });
  }
  const shared = process.platform === "darwin" ? ["-dynamiclib"] : ["-shared", "-fPIC"];
  execFileSync(process.env.CC || "cc", ["-O1", ...shared, "-DSQLITE_THREADSAFE=1", "-DSQLITE_ENABLE_FTS5",
    "-o", `${library}.partial-${process.pid}`, source, ...(process.platform === "linux" ? ["-lpthread", "-lm"] : [])],
  { stdio: ["ignore", "ignore", "inherit"], timeout: 300_000 });
  fs.renameSync(`${library}.partial-${process.pid}`, library);
  return library;
}

/* ---- a bun:sqlite-shaped module over the library -------------------------- */

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_OPEN_READONLY = 0x1;
const SQLITE_OPEN_READWRITE = 0x2;
const SQLITE_OPEN_CREATE = 0x4;
const SQLITE_OPEN_URI = 0x40;
const SQLITE_OPEN_FULLMUTEX = 0x10000;
const TRANSIENT = -1;

const PRIMARY: Record<number, string> = {
  1: "SQLITE_ERROR", 2: "SQLITE_INTERNAL", 3: "SQLITE_PERM", 4: "SQLITE_ABORT", 5: "SQLITE_BUSY", 6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM", 8: "SQLITE_READONLY", 9: "SQLITE_INTERRUPT", 10: "SQLITE_IOERR", 11: "SQLITE_CORRUPT",
  12: "SQLITE_NOTFOUND", 13: "SQLITE_FULL", 14: "SQLITE_CANTOPEN", 15: "SQLITE_PROTOCOL", 16: "SQLITE_EMPTY",
  17: "SQLITE_SCHEMA", 18: "SQLITE_TOOBIG", 19: "SQLITE_CONSTRAINT", 20: "SQLITE_MISMATCH", 21: "SQLITE_MISUSE",
  22: "SQLITE_NOLFS", 23: "SQLITE_AUTH", 24: "SQLITE_FORMAT", 25: "SQLITE_RANGE", 26: "SQLITE_NOTADB",
};
const EXTENDED: Record<number, string> = {
  261: "SQLITE_BUSY_RECOVERY", 517: "SQLITE_BUSY_SNAPSHOT", 773: "SQLITE_BUSY_TIMEOUT", 262: "SQLITE_LOCKED_SHAREDCACHE",
  267: "SQLITE_CORRUPT_VTAB", 523: "SQLITE_CORRUPT_SEQUENCE", 779: "SQLITE_CORRUPT_INDEX", 264: "SQLITE_READONLY_RECOVERY",
  520: "SQLITE_READONLY_CANTLOCK", 776: "SQLITE_READONLY_ROLLBACK", 1032: "SQLITE_READONLY_DBMOVED",
  275: "SQLITE_CONSTRAINT_CHECK", 531: "SQLITE_CONSTRAINT_COMMITHOOK", 787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1043: "SQLITE_CONSTRAINT_FUNCTION", 1299: "SQLITE_CONSTRAINT_NOTNULL", 1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1811: "SQLITE_CONSTRAINT_TRIGGER", 2067: "SQLITE_CONSTRAINT_UNIQUE", 2323: "SQLITE_CONSTRAINT_VTAB",
  2579: "SQLITE_CONSTRAINT_ROWID", 270: "SQLITE_CANTOPEN_NOTEMPDIR", 526: "SQLITE_CANTOPEN_ISDIR",
  782: "SQLITE_CANTOPEN_FULLPATH", 266: "SQLITE_IOERR_READ", 522: "SQLITE_IOERR_SHORT_READ", 778: "SQLITE_IOERR_WRITE",
  1034: "SQLITE_IOERR_FSYNC", 2570: "SQLITE_IOERR_DELETE", 3338: "SQLITE_IOERR_LOCK", 4874: "SQLITE_IOERR_SHMOPEN",
  5130: "SQLITE_IOERR_SHMSIZE", 5898: "SQLITE_IOERR_DELETE_NOENT",
};

function codeName(rc: number): string {
  return EXTENDED[rc] ?? PRIMARY[rc & 0xff] ?? `SQLITE_UNKNOWN_${rc}`;
}

export class SQLiteError extends Error {
  override name = "SQLiteError";
  constructor(message: string, readonly errno: number, readonly code = codeName(errno), readonly byteOffset = -1) {
    super(message);
  }
}

type Library = ReturnType<typeof openLibrary>;

function openLibrary(file: string) {
  const { i32, i64, ptr: P, f64, cstring } = FFIType;
  return dlopen(file, {
    sqlite3_libversion: { args: [], returns: cstring },
    sqlite3_open_v2: { args: [P, P, i32, P], returns: i32 },
    sqlite3_close_v2: { args: [P], returns: i32 },
    sqlite3_errmsg: { args: [P], returns: cstring },
    sqlite3_errstr: { args: [i32], returns: cstring },
    sqlite3_extended_errcode: { args: [P], returns: i32 },
    sqlite3_extended_result_codes: { args: [P, i32], returns: i32 },
    sqlite3_prepare_v2: { args: [P, P, i32, P, P], returns: i32 },
    sqlite3_step: { args: [P], returns: i32 },
    sqlite3_reset: { args: [P], returns: i32 },
    sqlite3_clear_bindings: { args: [P], returns: i32 },
    sqlite3_finalize: { args: [P], returns: i32 },
    sqlite3_bind_parameter_count: { args: [P], returns: i32 },
    sqlite3_bind_parameter_name: { args: [P, i32], returns: P },
    sqlite3_bind_null: { args: [P, i32], returns: i32 },
    sqlite3_bind_int64: { args: [P, i32, i64], returns: i32 },
    sqlite3_bind_double: { args: [P, i32, f64], returns: i32 },
    sqlite3_bind_text: { args: [P, i32, P, i32, i64], returns: i32 },
    sqlite3_bind_blob: { args: [P, i32, P, i32, i64], returns: i32 },
    sqlite3_bind_zeroblob: { args: [P, i32, i32], returns: i32 },
    sqlite3_column_count: { args: [P], returns: i32 },
    sqlite3_column_name: { args: [P, i32], returns: cstring },
    sqlite3_column_decltype: { args: [P, i32], returns: P },
    sqlite3_column_type: { args: [P, i32], returns: i32 },
    sqlite3_column_int64: { args: [P, i32], returns: FFIType.i64_fast },
    sqlite3_column_double: { args: [P, i32], returns: f64 },
    sqlite3_column_text: { args: [P, i32], returns: P },
    sqlite3_column_blob: { args: [P, i32], returns: P },
    sqlite3_column_bytes: { args: [P, i32], returns: i32 },
    sqlite3_changes: { args: [P], returns: i32 },
    sqlite3_last_insert_rowid: { args: [P], returns: FFIType.i64_fast },
    sqlite3_get_autocommit: { args: [P], returns: i32 },
    sqlite3_sql: { args: [P], returns: cstring },
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const cstr = (text: string) => Buffer.from(`${text}\0`, "utf8");

type Binding = string | number | bigint | boolean | null | undefined | Uint8Array | ArrayBuffer;

function isNamed(args: unknown[]): args is [Record<string, Binding>] {
  const [only] = args;
  return args.length === 1 && only !== null && typeof only === "object" && !Array.isArray(only)
    && !ArrayBuffer.isView(only) && !(only instanceof ArrayBuffer);
}

/**
 * Builds the `bun:sqlite` exports over the library at `file`. Covers what the
 * first-party stores use: `new Database(filename, { readonly, create,
 * readwrite, strict, safeIntegers })`, `query` (cached) and `prepare`,
 * `exec`/`run` of one or more statements, `transaction` with
 * deferred/immediate/exclusive and savepoint nesting, `inTransaction`,
 * `close`, and statements with `get`/`all`/`run`/`values`/`iterate`/`finalize`.
 */
export function minimumSqliteModule(file: string) {
  const lib: Library = openLibrary(file);
  const s = lib.symbols;
  const version = String(s.sqlite3_libversion());

  function check(db: Pointer | 0, rc: number): void {
    if (rc === SQLITE_OK || rc === SQLITE_ROW || rc === SQLITE_DONE) return;
    const errno = db ? s.sqlite3_extended_errcode(db) : rc;
    const message = db ? String(s.sqlite3_errmsg(db)) : String(s.sqlite3_errstr(rc));
    throw new SQLiteError(message, errno);
  }

  class Statement {
    #db: Database;
    #handle: Pointer;
    #strict: boolean;
    #safeIntegers: boolean;
    #params: Array<string | null>;
    readonly columnNames: string[];
    readonly paramsCount: number;
    finalized = false;

    constructor(db: Database, handle: Pointer, strict: boolean, safeIntegers: boolean) {
      this.#db = db;
      this.#handle = handle;
      this.#strict = strict;
      this.#safeIntegers = safeIntegers;
      this.paramsCount = s.sqlite3_bind_parameter_count(handle);
      this.#params = Array.from({ length: this.paramsCount }, (_, index) => {
        const name = s.sqlite3_bind_parameter_name(handle, index + 1);
        return name ? String(new CString(name)) : null;
      });
      this.columnNames = Array.from({ length: s.sqlite3_column_count(handle) }, (_, index) => String(s.sqlite3_column_name(handle, index)));
    }

    get native() { return this.#handle; }

    #bind(given: unknown[]): void {
      const handle = this.#handle;
      s.sqlite3_reset(handle);
      s.sqlite3_clear_bindings(handle);
      /* One array argument is the positional list, as in Bun. */
      const args = given.length === 1 && Array.isArray(given[0]) ? given[0] as unknown[] : given;
      if (!args.length) return;
      const named = isNamed(args) ? args[0] : null;
      let positional = 0;
      for (let index = 1; index <= this.paramsCount; index += 1) {
        const name = this.#params[index - 1];
        let value: Binding;
        if (named) {
          if (name === null) throw new SQLiteError("positional parameter given named bindings", 25);
          if (Object.hasOwn(named, name)) value = named[name];
          else if (this.#strict && Object.hasOwn(named, name.slice(1))) value = named[name.slice(1)];
          else if (this.#strict) throw new SQLiteError(`Missing parameter "${name.slice(1)}"`, 25);
          else value = null;
        } else {
          const at = name && /^\?\d+$/.test(name) ? Number(name.slice(1)) - 1 : positional++;
          value = args[at] as Binding;
        }
        this.#bindOne(index, value);
      }
    }

    #bindOne(index: number, value: Binding): void {
      const handle = this.#handle;
      let rc: number;
      if (value === null || value === undefined) rc = s.sqlite3_bind_null(handle, index);
      else if (typeof value === "boolean") rc = s.sqlite3_bind_int64(handle, index, value ? 1 : 0);
      else if (typeof value === "bigint") rc = s.sqlite3_bind_int64(handle, index, value);
      else if (typeof value === "number") rc = Number.isSafeInteger(value) ? s.sqlite3_bind_int64(handle, index, value) : s.sqlite3_bind_double(handle, index, value);
      else if (typeof value === "string") {
        const bytes = encoder.encode(value);
        rc = bytes.length ? s.sqlite3_bind_text(handle, index, ptr(bytes), bytes.length, TRANSIENT) : s.sqlite3_bind_text(handle, index, ptr(cstr("")), 0, TRANSIENT);
      } else {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        rc = bytes.length ? s.sqlite3_bind_blob(handle, index, ptr(bytes), bytes.length, TRANSIENT) : s.sqlite3_bind_zeroblob(handle, index, 0);
      }
      check(this.#db.handle, rc);
    }

    #column(index: number): unknown {
      const handle = this.#handle;
      switch (s.sqlite3_column_type(handle, index)) {
        case 1: {
          const value = s.sqlite3_column_int64(handle, index);
          return this.#safeIntegers ? BigInt(value) : Number(value);
        }
        case 2: return s.sqlite3_column_double(handle, index);
        case 3: {
          const bytes = s.sqlite3_column_bytes(handle, index);
          const at = s.sqlite3_column_text(handle, index);
          return bytes && at ? decoder.decode(new Uint8Array(toArrayBuffer(at, 0, bytes))) : "";
        }
        case 4: {
          const bytes = s.sqlite3_column_bytes(handle, index);
          const at = s.sqlite3_column_blob(handle, index);
          return bytes && at ? new Uint8Array(toArrayBuffer(at, 0, bytes)).slice() : new Uint8Array(0);
        }
        default: return null;
      }
    }

    #step(): boolean {
      if (this.finalized) throw new SQLiteError("Statement has finalized", 21);
      const rc = s.sqlite3_step(this.#handle);
      if (rc === SQLITE_ROW) return true;
      if (rc === SQLITE_DONE) return false;
      const errno = s.sqlite3_extended_errcode(this.#db.handle);
      const message = String(s.sqlite3_errmsg(this.#db.handle));
      s.sqlite3_reset(this.#handle);
      throw new SQLiteError(message, errno);
    }

    #object(): Record<string, unknown> {
      const row: Record<string, unknown> = {};
      this.columnNames.forEach((name, index) => { row[name] = this.#column(index); });
      return row;
    }

    get(...args: unknown[]) {
      this.#bind(args);
      try { return this.#step() ? this.#object() : null; } finally { s.sqlite3_reset(this.#handle); }
    }

    all(...args: unknown[]) {
      this.#bind(args);
      const rows: Record<string, unknown>[] = [];
      try { while (this.#step()) rows.push(this.#object()); } finally { s.sqlite3_reset(this.#handle); }
      return rows;
    }

    values(...args: unknown[]) {
      this.#bind(args);
      const rows: unknown[][] = [];
      try { while (this.#step()) rows.push(this.columnNames.map((_, index) => this.#column(index))); } finally { s.sqlite3_reset(this.#handle); }
      return rows;
    }

    *iterate(...args: unknown[]) {
      this.#bind(args);
      try { while (this.#step()) yield this.#object(); } finally { s.sqlite3_reset(this.#handle); }
    }

    run(...args: unknown[]) {
      this.#bind(args);
      try { while (this.#step()) { /* drain */ } } finally { s.sqlite3_reset(this.#handle); }
      return { changes: s.sqlite3_changes(this.#db.handle), lastInsertRowid: Number(s.sqlite3_last_insert_rowid(this.#db.handle)) };
    }

    as() { return this; }

    toString() { return String(s.sqlite3_sql(this.#handle)); }

    finalize() {
      if (this.finalized) return;
      this.finalized = true;
      s.sqlite3_finalize(this.#handle);
    }
  }

  class Database {
    static setCustomSQLite() { return false; }
    readonly filename: string;
    handle: Pointer;
    #strict: boolean;
    #safeIntegers: boolean;
    #cache = new Map<string, Statement>();
    #statements = new Set<Statement>();

    constructor(filename = ":memory:", options: number | { readonly?: boolean; create?: boolean; readwrite?: boolean; strict?: boolean; safeIntegers?: boolean } = {}) {
      this.filename = filename;
      const opts = typeof options === "number" ? {} : options;
      let flags = typeof options === "number" ? options
        : opts.readonly ? SQLITE_OPEN_READONLY
          : SQLITE_OPEN_READWRITE | (opts.create === false || (opts.readwrite && opts.create === undefined) ? 0 : SQLITE_OPEN_CREATE);
      flags |= SQLITE_OPEN_FULLMUTEX | (filename.startsWith("file:") ? SQLITE_OPEN_URI : 0);
      this.#strict = !!opts.strict;
      this.#safeIntegers = !!opts.safeIntegers;
      const out = new BigUint64Array(1);
      const rc = s.sqlite3_open_v2(ptr(cstr(filename)), ptr(out), flags, null);
      const handle = Number(out[0]) as Pointer;
      if (rc !== SQLITE_OK) {
        const message = handle ? String(s.sqlite3_errmsg(handle)) : String(s.sqlite3_errstr(rc));
        const errno = handle ? s.sqlite3_extended_errcode(handle) : rc;
        if (handle) s.sqlite3_close_v2(handle);
        throw new SQLiteError(message, errno);
      }
      this.handle = handle;
      s.sqlite3_extended_result_codes(handle, 1);
    }

    #prepareAll(sql: string, each: (statement: Statement) => void): void {
      const text = cstr(sql);
      const base = ptr(text);
      const length = text.length - 1;
      let offset = 0;
      const out = new BigUint64Array(1);
      const tail = new BigUint64Array(1);
      while (offset < length) {
        out[0] = BigInt(0);
        const rc = s.sqlite3_prepare_v2(this.handle, (base + offset) as Pointer, length - offset, ptr(out), ptr(tail));
        check(this.handle, rc);
        const next = Number(tail[0]) - base;
        const handle = Number(out[0]) as Pointer;
        if (handle) {
          const statement = new Statement(this, handle, this.#strict, this.#safeIntegers);
          try { each(statement); } finally { statement.finalize(); }
        }
        if (next <= offset) break;
        offset = next;
      }
    }

    prepare(sql: string, ...args: unknown[]): Statement {
      const out = new BigUint64Array(1);
      const text = cstr(sql);
      check(this.handle, s.sqlite3_prepare_v2(this.handle, ptr(text), text.length - 1, ptr(out), null));
      const handle = Number(out[0]) as Pointer;
      if (!handle) throw new SQLiteError("Query contained no valid SQL statement; likely empty query.", 21);
      const statement = new Statement(this, handle, this.#strict, this.#safeIntegers);
      this.#statements.add(statement);
      if (args.length) statement.get(...args);
      return statement;
    }

    query(sql: string): Statement {
      const cached = this.#cache.get(sql);
      if (cached && !cached.finalized) return cached;
      const statement = this.prepare(sql);
      this.#cache.set(sql, statement);
      return statement;
    }

    run(sql: string, ...args: unknown[]) {
      let changes = 0;
      this.#prepareAll(sql, statement => {
        const result = statement.paramsCount ? statement.run(...args) : statement.run();
        changes = result.changes;
      });
      return { changes, lastInsertRowid: Number(s.sqlite3_last_insert_rowid(this.handle)) };
    }

    exec(sql: string, ...args: unknown[]) {
      return this.run(sql, ...args);
    }

    get inTransaction(): boolean {
      return s.sqlite3_get_autocommit(this.handle) === 0;
    }

    transaction<A extends unknown[], R>(fn: (...args: A) => R) {
      const make = (begin: string) => (...args: A): R => {
        if (this.inTransaction) {
          const name = `minimum_sqlite_${Math.random().toString(36).slice(2)}`;
          this.exec(`SAVEPOINT ${name}`);
          try {
            const result = fn(...args);
            this.exec(`RELEASE ${name}`);
            return result;
          } catch (error) {
            this.exec(`ROLLBACK TO ${name}`);
            this.exec(`RELEASE ${name}`);
            throw error;
          }
        }
        this.exec(begin);
        try {
          const result = fn(...args);
          this.exec("COMMIT");
          return result;
        } catch (error) {
          if (this.inTransaction) this.exec("ROLLBACK");
          throw error;
        }
      };
      return Object.assign(make("BEGIN"), { deferred: make("BEGIN DEFERRED"), immediate: make("BEGIN IMMEDIATE"), exclusive: make("BEGIN EXCLUSIVE") });
    }

    serialize(): never {
      throw new Error("serialize is not available on the minimum-SQLite fixture");
    }

    close(throwOnError = false) {
      if (!this.handle) return;
      for (const statement of this.#statements) statement.finalize();
      this.#statements.clear();
      this.#cache.clear();
      const rc = s.sqlite3_close_v2(this.handle);
      if (rc !== SQLITE_OK && throwOnError) check(this.handle, rc);
      this.handle = 0 as Pointer;
    }

    [Symbol.dispose]() { this.close(); }
  }

  return { Database, Statement, SQLiteError, default: Database, constants: {}, version, close: () => lib.close() };
}

export type MinimumSqliteModule = ReturnType<typeof minimumSqliteModule>;
