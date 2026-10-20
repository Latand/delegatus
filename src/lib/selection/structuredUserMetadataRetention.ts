import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, opendir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { statePath } from "@/lib/configDir";
import type { TranscriptIndexFeed } from "@/lib/search/transcriptFeed";
import { structuredUserReferenceKey } from "@/lib/runtime/codexStructuredUserText";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

const GRACE_MS = 30 * 24 * 60 * 60 * 1_000;
const INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_REFS = 100_000;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve));
type Identity = { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number };
type SourceIndex = { version: 1; identity: Identity; refs: string[] };

function identity(value: Identity): Identity {
  return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, ino: value.ino, dev: value.dev };
}
function same(a: Identity, b: Identity): boolean { return JSON.stringify(identity(a)) === JSON.stringify(identity(b)); }
function addReferences(text: string, refs: Set<string>): void {
  // Over-retain quoted references too. Normalize JSON Unicode escapes so a
  // legally escaped marker remains a root. The stream overlap holds a whole
  // reference even when every ASCII character occupies six raw bytes.
  const decoded = text.replace(/\\u([a-fA-F0-9]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (const match of decoded.matchAll(/\bctx=([hoad]\.[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{16})?)/g)) {
    if (structuredUserReferenceKey(match[1])) refs.add(match[1]);
    if (refs.size > MAX_REFS) throw new Error("metadata reference inventory exceeds its bound");
  }
}

async function sourceReferences(path: string, cacheDir: string): Promise<SourceIndex> {
  const before = identity(await stat(path));
  const cache = join(cacheDir, `${createHash("sha256").update(path).digest("hex")}.json`);
  try {
    if ((await stat(cache)).size <= MAX_INDEX_BYTES) {
      const value: SourceIndex = JSON.parse(await readFile(cache, "utf8"));
      if (value.version === 1 && same(value.identity, before) && Array.isArray(value.refs)
        && value.refs.length <= MAX_REFS && value.refs.every(ref => typeof ref === "string" && structuredUserReferenceKey(ref))) return value;
    }
  } catch { /* A missing or invalid projection is rebuilt from the source. */ }
  const refs = new Set<string>();
  let tail = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    const text = tail + chunk;
    addReferences(text, refs);
    tail = text.slice(-1_024);
    await yieldLoop();
  }
  if (!same(before, await stat(path))) throw new Error("retained transcript changed during metadata discovery");
  const value: SourceIndex = { version: 1, identity: before, refs: [...refs] };
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_INDEX_BYTES) throw new Error("metadata source projection exceeds its bound");
  const temporary = `${cache}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(body); } finally { await file.close(); }
    await rename(temporary, cache);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  return value;
}

async function walk(root: string, paths: Set<string>, directories: Set<string>, directorySources: Map<string, Identity>): Promise<void> {
  let canonical: string;
  try { canonical = await realpath(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (directories.has(canonical)) return;
  directories.add(canonical);
  directorySources.set(canonical, identity(await stat(canonical)));
  for await (const entry of await opendir(canonical)) {
    const path = join(canonical, entry.name);
    const info = entry.isSymbolicLink() ? await stat(path) : null;
    if (entry.isDirectory() || info?.isDirectory()) await walk(path, paths, directories, directorySources);
    else if (entry.name.endsWith(".jsonl") && (entry.isFile() || info?.isFile())) paths.add(path);
    if (paths.size > MAX_REFS || directories.size > MAX_REFS) throw new Error("retained inventory exceeds its bound");
  }
}

async function queuedReferences(refs: Set<string>): Promise<void> {
  const path = process.env.LLV_RUNTIME_JOURNAL || statePath("runtime-events.sqlite");
  try { await stat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  // Read only: never open the runtime journal's migrating writer here. Zero
  // busy timeout makes contention a refused collection, with no loop wait.
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("metadata retention requires the Bun runtime");
  const db = new sqlite.Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const maximum = db.query<{ n: number | null }, []>("SELECT MAX(rowid) AS n FROM native_queue_entries").get()!.n ?? 0;
    const query = db.query<{ rowid: number; state_json: string | null }, [number, number]>(
      `SELECT rowid, CASE WHEN length(CAST(state_json AS BLOB)) <= ${MAX_INDEX_BYTES} THEN state_json ELSE NULL END AS state_json
       FROM native_queue_entries WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 1`);
    let cursor = 0;
    let visited = 0;
    for (;;) {
      const rows = query.all(cursor, maximum);
      if (!rows.length) break;
      for (const row of rows) {
        if (++visited > MAX_REFS) throw new Error("native queue inventory exceeds its bound");
        if (row.state_json === null) throw new Error("native queue metadata inventory exceeds its bound");
        JSON.parse(row.state_json); // A damaged journal cannot prove absence.
        addReferences(row.state_json, refs);
        cursor = row.rowid;
      }
      await yieldLoop();
    }
  } finally { db.close(); }
}

export interface MetadataRetentionOptions {
  /** Full retained roots include copies outside the board's deduplicated window. */
  roots?: readonly string[] | (() => readonly string[]);
  /** False means a root provider could only return a degraded fallback. */
  rootsComplete?: () => boolean;
  /** The root set itself must remain unchanged while a destructive pass runs. */
  rootsCurrent?: () => boolean;
  current?: () => boolean;
}

/** Daily background mark-and-sweep. Every retained source must be readable and
 * stable. Missing discovery or a changed source refuses all deletion. New and
 * retried deliveries get thirty days to reach a rollout; queued input is also
 * a root. Shared async admission orders collection against publication. */
export async function collectStructuredUserMetadata(feed: TranscriptIndexFeed, options: MetadataRetentionOptions = {}) {
  return withViewerOperation("structured-user.retention", async () => {
    if (!feed.complete || options.current?.() === false) return { removed: 0, complete: false };
    const paths = new Set(feed.sources.map(source => source.path));
    if (paths.size > MAX_REFS) throw new Error("retained inventory exceeds its bound");
    const directories = new Set<string>();
    const directorySources = new Map<string, Identity>();
    if (options.rootsComplete?.() === false) return { removed: 0, complete: false };
    const roots = typeof options.roots === "function" ? options.roots() : options.roots ?? [];
    for (const root of roots) await walk(root, paths, directories, directorySources);
    const cache = statePath("structured-user-reference-index");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const refs = new Set<string>();
    const sources = new Map<string, Identity>();
    for (const path of paths) {
      const source = await sourceReferences(path, cache);
      sources.set(path, source.identity);
      for (const ref of source.refs) refs.add(ref);
      if (refs.size > MAX_REFS) throw new Error("metadata reference inventory exceeds its bound");
    }
    await queuedReferences(refs);
    const assertCensusCurrent = async () => {
      if (options.current?.() === false || options.rootsComplete?.() === false || options.rootsCurrent?.() === false) {
        throw new Error("metadata reference inventory was superseded");
      }
      for (const [sourcePath, before] of sources) {
        if (!same(before, await stat(sourcePath))) throw new Error("metadata reference inventory changed");
      }
      for (const [directoryPath, before] of directorySources) {
        if (!same(before, await stat(directoryPath))) throw new Error("metadata root inventory changed");
      }
    };
    // Validate the complete discovery before the first destructive effect.
    await assertCensusCurrent();
    if (options.current?.() === false) return { removed: 0, complete: false };
    const cutoff = (feed.listedAt ?? Date.now()) - GRACE_MS;
    const directory = statePath("structured-user-metadata");
    let removed = 0;
    let entries;
    try { entries = await opendir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed, complete: true }; throw error; }
    for await (const entry of entries) {
      const match = /^([hoad])-([a-f0-9]{64})(?:-([A-Za-z0-9_-]{16}))?\.json$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const ref = `${match[1]}.${Buffer.from(match[2], "hex").toString("base64url")}${match[3] ? `.${match[3]}` : ""}`;
      if (refs.has(ref)) continue;
      const path = join(directory, entry.name);
      await withFileTransaction(join(directory, "..", "structured-user-metadata-publication"), "metadata collection is busy", async () => {
        // Publication admission can wait. Revalidate sources and root authority
        // inside the lock, immediately before each destructive operation.
        await assertCensusCurrent();
        const current = await stat(path);
        if (current.mtimeMs >= cutoff) return;
        await assertCensusCurrent();
        const recovery = `${path}.${randomUUID()}.retention-recovery`;
        await link(path, recovery);
        try {
          await unlink(path);
          try { await assertCensusCurrent(); }
          catch (error) {
            await link(recovery, path);
            throw error;
          }
        } finally { await unlink(recovery).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
        removed++;
      });
      if (removed >= 256) break;
    }
    // Drop source projections whose files no longer exist in the full census.
    const retainedCaches = new Set([...paths].map(path => `${createHash("sha256").update(path).digest("hex")}.json`));
    for await (const entry of await opendir(cache)) {
      if (/^[a-f0-9]{64}\.json$/.test(entry.name) && !retainedCaches.has(entry.name)) await unlink(join(cache, entry.name));
    }
    return { removed, complete: true };
  });
}

/** The throttle lives on disk, so restarts do not renew whole-corpus work. */
export async function maybeCollectStructuredUserMetadata(feed: TranscriptIndexFeed, options: MetadataRetentionOptions = {}) {
  if (!feed.complete || options.current?.() === false) return;
  const checkpoint = statePath("structured-user-retention.json");
  await withViewerOperation("structured-user.retention", () => withFileTransaction(checkpoint, "metadata retention is busy", async () => {
    try {
      if ((await stat(checkpoint)).size > 1_024) throw new Error("invalid retention checkpoint");
      const previous = JSON.parse(await readFile(checkpoint, "utf8"));
      const previousAt = previous.attemptedAt ?? previous.completedAt;
      const elapsed = Date.now() - previousAt;
      if (Number.isFinite(previousAt) && elapsed >= 0 && elapsed < INTERVAL_MS) return;
    } catch { /* First pass or an invalid checkpoint must discover references. */ }
    const attemptedAt = Date.now();
    const checkpointWrite = async (value: { attemptedAt: number; completedAt?: number }) => {
      await mkdir(dirname(checkpoint), { recursive: true });
      const temporary = `${checkpoint}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, checkpoint);
        const parent = await open(dirname(checkpoint), "r");
        try { await parent.sync(); } finally { await parent.close(); }
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    };
    // A refused census is also bounded across scans and process restarts.
    await checkpointWrite({ attemptedAt });
    const result = await collectStructuredUserMetadata(feed, options);
    if (!result.complete) return;
    await checkpointWrite({ attemptedAt, completedAt: Date.now() });
  }));
}
