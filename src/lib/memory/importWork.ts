import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { stateDir } from "@/lib/configDir";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { readMemorySourceFile, restoreMemorySourceAfterImport } from "./source";
import { assertPrivateImportDatabaseFiles, readImportRecord, writeImportRows } from "./importStore";
import { validateImportId } from "./importTypes";
import type { ImportCandidate, ImportManifest, ImportManifestFile, ImportRecord, ImportRequest, ImportRoots, ImportWriter } from "./importTypes";
import { ImportCandidates, topicMetadata } from "./importCandidates";
import { commitImportManifest, pruneMemoryBackups } from "./importBackup";
import { canonicalProject } from "@/lib/projects/aliases";
import { guardedContext } from "@/lib/stateOwnership";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
export class MemoryImportError extends Error {
  constructor(readonly reason: NonNullable<ImportRecord["reason"]>) { super(`memory import: ${reason}`); }
}
export class MemoryImportRecoveryError extends AggregateError {
  constructor(readonly reason: NonNullable<ImportRecord["reason"]>, readonly statusPersistenceFailed: boolean, readonly sourceRestorationFailed: boolean, errors: unknown[]) {
    super(errors, `memory import: ${reason};${statusPersistenceFailed ? " status persistence failed;" : ""}${sourceRestorationFailed ? " memory source restoration failed" : ""}`);
    this.name = "MemoryImportRecoveryError";
  }
}
type Ports = {
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
async function rejectPreflight(error: unknown, request: ImportRequest): Promise<never> {
  try { await restoreMemorySourceAfterImport(request.importId, request.previous); }
  catch (restoreError) {
    const reason = error instanceof MemoryImportError ? error.reason : "backup_refused";
    throw new MemoryImportRecoveryError(reason, false, true, [error, restoreError]);
  }
  throw error;
}
async function defaultRoots(): Promise<ImportRoots> {
  if (guardedContext()) throw new MemoryImportError("backup_refused");
  const home = os.homedir(), managed = path.join(path.dirname(stateDir()), "accounts");
  const homes = async (engine: string) => {
    try { return (await fs.readdir(path.join(managed, engine), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(managed, engine, entry.name)); }
    catch (error) { if (missing(error)) return []; throw error; }
  };
  return { claudeHomes: [process.env.LLV_CLAUDE_HOME || path.join(home, ".claude"), ...await homes("claude")], codexHomes: [process.env.LLV_CODEX_HOME || path.join(home, ".codex"), ...await homes("codex")] };
}
function assertCurrent(id: string) {
  const source = readMemorySourceFile();
  if (source?.source !== "delegatus" || source.phase !== "importing" || source.importId !== id) throw new MemoryImportError("source_changed");
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
      for (const name of (await fs.readdir(current)).sort()) {
        const source = path.join(current, name), resolved = await fs.realpath(source);
        if (!within(real, resolved)) throw new MemoryImportError("backup_refused");
        const stat = await fs.stat(source);
        if (stat.isDirectory()) await walk(source, depth + 1);
        else if (stat.isFile()) {
          const relative = path.relative(directory, source);
          const kind: ImportManifestFile["kind"] = engine === "claude" ? name === "MEMORY.md" ? "claude_index" : name.endsWith(".md") && !["CLAUDE.md", "AGENTS.md", "SKILL.md"].includes(name) && !relative.split(path.sep).some(segment => ["rules", "skills", ".git"].includes(segment)) ? "claude_topic" : "history"
            : relative === "memory_summary.md" ? "codex_summary" : "history";
          const loadedAtStart = kind === "codex_summary" || kind === "claude_index" && relative === "MEMORY.md";
          const existing = seenFiles.get(resolved);
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
    await walk(directory, 0);
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
export async function runMemoryImportWork(request: ImportRequest, ports: Ports = {}): Promise<ImportRecord> {
  validateImportId(request.importId);
  const directory = stateDir();
  const backups = path.join(directory, "backups"), parent = path.join(backups, "engine-memory");
  let files: Awaited<ReturnType<typeof inventory>>["files"], stores: string[];
  try {
    await outsideCheckout(directory);
    await outsideCheckout(path.join(directory, "state.sqlite"));
    assertPrivateImportDatabaseFiles(path.join(directory, "state.sqlite"));
    if (!request.roots && guardedContext()) throw new MemoryImportError("backup_refused");
    const roots = request.roots ?? await defaultRoots();
    ({ files, stores } = await inventory(roots, ports.projectForSlug ?? (await import("@/lib/scanner/describe")).projectForClaudeMemorySlug));
  }
  catch (error) { return rejectPreflight(error, request); }
  const resolvedDestination = async (target: string) => {
    let existing = path.resolve(target);
    const suffix: string[] = [];
    for (;;) {
      try { await fs.lstat(existing); break; }
      catch (error) { if (!missing(error)) throw error; suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
    }
    return path.resolve(await fs.realpath(existing), ...suffix);
  };
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
    return rejectPreflight(error, request);
  }
  await privateDirectory(directory);
  await privateDirectory(backups); await privateDirectory(parent); await outsideCheckout(parent);
  return withFileTransaction(path.join(parent, "import-job"), "memory import busy", async () => {
    assertCurrent(request.importId);
    const prior = readImportRecord(request.importId);
    if (prior?.state === "ready") return prior;
    const record: ImportRecord = { kind: "import", id: request.importId, state: "copying", at: new Date(request.at ?? Date.now()).toISOString(), previous: prior ? prior.previous : request.previous, backup: path.join(parent, request.importId), files: 0, candidates: 0, parts: 0 };
    await writeImportRows([record], () => assertCurrent(request.importId));
    try {
      ports.phase?.("backup");
      try { await fs.mkdir(record.backup, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryImportError("interrupted"); throw error; }
      const manifest: ImportManifest = { schemaVersion: 1, importId: record.id, createdAt: record.at, files: [] };
      for (const file of files) {
        assertCurrent(record.id);
        const { source, store, ...entry } = file;
        const copy = path.join("stores", hash(await fs.realpath(store)).slice(0, 16), path.relative(store, source));
        const destination = path.join(record.backup, copy);
        await privateDirectory(path.dirname(destination));
        const sourceHash = await digest(source);
        const sourceStat = await fs.stat(source);
        if (sourceStat.size !== file.size || sourceStat.mtime.toISOString() !== file.modifiedAt) throw new MemoryImportError("integrity");
        await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
        await ports.afterCopy?.(destination, source);
        if (await digest(destination) !== sourceHash || await digest(source) !== sourceHash) throw new MemoryImportError("integrity");
        const handle = await fs.open(destination, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
        manifest.files.push({ ...entry, copy, sha256: sourceHash });
      }
      // All copies pass before the first candidate is committed.
      ports.phase?.("candidates");
      const loaded = new Set<string>();
      for (let index = 0; index < manifest.files.length; index++) {
        const file = manifest.files[index]!;
        if (file.kind !== "claude_index" || !file.loadedAtStart) continue;
        const text = await fs.readFile(path.join(record.backup, file.copy), "utf8");
        for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
          try { loaded.add(await fs.realpath(path.resolve(path.dirname(files[index]!.source), match[1]))); }
          catch (error) { if (!missing(error)) throw error; }
        }
      }
      const builder = new ImportCandidates(record.id);
      let resolveWriter = ports.writer;
      for (let index = 0; index < manifest.files.length; index++) {
        const file = manifest.files[index]!;
        if (file.kind !== "claude_topic" && file.kind !== "codex_summary") continue;
        const bytes = await fs.readFile(path.join(record.backup, file.copy));
        const body = bytes.toString("utf8");
        if (!Buffer.from(body).equals(bytes)) throw new MemoryImportError("integrity");
        file.loadedAtStart ||= loaded.has(files[index]!.physical);
        const session = file.engine === "claude" ? topicMetadata(body).session : undefined;
        if (session && !resolveWriter) resolveWriter = await (await import("./importWriter")).productionImportWriter();
        builder.add(file, body, session ? await resolveWriter!(session) : undefined);
      }
      const candidates: ImportCandidate[] = builder.rows();
      // Recheck the complete snapshot after all asynchronous copies and writer
      // lookups, before publishing any candidate. Engine stores remain read-only.
      for (let index = 0; index < files.length; index++) {
        if (await digest(files[index]!.source) !== manifest.files[index]!.sha256 || await digest(path.join(record.backup, manifest.files[index]!.copy)) !== manifest.files[index]!.sha256) throw new MemoryImportError("integrity");
      }
      assertCurrent(record.id);
      commitImportManifest(record.backup, manifest);
      for (let offset = 0; offset < candidates.length; offset += 64) await writeImportRows(candidates.slice(offset, offset + 64), () => assertCurrent(record.id));
      ports.phase?.("retention");
      await pruneMemoryBackups(parent);
      Object.assign(record, { state: "ready", files: manifest.files.length, candidates: new Set(candidates.map(row => row.group)).size, parts: candidates.length });
      await writeImportRows([record], () => assertCurrent(record.id));
      return record;
    } catch (error) {
      record.state = "failed"; record.reason = error instanceof MemoryImportError ? error.reason : "failed";
      let statusFailure: unknown, restoreFailure: unknown;
      try { await writeImportRows([record]); } catch (caught) { statusFailure = caught; }
      try { await restoreMemorySourceAfterImport(record.id, record.previous); } catch (caught) { restoreFailure = caught; }
      if (statusFailure || restoreFailure) {
        const cause = error instanceof MemoryImportError ? error.reason : "failed";
        throw new MemoryImportRecoveryError(cause, Boolean(statusFailure), Boolean(restoreFailure), [error, ...[statusFailure, restoreFailure].filter(Boolean)]);
      }
      throw error;
    }
  });
}
