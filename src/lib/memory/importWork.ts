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
import { ImportCandidates, topicMetadata } from "./importCandidates";
import { commitImportManifest, pruneMemoryBackups } from "./importBackup";
import { canonicalProject } from "@/lib/projects/aliases";
import { guardedContext } from "@/lib/stateOwnership";

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
async function rejectPreflight(error: unknown, request: ImportRequest, roots: ImportRoots): Promise<never> {
  if (!(await sourceStoresAreSeparate(stateDir(), roots))) throw error;
  try { await restoreMemorySourceAfterImport(request.importId, request.previous); }
  catch (restoreError) {
    const reason = error instanceof MemoryImportError ? error.reason : "backup_refused";
    throw new MemoryImportRecoveryError(reason, false, true, [error, restoreError]);
  }
  throw error;
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
function assertCurrent(id: string, rescan = false) {
  const source = readMemorySourceFile();
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
  const assertOwned = () => assertCurrent(request.importId, request.rescan);
  const backups = path.join(directory, "backups"), parent = path.join(backups, "engine-memory");
  let files: Awaited<ReturnType<typeof inventory>>["files"], stores: string[];
  let roots: ImportRoots | undefined;
  let sourceSeparationProven = false;
  try {
    roots = request.roots ?? await defaultImportRoots();
    sourceSeparationProven = await sourceStoresAreSeparate(directory, roots);
    if (!sourceSeparationProven) throw new MemoryImportError("backup_refused");
    await outsideCheckout(directory);
    await outsideCheckout(path.join(directory, "state.sqlite"));
    assertPrivateImportDatabaseFiles(path.join(directory, "state.sqlite"));
    ({ files, stores } = await inventory(roots, ports.projectForSlug ?? (await import("@/lib/scanner/describe")).projectForClaudeMemorySlug));
  }
  catch (error) {
    if (roots && await sourceStoresAreSeparate(directory, roots)) return rejectPreflight(error, request, roots);
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
    return rejectPreflight(error, request, roots!);
  }
  await privateDirectory(directory);
  await privateDirectory(backups); await privateDirectory(parent); await outsideCheckout(parent);
  return withFileTransaction(path.join(parent, "import-job"), "memory import busy", async () => {
    assertOwned();
    const prior = readImportRecord(request.importId);
    if (prior?.state === "ready" && !request.rescan) return prior;
    const record: ImportRecord = prior?.state === "ready" ? { ...prior } : { kind: "import", id: request.importId, state: "copying", at: new Date(request.at ?? Date.now()).toISOString(), previous: prior ? prior.previous : request.previous, backup: path.join(parent, request.importId), files: 0, candidates: 0, parts: 0 };
    await writeImportRows([record], assertOwned);
    try {
      ports.phase?.("backup");
      try { if (!request.rescan) await fs.mkdir(record.backup, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryImportError("interrupted"); throw error; }
      if (record.backup !== path.join(parent, request.importId)) throw new MemoryImportError("backup_refused");
      if (request.rescan) await privateDirectory(record.backup);
      const manifest: ImportManifest = request.rescan ? JSON.parse(await fs.readFile(path.join(record.backup, "manifest.json"), "utf8")) : { schemaVersion: 1, importId: record.id, createdAt: record.at, files: [] };
      if (manifest.schemaVersion !== 1 || manifest.importId !== record.id || !Array.isArray(manifest.files)) throw new MemoryImportError("integrity");
      const newFiles: { file: typeof files[number]; entry: ImportManifestFile; copied: boolean }[] = [];
      for (const file of files) {
        assertOwned();
        const { source, store, ...entry } = file;
        const previous = manifest.files.findLast(entry => entry.home === file.home && entry.file === file.file);
        const recover = (entry: ImportManifestFile) => entry.kind === "claude_topic" || entry.kind === "codex_summary";
        if (request.rescan && previous?.size === file.size && previous.modifiedAt === file.modifiedAt) {
          if (previous.candidatesComplete !== true && recover(previous)) newFiles.push({ file, entry: previous, copied: false });
          continue;
        }
        const sourceHash = await digest(source);
        if (previous?.sha256 === sourceHash) {
          if (request.rescan && previous.candidatesComplete !== true && recover(previous)) newFiles.push({ file, entry: previous, copied: false });
          continue;
        }
        const copy = path.join("stores", hash(await fs.realpath(store)).slice(0, 16), ...(request.rescan ? ["versions", sourceHash, randomUUID()] : []), path.relative(store, source));
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
        if (!entry) throw new MemoryImportError("integrity");
        const text = await fs.readFile(path.join(record.backup, entry.copy), "utf8");
        for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
          try { loaded.add(await fs.realpath(path.resolve(path.dirname(file.source), match[1]))); }
          catch (error) { if (!missing(error)) throw error; }
        }
      }
      const builder = new ImportCandidates(record.id);
      let resolveWriter = ports.writer;
      for (const { file, entry, copied } of newFiles) {
        if (entry.kind !== "claude_topic" && entry.kind !== "codex_summary") continue;
        const bytes = await fs.readFile(path.join(record.backup, entry.copy));
        const body = bytes.toString("utf8");
        if (!Buffer.from(body).equals(bytes)) throw new MemoryImportError("integrity");
        entry.loadedAtStart = request.rescan ? !copied && entry.loadedAtStart : entry.loadedAtStart || loaded.has(file.physical);
        const session = entry.engine === "claude" ? topicMetadata(body).session : undefined;
        if (session && !resolveWriter) resolveWriter = await (await import("./importWriter")).productionImportWriter();
        builder.add(entry, body, session ? await resolveWriter!(session) : undefined);
      }
      const candidates: ImportCandidate[] = builder.rows();
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
        if (!request.rescan) inheritImportDispositions(candidate);
      }
      assertOwned();
      commitImportManifest(record.backup, manifest);
      for (let offset = 0; offset < candidates.length; offset += 40) {
        const batch = candidates.slice(offset, offset + 40);
        await importCollection(true)!.patch(() => {
          assertOwned();
          return { records: withImportLookups(batch.map(candidate => {
            const prior = importCollection()!.get(candidateKey(candidate));
            if (prior?.kind !== "candidate") return candidate;
            return { ...prior, linked: [...new Set([...prior.linked, ...candidate.linked])], occurrences: [...prior.occurrences, ...candidate.occurrences.filter(o => !prior.occurrences.some(p => p.id === o.id))] };
          })) };
        });
      }
      for (const { entry } of newFiles) entry.candidatesComplete = true;
      commitImportManifest(record.backup, manifest);
      ports.phase?.("retention");
      await pruneMemoryBackups(parent);
      Object.assign(record, { state: "ready", curationDirty: true, files: manifest.files.length,
        candidates: (request.rescan ? record.candidates : 0) + new Set(missingCandidates.map(row => row.group)).size,
        parts: (request.rescan ? record.parts : 0) + missingCandidates.length });
      delete record.reason;
      await writeImportRows([record], assertOwned);
      return record;
    } catch (error) {
      record.state = request.rescan ? "ready" : "failed"; record.reason = error instanceof MemoryImportError ? error.reason : "failed";
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
  });
}

/** Worker preflight for a ready import, before a phase or budget mutation. */
export async function validateMemoryImportEnvironment(roots: ImportRoots) {
  if (!(await sourceStoresAreSeparate(stateDir(), roots))) throw new MemoryImportError("backup_refused");
  await outsideCheckout(stateDir());
  assertPrivateImportDatabaseFiles();
}
