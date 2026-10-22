import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { stateDir } from "@/lib/configDir";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { readMemorySourceFile, restoreMemorySourceAfterImport } from "./source";
import { assertPrivateImportDatabaseFiles, importCollection, withImportLookups, readImportRecord, writeImportRows } from "./importStore";
import { candidateById, candidateKey } from "./importCuration";
import { validateImportId } from "./importTypes";
import type { ImportCandidate, ImportManifest, ImportManifestFile, ImportRecord, ImportRequest, ImportRoots, ImportWriter } from "./importTypes";
import { ImportCandidates, importOccurrenceIds, topicMetadata } from "./importCandidates";
import { commitImportManifest, pruneMemoryBackups } from "./importBackup";
import { canonicalProject } from "@/lib/projects/aliases";
import { guardedContext } from "@/lib/stateOwnership";
import { waitForStateLock } from "@/lib/state/lockWait";
import { MEMORY_SYNC_MAX_FILES, memorySyncIntervalHours } from "./importSync";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
async function resolvedDestination(target: string) {
  let existing = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try { await fs.lstat(existing); break; }
    catch (error) { if (!missing(error)) throw error; suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
  }
  return path.resolve(await fs.realpath(existing), ...suffix);
}
async function sourceStoreRoots(roots: ImportRoots) {
  const stores: string[] = [];
  async function add(directory: string) {
    try {
      const physical = await fs.realpath(directory);
      if ((await fs.stat(physical)).isDirectory()) stores.push(physical);
    } catch (error) { if (!missing(error)) throw error; }
  }
  for (const home of roots.claudeHomes) {
    let projects: string[];
    try { projects = await fs.readdir(path.join(home, "projects")); }
    catch (error) { if (missing(error)) continue; throw error; }
    for (const slug of projects) await add(path.join(home, "projects", slug, "memory"));
  }
  for (const home of roots.codexHomes) await add(path.join(home, "memories"));
  return stores;
}
async function sourceStoresAreSeparate(directory: string, roots: ImportRoots) {
  try {
    const [state, stores] = await Promise.all([resolvedDestination(directory), sourceStoreRoots(roots)]);
    return !stores.some(store => within(store, state) || within(state, store));
  } catch { return false; }
}
export class MemoryImportError extends Error {
  constructor(readonly reason: NonNullable<ImportRecord["reason"]>) { super(`memory import: ${reason}`); }
}
export class MemoryImportRecoveryError extends AggregateError {
  constructor(readonly reason: NonNullable<ImportRecord["reason"]>, readonly statusPersistenceFailed: boolean, readonly sourceRestorationFailed: boolean, errors: unknown[]) {
    super(errors, `memory import: ${reason};${statusPersistenceFailed ? " status persistence failed;" : ""}${sourceRestorationFailed ? " memory source restoration failed" : ""}`);
    this.name = "MemoryImportRecoveryError";
  }
}
export type ImportWorkPorts = {
  hostProject?: string;
  projectForSlug?: (slug: string) => string | Promise<string>;
  writer?: (session: string) => Promise<ImportWriter>;
  /** Integrity/race seam at the real copy boundary; never crosses the helper protocol. */
  afterCopy?: (file: string, source: string) => Promise<void>;
  phase?: (phase: "backup" | "candidates" | "retention") => void;
  /** Deterministic persistence boundary used to exercise retries between batches. */
  beforeCandidateBatch?: (index: number) => void;
};
async function digest(file: string) {
  const sum = createHash("sha256");
  for await (const chunk of createReadStream(file)) sum.update(chunk);
  return sum.digest("hex");
}
async function privateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MemoryImportError("backup_refused");
  await fs.chmod(directory, 0o700);
}
async function outsideCheckout(directory: string) {
  let lexical = path.resolve(directory);
  try {
    const own = await fs.lstat(lexical);
    const isDirectory = own.isSymbolicLink() ? (await fs.stat(lexical).catch(error => { if (missing(error)) return null; throw error; }))?.isDirectory() : own.isDirectory();
    if (!isDirectory) lexical = path.dirname(lexical);
  }
  catch (error) { if (!missing(error)) throw error; }
  for (let current = lexical; ; current = path.dirname(current)) {
    try { await fs.lstat(path.join(current, ".git")); throw new MemoryImportError("backup_refused"); }
    catch (error) { if (!missing(error)) throw error; }
    if (path.dirname(current) === current) break;
  }
  let existing = lexical;
  for (;;) {
    try { await fs.lstat(existing); break; }
    catch (error) { if (!missing(error)) throw error; existing = path.dirname(existing); }
  }
  let physical = await fs.realpath(existing);
  if (!(await fs.stat(physical)).isDirectory()) physical = path.dirname(physical);
  for (let current = physical; ; current = path.dirname(current)) {
    try { await fs.lstat(path.join(current, ".git")); throw new MemoryImportError("backup_refused"); }
    catch (error) { if (!missing(error)) throw error; }
    if (path.dirname(current) === current) break;
  }
}
async function rejectPreflight(error: unknown, request: ImportRequest, roots: ImportRoots, syncAt?: string): Promise<never> {
  if (!(await sourceStoresAreSeparate(stateDir(), roots))) throw error;
  // A sync refused before its lock still spends its attempt, so the next refresh waits (§4.9).
  if (request.sync && syncAt) await recordSyncAttempt(request.importId, syncAt, { result: "failed", added: 0, reason: error instanceof MemoryImportError ? error.reason : "failed" });
  try { await restoreMemorySourceAfterImport(request.importId, request.previous); }
  catch (restoreError) {
    const reason = error instanceof MemoryImportError ? error.reason : "backup_refused";
    throw new MemoryImportRecoveryError(reason, false, true, [error, restoreError]);
  }
  throw error;
}
/** Writes this attempt's sync marker on the ready import. Its outcome replaces only this
    attempt's own marker, so a refusal before the marker (the source moved) writes nothing
    and a slower attempt never overwrites a newer one. */
async function recordSyncAttempt(importId: string, lastAt: string, run: Omit<NonNullable<ImportRecord["sync"]>, "lastAt">) {
  const sync = { lastAt, ...run };
  await waitForStateLock("memory.import", () => {
    const record = readImportRecord(importId);
    if (record?.state !== "ready") return;
    if (run.result !== "running" && (record.sync?.lastAt !== lastAt || record.sync.result !== "running")) return;
    importCollection(true)!.boundedPatch(1, tx => tx.put({ ...record, sync }));
  });
}
export async function defaultImportRoots(): Promise<ImportRoots> {
  if (guardedContext()) throw new MemoryImportError("backup_refused");
  const home = os.homedir(), managed = path.join(path.dirname(stateDir()), "accounts");
  const homes = async (engine: string) => {
    try { return (await fs.readdir(path.join(managed, engine), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(managed, engine, entry.name)); }
    catch (error) { if (missing(error)) return []; throw error; }
  };
  return { claudeHomes: [process.env.LLV_CLAUDE_HOME || path.join(home, ".claude"), ...await homes("claude")], codexHomes: [process.env.LLV_CODEX_HOME || path.join(home, ".codex"), ...await homes("codex")] };
}
function assertCurrent(id: string, rescan = false, sync = false) {
  const source = readMemorySourceFile();
  // A sync extends the ready import only while the engines' memory is selected and the sync is on (§4.9).
  if (sync) {
    if (source?.source !== "engines" || source.importId !== id || memorySyncIntervalHours() <= 0) throw new MemoryImportError("source_changed");
    return;
  }
  if (source?.source !== "delegatus" || (!rescan && source.phase !== "importing" || rescan && !["importing", "draining"].includes(source.phase!)) || source.importId !== id) throw new MemoryImportError("source_changed");
}

async function inventory(roots: ImportRoots, projectForSlug: (slug: string) => string | Promise<string>) {
  const files: (Omit<ImportManifestFile, "copy" | "sha256"> & { source: string; store: string; physical: string })[] = [];
  const stores = new Set<string>();
  const seenStores = new Set<string>(), seenFiles = new Map<string, number>();
  const identityPriority = (kind: ImportManifestFile["kind"], relative: string) => kind === "claude_index" ? relative === "MEMORY.md" ? 4 : 3 : kind === "codex_summary" ? 3 : kind === "history" ? 2 : 1;
  async function store(engine: "claude" | "codex", home: string, directory: string, project: string | null) {
    let real: string;
    try { real = await fs.realpath(directory); } catch (error) { if (missing(error)) return; throw error; }
    if (seenStores.has(real)) return;
    seenStores.add(real);
    stores.add(real);
    const seen = new Set<string>();
    async function walk(current: string, depth: number) {
      if (depth > 64) throw new MemoryImportError("backup_refused");
      const physical = await fs.realpath(current);
      if (!within(real, physical)) throw new MemoryImportError("backup_refused");
      if (seen.has(physical)) return;
      seen.add(physical);
      for (const name of (await fs.readdir(physical)).sort()) {
        const entry = path.join(physical, name), resolved = await fs.realpath(entry);
        if (!within(real, resolved)) throw new MemoryImportError("backup_refused");
        const stat = await fs.stat(entry);
        if (stat.isDirectory()) await walk(resolved, depth + 1);
        else if (stat.isFile()) {
          const relative = path.relative(real, resolved), canonicalName = path.basename(resolved);
          const kind: ImportManifestFile["kind"] = engine === "claude" ? canonicalName === "MEMORY.md" ? "claude_index" : canonicalName.endsWith(".md") && !["CLAUDE.md", "AGENTS.md", "SKILL.md"].includes(canonicalName) && !relative.split(path.sep).some(segment => ["rules", "skills", ".git"].includes(segment)) ? "claude_topic" : "history"
            : relative === "memory_summary.md" ? "codex_summary" : "history";
          const loadedAtStart = kind === "codex_summary" || kind === "claude_index" && relative === "MEMORY.md";
          const existing = seenFiles.get(resolved);
          const source = path.join(directory, relative);
          const current = { source, store: directory, physical: resolved, home, file: path.relative(home, source), engine, kind, size: stat.size, modifiedAt: stat.mtime.toISOString(), project, loadedAtStart };
          if (existing === undefined) {
            seenFiles.set(resolved, files.length);
            files.push(current);
          } else {
            const prior = files[existing]!;
            const priorRelative = path.relative(prior.store, prior.source);
            if (identityPriority(kind, relative) > identityPriority(prior.kind, priorRelative)) files[existing] = current;
          }
        } else if (!stat.isDirectory() && !stat.isFile()) throw new MemoryImportError("backup_refused");
      }
    }
      await walk(real, 0);
  }
  for (const home of [...roots.claudeHomes].sort()) {
    let slugs: string[];
    try { slugs = (await fs.readdir(path.join(home, "projects"))).sort(); } catch (error) { if (missing(error)) continue; throw error; }
    for (const slug of slugs) await store("claude", home, path.join(home, "projects", slug, "memory"), canonicalProject(await projectForSlug(slug)));
  }
  for (const home of [...roots.codexHomes].sort()) await store("codex", home, path.join(home, "memories"), null);
  return { files, stores: [...stores] };
}

/** Disk and hashing work is called by the leased job helper, never by a route. */
export async function runMemoryImportWork(request: ImportRequest, ports: ImportWorkPorts = {}): Promise<ImportRecord> {
  validateImportId(request.importId);
  const directory = stateDir();
  const sync = request.sync === true;
  const syncAt = new Date(request.at ?? Date.now()).toISOString();
  // A sync is a delta scan of the same verified backup (§4.6 step 2, §4.9).
  const rescan = request.rescan === true || sync;
  const assertOwned = () => assertCurrent(request.importId, rescan, sync);
  const backups = path.join(directory, "backups"), parent = path.join(backups, "engine-memory");
  let files: Awaited<ReturnType<typeof inventory>>["files"], stores: string[];
  let roots: ImportRoots | undefined;
  let sourceSeparationProven = false;
  try {
    // A sync scans the very roots its import recorded.
    roots = request.roots ?? (sync ? readImportRecord(request.importId)?.roots : undefined) ?? await defaultImportRoots();
    sourceSeparationProven = await sourceStoresAreSeparate(directory, roots);
    if (!sourceSeparationProven) throw new MemoryImportError("backup_refused");
    // Once the state directory is proven apart from every engine store, a sync marks its
    // attempt before the inventory, the lock wait and every copy: a helper its deadline or
    // a crash ends in any of them leaves the marker, which defers the retry by an hour (§4.9).
    if (sync) { assertOwned(); await recordSyncAttempt(request.importId, syncAt, { result: "running", added: 0 }); }
    await outsideCheckout(directory);
    await outsideCheckout(path.join(directory, "state.sqlite"));
    assertPrivateImportDatabaseFiles(path.join(directory, "state.sqlite"));
    ({ files, stores } = await inventory(roots, ports.projectForSlug ?? (await import("@/lib/scanner/describe")).projectForClaudeMemorySlug));
  }
  catch (error) {
    if (roots && await sourceStoresAreSeparate(directory, roots)) return rejectPreflight(error, request, roots, syncAt);
    throw error;
  }
  const transaction = path.join(parent, "import-job");
  const lockPath = `${transaction}.write-lock`;
  const queuePath = `${transaction}.write-locks`;
  try {
    for (const [target, expected] of [[directory, "directory"], [backups, "directory"], [parent, "directory"], [path.join(directory, "state.sqlite"), "file"], [transaction, "none"], [lockPath, "lock"], [queuePath, "queue"]] as const) {
      const stat = await fs.lstat(target).catch(error => { if (missing(error)) return null; throw error; });
      if (stat && (expected === "directory" && (!stat.isDirectory() || stat.isSymbolicLink()) || expected === "file" && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) || expected === "none" || expected === "lock" && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) || expected === "queue" && (!stat.isDirectory() || stat.isSymbolicLink()))) throw new MemoryImportError("backup_refused");
    }
    for (const target of [directory, backups, parent, path.join(directory, "state.sqlite"), transaction, lockPath, queuePath]) {
      const resolved = await resolvedDestination(target);
      if (stores.some(store => within(store, resolved) || within(resolved, store))) throw new MemoryImportError("backup_refused");
    }
  } catch (error) {
    const state = await resolvedDestination(directory);
    if (stores.some(store => within(store, state) || within(state, store))) throw error;
    return rejectPreflight(error, request, roots!, syncAt);
  }
  await privateDirectory(directory);
  await privateDirectory(backups); await privateDirectory(parent); await outsideCheckout(parent);
  let admitted = false;
  return withFileTransaction(path.join(parent, "import-job"), "memory import busy", async () => {
    admitted = true;
    assertOwned();
    const prior = readImportRecord(request.importId);
    if (prior?.state === "ready" && !rescan) return prior;
    if (sync && prior?.state !== "ready") throw new MemoryImportError("source_changed");
    let hashed = 0, capped = false;
    const record: ImportRecord = prior?.state === "ready" ? { ...prior } : { kind: "import", id: request.importId, state: "copying", at: new Date(request.at ?? Date.now()).toISOString(), previous: prior ? prior.previous : request.previous, backup: path.join(parent, request.importId), files: 0, candidates: 0, parts: 0 };
    // The marker written before the inventory, kept on the record this run rewrites (§4.9).
    if (sync) record.sync = { lastAt: syncAt, result: "running", added: 0 };
    await writeImportRows([record], assertOwned);
    try {
      ports.phase?.("backup");
      try { if (!rescan) await fs.mkdir(record.backup, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryImportError("interrupted"); throw error; }
      if (record.backup !== path.join(parent, request.importId)) throw new MemoryImportError("backup_refused");
      if (rescan) await privateDirectory(record.backup);
      const manifest: ImportManifest = rescan ? JSON.parse(await fs.readFile(path.join(record.backup, "manifest.json"), "utf8")) : { schemaVersion: 1, importId: record.id, createdAt: record.at, files: [] };
      if (manifest.schemaVersion !== 1 || manifest.importId !== record.id || !Array.isArray(manifest.files)) throw new MemoryImportError("integrity");
      const newFiles: { file: typeof files[number]; entry: ImportManifestFile; copied: boolean }[] = [];
      for (const file of files) {
        assertOwned();
        const { source, store, ...entry } = file;
        const previous = manifest.files.findLast(entry => entry.home === file.home && entry.file === file.file);
        const recover = (entry: ImportManifestFile) => entry.kind === "claude_topic" || entry.kind === "codex_summary";
        if (rescan && previous?.size === file.size && previous.modifiedAt === file.modifiedAt) {
          if (previous.candidatesComplete !== true && recover(previous)) newFiles.push({ file, entry: previous, copied: false });
          continue;
        }
        if (sync && hashed >= MEMORY_SYNC_MAX_FILES) { capped = true; continue; }
        hashed += 1;
        const sourceHash = await digest(source);
        if (previous?.sha256 === sourceHash) {
          // Same bytes, newer time: a sync records it so the prefilter skips the file next run.
          if (sync) Object.assign(previous, { size: file.size, modifiedAt: file.modifiedAt });
          if (rescan && previous.candidatesComplete !== true && recover(previous)) newFiles.push({ file, entry: previous, copied: false });
          continue;
        }
        const copy = path.join("stores", hash(await fs.realpath(store)).slice(0, 16), ...(rescan ? ["versions", sourceHash, randomUUID()] : []), path.relative(store, source));
        const destination = path.join(record.backup, copy);
        const resolved = await resolvedDestination(destination);
        if (!within(await fs.realpath(directory), resolved) || stores.some(store => within(store, resolved) || within(resolved, store))) throw new MemoryImportError("backup_refused");
        await privateDirectory(path.dirname(destination));
        const sourceStat = await fs.stat(source);
        if (sourceStat.size !== file.size || sourceStat.mtime.toISOString() !== file.modifiedAt) throw new MemoryImportError("integrity");
        await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
        await ports.afterCopy?.(destination, source);
        if (await digest(destination) !== sourceHash || await digest(source) !== sourceHash) throw new MemoryImportError("integrity");
        const handle = await fs.open(destination, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
        const copied = { ...entry, copy, sha256: sourceHash };
        manifest.files.push(copied); newFiles.push({ file, entry: copied, copied: true });
      }
      // A worker may stop after the manifest commit or between candidate batches.
      // Rebuild every unfinished copy from its verified backup even if its source
      // disappeared or now has a different version.
      const scheduledCopies = new Set(newFiles.map(item => item.entry.copy));
      for (const entry of manifest.files) {
        if (entry.candidatesComplete === true || entry.kind !== "claude_topic" && entry.kind !== "codex_summary" || scheduledCopies.has(entry.copy)) continue;
        const source = path.join(entry.home, entry.file);
        newFiles.push({ file: { ...entry, source, store: path.dirname(source), physical: source }, entry, copied: false });
      }
      // All copies pass before the first candidate is committed.
      ports.phase?.("candidates");
      const loaded = new Set<string>();
      for (const file of files) {
        if (file.kind !== "claude_index" || !file.loadedAtStart) continue;
        const entry = manifest.files.findLast(entry => entry.home === file.home && entry.file === file.file);
        // A sync's capped run leaves later files, indexes included, for its next run.
        if (!entry && capped) continue;
        if (!entry) throw new MemoryImportError("integrity");
        const text = await fs.readFile(path.join(record.backup, entry.copy), "utf8");
        for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
          try { loaded.add(await fs.realpath(path.resolve(path.dirname(file.source), match[1]))); }
          catch (error) { if (!missing(error)) throw error; }
        }
      }
      let resolveWriter = ports.writer;
      const addBackupFile = async (builder: ImportCandidates, item: typeof newFiles[number]) => {
        const { file, entry, copied } = item;
        if (entry.kind !== "claude_topic" && entry.kind !== "codex_summary") return;
        const backupFile = path.join(record.backup, entry.copy);
        const bytes = await fs.readFile(backupFile);
        const body = bytes.toString("utf8");
        if (!Buffer.from(body).equals(bytes) || await digest(backupFile) !== entry.sha256) throw new MemoryImportError("integrity");
        entry.loadedAtStart = rescan ? !copied && entry.loadedAtStart : entry.loadedAtStart || loaded.has(file.physical);
        const session = entry.engine === "claude" ? topicMetadata(body).session : undefined;
        if (session && !resolveWriter) resolveWriter = await (await import("./importWriter")).productionImportWriter();
        builder.add(entry, body, session ? await resolveWriter!(session) : undefined);
        return body;
      };
      const builder = new ImportCandidates(record.id);
      for (const item of newFiles) {
        if (item.entry.kind === "claude_topic" || item.entry.kind === "codex_summary") await addBackupFile(builder, item);
      }
      const builtCandidates = builder.rows();
      const candidates: ImportCandidate[] = [];
      const recoveryFiles = manifest.files.filter(entry => entry.kind === "claude_topic" || entry.kind === "codex_summary").map(entry =>
        newFiles.find(item => item.entry.copy === entry.copy) ?? {
          file: { ...entry, source: path.join(entry.home, entry.file), store: path.dirname(path.join(entry.home, entry.file)), physical: path.join(entry.home, entry.file) },
          entry, copied: false,
        });
      const groups = new Map<string, ImportCandidate[]>();
      for (const candidate of builtCandidates) {
        const group = groups.get(candidate.group) ?? [];
        group.push(candidate); groups.set(candidate.group, group);
      }
      for (const [groupId, incoming] of groups) {
        const collection = importCollection(true)!;
        const prefix = `c:${record.id}:${groupId}:`;
        const existing: ImportCandidate[] = [];
        let cursor = prefix;
        for (;;) {
          const page = collection.keyRangeEntries(cursor, `${prefix}\uffff`, 40);
          existing.push(...page.flatMap(row => row.value?.kind === "candidate" ? [row.value] : []));
          if (page.length < 40) break;
          cursor = page.at(-1)!.key;
        }
        if (existing.length === 0) {
          candidates.push(...incoming);
          continue;
        }
        const canonicalCount = existing[0].part.of;
        const canonical = existing.length === canonicalCount
          && existing.every((row, index) => row.part.of === canonicalCount && row.part.index === index);
        let topology = canonical ? existing : null;
        if (!topology) {
          // The first committed occurrence fixes a group's byte topology. A
          // later whitespace-equivalent copy may split differently, so rebuild
          // that topology from the verified backup that established it.
          const establishedOccurrence = existing[0].occurrences[0];
          for (const item of recoveryFiles) {
            if (item.entry.file !== establishedOccurrence.file || item.entry.sha256 !== establishedOccurrence.sha256
              || item.entry.project !== establishedOccurrence.project) continue;
            const recoveredBuilder = new ImportCandidates(record.id);
            await addBackupFile(recoveredBuilder, item);
            const recovered = recoveredBuilder.rows().filter(row => row.group === groupId);
            if (recovered.some(row => row.occurrences.some(occurrence => occurrence.id === establishedOccurrence.id))) {
              topology = recovered.sort((a, b) => a.part.index - b.part.index);
              break;
            }
          }
          if (!topology || topology.length !== canonicalCount
            || topology.some((row, index) => row.part.index !== index || row.part.of !== canonicalCount)) {
            throw new MemoryImportError("integrity");
          }
          for (const prior of existing) {
            const recovered = topology[prior.part.index];
            if (!recovered || recovered.id !== prior.id || recovered.body !== prior.body
              || recovered.contentSha256 !== prior.contentSha256) throw new MemoryImportError("integrity");
          }
        }
        const occurrences = new Map(incoming.flatMap(row => row.occurrences).map(item => [item.id, item]));
        const linked = [...new Set(incoming.flatMap(row => row.linked))];
        for (const row of topology) {
          candidates.push({ ...row,
            linked: [...new Set([...row.linked, ...linked])],
            occurrences: [...row.occurrences, ...[...occurrences.values()].filter(item => !row.occurrences.some(prior => prior.id === item.id))],
            loadedAtStart: row.loadedAtStart || incoming.some(item => item.loadedAtStart),
          });
        }
      }
      const missingCandidates = candidates.filter(candidate => !candidateById(record.id, candidate.id));
      // Recheck copied changes after every asynchronous writer lookup.
      for (const { file, entry, copied } of newFiles) {
        if (copied && await digest(file.source) !== entry.sha256 || await digest(path.join(record.backup, entry.copy)) !== entry.sha256) throw new MemoryImportError("integrity");
      }
      const [{ default: manifestMetadata }, { viewerRepositoryProjects }, { orchestratorSeatFor }] = await Promise.all([
        import("../../../package.json"), import("@/lib/projects/viewerRepository"), import("@/lib/orchestrator/seats"),
      ]);
      // Packaged releases have no checkout identity. Use the same durable
      // release remote as the Viewer's own-project authorization boundary.
      const projects = viewerRepositoryProjects(process.env.LLV_VIEWER_CANONICAL_REMOTE?.trim() || manifestMetadata.repository.url, process.cwd()).map(canonicalProject);
      record.hostProject ??= ports.hostProject ?? projects.find(project => orchestratorSeatFor(project).active) ?? projects[0];
      if (!record.hostProject) throw new MemoryImportError("backup_refused");
      record.roots ??= roots;
      const { inheritImportDispositions } = await import("./importHistory");
      for (const candidate of candidates) {
        const project = candidate.occurrences[0].project;
        candidate.curationProject = project && orchestratorSeatFor(project).active ? project : record.hostProject;
        if (!rescan) inheritImportDispositions(candidate);
        // A sync offers only new content: equal content and applicability inherit (§4.9).
        else if (sync) inheritImportDispositions(candidate, { byContent: true, sameImport: true });
      }
      assertOwned();
      commitImportManifest(record.backup, manifest);
      for (let offset = 0, batchIndex = 0; offset < candidates.length; offset += 40, batchIndex++) {
        ports.beforeCandidateBatch?.(batchIndex);
        const batch = candidates.slice(offset, offset + 40);
        await importCollection(true)!.patch(() => {
          assertOwned();
          return { records: withImportLookups(batch.map(candidate => {
            const prior = importCollection()!.get(candidateKey(candidate));
            if (prior?.kind !== "candidate") return candidate;
            const added = (id: string) => !prior.occurrences.some(p => p.id === id);
            return { ...prior, linked: [...new Set([...prior.linked, ...candidate.linked])], occurrences: [...prior.occurrences, ...candidate.occurrences.filter(o => added(o.id))],
              // Only an inherited disposition of a new occurrence joins a stored row.
              dispositions: [...prior.dispositions, ...candidate.dispositions.filter(d => d.occurrences.length && d.occurrences.every(added))] };
          })) };
        });
      }
      for (const { entry } of newFiles) {
        if (entry.kind !== "claude_topic" && entry.kind !== "codex_summary") continue;
        const bytes = await fs.readFile(path.join(record.backup, entry.copy));
        const body = bytes.toString("utf8");
        if (!Buffer.from(body).equals(bytes) || await digest(path.join(record.backup, entry.copy)) !== entry.sha256) throw new MemoryImportError("integrity");
        const occurrenceIds = new Set(importOccurrenceIds(entry as ImportManifestFile, body));
        const expected = candidates.filter(candidate => candidate.occurrences.some(occurrence => occurrenceIds.has(occurrence.id)));
        const groups = new Map<string, ImportCandidate[]>();
        for (const candidate of expected) {
          const group = groups.get(candidate.group) ?? [];
          group.push(candidate); groups.set(candidate.group, group);
        }
        for (const rows of groups.values()) {
          const count = rows[0].part.of;
          if (rows.length !== count || rows.some((row, index) => row.part.of !== count || row.part.index !== index)) throw new MemoryImportError("integrity");
          const groupOccurrences = rows[0].occurrences.map(occurrence => occurrence.id).filter(id => occurrenceIds.has(id));
          for (const row of rows) {
            const persisted = candidateById(record.id, row.id);
            if (!persisted || persisted.group !== row.group || persisted.part.index !== row.part.index || persisted.part.of !== count
              || groupOccurrences.some(id => !row.occurrences.some(occurrence => occurrence.id === id)
                || !persisted.occurrences.some(occurrence => occurrence.id === id))) throw new MemoryImportError("integrity");
          }
        }
      }
      for (const { entry } of newFiles) entry.candidatesComplete = true;
      commitImportManifest(record.backup, manifest);
      ports.phase?.("retention");
      await pruneMemoryBackups(parent);
      if (sync) {
        // Files of this run with an occurrence that inherited no disposition.
        const fileOf = new Map<string, string>();
        for (const { entry } of newFiles) {
          if (entry.kind !== "claude_topic" && entry.kind !== "codex_summary") continue;
          const body = await fs.readFile(path.join(record.backup, entry.copy), "utf8");
          for (const id of importOccurrenceIds(entry as ImportManifestFile, body)) fileOf.set(id, entry.copy);
        }
        const offered = new Set<string>();
        for (const candidate of candidates) {
          const stored = candidateById(record.id, candidate.id);
          for (const occurrence of stored?.occurrences ?? []) {
            const file = fileOf.get(occurrence.id);
            if (file && !stored!.dispositions.some(d => d.occurrences.includes(occurrence.id))) offered.add(file);
          }
        }
        record.sync = { lastAt: syncAt, result: capped ? "capped" : "ok", added: offered.size };
      }
      Object.assign(record, { state: "ready", curationDirty: true, files: manifest.files.length,
        candidates: (rescan ? record.candidates : 0) + new Set(missingCandidates.map(row => row.group)).size,
        parts: (rescan ? record.parts : 0) + missingCandidates.length });
      delete record.reason;
      await writeImportRows([record], assertOwned);
      return record;
    } catch (error) {
      record.state = rescan ? "ready" : "failed"; record.reason = error instanceof MemoryImportError ? error.reason : "failed";
      if (sync) record.sync = { lastAt: syncAt, result: "failed", added: 0, reason: record.reason };
      let statusFailure: unknown, restoreFailure: unknown;
      if (!(await sourceStoresAreSeparate(directory, roots!))) throw error;
      try { await writeImportRows([record]); } catch (caught) { statusFailure = caught; }
      try {
        if (!(await sourceStoresAreSeparate(directory, roots!))) throw new MemoryImportError("backup_refused");
        await restoreMemorySourceAfterImport(record.id, record.previous);
      } catch (caught) { restoreFailure = caught; }
      if (statusFailure || restoreFailure) {
        const cause = error instanceof MemoryImportError ? error.reason : "failed";
        throw new MemoryImportRecoveryError(cause, Boolean(statusFailure), Boolean(restoreFailure), [error, ...[statusFailure, restoreFailure].filter(Boolean)]);
      }
      throw error;
    }
  }).catch(async error => {
    // A sync the lock refused (busy past the wait) records that failure in place of its marker.
    if (sync && !admitted && await sourceStoresAreSeparate(directory, roots!)) await recordSyncAttempt(request.importId, syncAt, { result: "failed", added: 0, reason: "failed" });
    throw error;
  });
}

/** Worker preflight for a ready import, before a phase or budget mutation. */
export async function validateMemoryImportEnvironment(roots: ImportRoots) {
  if (!(await sourceStoresAreSeparate(stateDir(), roots))) throw new MemoryImportError("backup_refused");
  await outsideCheckout(stateDir());
  assertPrivateImportDatabaseFiles();
}
