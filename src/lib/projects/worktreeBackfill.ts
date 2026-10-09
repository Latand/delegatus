import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasesCanAccept } from "@/lib/projects/aliases";
import { projectCurationSnapshot, type ManualProject } from "@/lib/projects/curation";
import { directoryProjectId, projectIdentityFromRemote, projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { recordProjectSuccessions } from "@/lib/projects/succession";
import { recordRecoveredWorktrees } from "@/lib/scanner/describe";

interface CatalogFile {
  project: string;
  cwd?: string | null;
  projectRoot?: string | null;
}
interface WorktreeMapping { repo: string; worktree: string }
export interface WorktreeBackfillItem {
  cwd: string;
  checkout?: string;
  source: string;
  target?: string;
  repo?: string;
  worktree?: string;
  sessions: number;
  reason: string;
}
export interface WorktreeBackfillReport {
  dryRun: boolean;
  folded: WorktreeBackfillItem[];
  leftAlone: WorktreeBackfillItem[];
  rescanned: boolean;
}

const TRANSCRIPT_HINT_MAX_BYTES = 16 * 1024 * 1024;
const NATIVE_RECORD_MAX_BYTES = 1024 * 1024;

/** Check complete native records, including those after a large prompt. A
    transcript over 16 MiB, a record over 1 MiB, or incomplete JSON vetoes the
    checkout: unchecked bytes may hold conflicting evidence. Never infer a
    repository from prose. */
function transcriptHints(filename: string): { branches: string[]; remotes: string[]; unreadable: boolean } {
  const branches = new Set<string>();
  const remotes = new Set<string>();
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > TRANSCRIPT_HINT_MAX_BYTES) throw new Error("Transcript exceeds evidence bound");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (read === 0) break;
      bytes += read;
    }
    const after = fs.fstatSync(fd);
    if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Transcript changed during evidence read");
    for (let offset = 0; offset < bytes;) {
      const newline = buffer.indexOf(0x0a, offset);
      const end = newline < 0 || newline >= bytes ? bytes : newline;
      if (end - offset > NATIVE_RECORD_MAX_BYTES) throw new Error("Native record exceeds evidence bound");
      const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(offset, end));
      offset = end + 1;
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (!obj || typeof obj !== "object") continue;
      const meta = obj.type === "session_meta" ? obj.payload as Record<string, unknown> : obj;
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid native metadata");
      const git = meta.git as Record<string, unknown> | undefined;
      if (git !== undefined && (!git || typeof git !== "object" || Array.isArray(git))) throw new Error("Invalid native Git metadata");
      for (const value of [meta.gitBranch, git?.branch, git?.repository_url]) {
        if (value !== undefined && value !== null && typeof value !== "string") throw new Error("Invalid native Git hint");
      }
      for (const value of [meta.gitBranch, git?.branch]) if (typeof value === "string" && value.trim()) branches.add(value);
      for (const value of [git?.repository_url]) if (typeof value === "string" && value.trim()) remotes.add(value);
    }
    return { branches: [...branches], remotes: [...remotes], unreadable: false };
  } catch {
    return { branches: [], remotes: [], unreadable: true };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function recordedMapping(cwd: string, map: Record<string, WorktreeMapping>): WorktreeMapping | undefined {
  for (let current = cwd; ; current = path.dirname(current)) {
    if (map[current]) return map[current];
    if (current === path.dirname(current)) return undefined;
  }
}

function removed(cwd: string): boolean {
  try { fs.lstatSync(cwd); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Linked checkouts keep shared branch refs in their common Git directory. */
function branchRefsDirectory(repo: string): string | null {
  try {
    let directory = path.join(repo, ".git");
    if (fs.lstatSync(directory).isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/im.exec(fs.readFileSync(directory, "utf8"))?.[1];
      if (!pointer) return null;
      directory = path.resolve(repo, pointer);
    }
    try {
      const common = fs.readFileSync(path.join(directory, "commondir"), "utf8").trim();
      return common ? path.resolve(directory, common) : directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      return directory;
    }
  } catch { return null; }
}

function siblingSuffix(cwd: string, repo: string): string | null {
  const relative = path.relative(path.dirname(repo), cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const base = path.basename(repo);
  const name = relative.split(path.sep)[0]!;
  if (!name.startsWith(base + "-")) return null;
  const suffix = name.slice(base.length + 1);
  return /^(?:lane-\d+|pipeline-[a-zA-Z0-9]+|review|v\d+(?:\.\d+)*-[a-zA-Z0-9][a-zA-Z0-9._-]*)$/.test(suffix) ? suffix : null;
}

/** Planning reads only the supplied catalog, map, checkout metadata and heads.
    Sibling naming is used solely by this explicit maintenance action. */
export function planWorktreeBackfill(
  files: Record<string, CatalogFile>, map: Record<string, WorktreeMapping>, project?: string,
  manualProjects: readonly ManualProject[] = [],
): WorktreeBackfillReport {
  const report: WorktreeBackfillReport = { dryRun: true, folded: [], leftAlone: [], rescanned: false };
  const repositories = new Map<string, { project: string; displayName: string }>();
  for (const file of Object.values(files)) {
    if (!file.projectRoot || !file.project.startsWith("repo-")) continue;
    const identity = projectIdentityFromRepositoryRoot(file.projectRoot);
    if (identity && identity.project === canonicalProject(file.project)) repositories.set(path.resolve(file.projectRoot), identity);
  }
  for (const entry of manualProjects) {
    const identity = projectIdentityFromRepositoryRoot(entry.root);
    if (identity?.project === canonicalProject(entry.project)) repositories.set(path.resolve(entry.root), identity);
  }
  for (const entry of Object.values(map)) {
    const identity = projectIdentityFromRepositoryRoot(entry.repo);
    if (identity) repositories.set(path.resolve(entry.repo), identity);
  }
  const candidates = new Map<string, Array<[string, CatalogFile]>>();
  const catalogEntries = Object.entries(files);
  const hintsByFile = new Map<string, ReturnType<typeof transcriptHints>>();
  for (const [filename, file] of Object.entries(files)) {
    if (!file.cwd || !file.project.startsWith("dir-")) continue;
    const entries = candidates.get(file.cwd) ?? [];
    entries.push([filename, file]);
    candidates.set(file.cwd, entries);
  }
  for (const [cwd, entries] of candidates) {
    const source = entries[0]![1].project;
    const item: WorktreeBackfillItem = { cwd, source, sessions: entries.length, reason: "" };
    const leave = (reason: string) => { report.leftAlone.push({ ...item, reason }); };
    if (!path.isAbsolute(cwd) || entries.some(([, file]) => file.project !== directoryProjectId(path.resolve(cwd)))) { leave("directory-identity-mismatch"); continue; }
    if (!removed(cwd)) { leave("checkout-present-or-unreadable"); continue; }
    const held = recordedMapping(cwd, map);
    const matches = [...repositories].filter(([repo]) => (
      held ? held.repo === repo : siblingSuffix(cwd, repo) !== null
    ));
    if (matches.length !== 1) { leave(matches.length ? "ambiguous-repository" : held ? "recorded-repository-not-known" : "no-known-sibling-repository"); continue; }
    const [repo, identity] = matches[0]!;
    const checkout = held ? path.resolve(cwd) : path.join(path.dirname(repo), path.relative(path.dirname(repo), cwd).split(path.sep)[0]!);
    if (!held && !removed(checkout)) { leave("checkout-present-or-unreadable"); continue; }
    // A root mapping applies to every descendant on the next scan. Validate
    // its entire catalog footprint, including records outside dir- projects.
    const affected = catalogEntries.filter(([, file]) => file.cwd && (
      path.resolve(file.cwd) === checkout || path.resolve(file.cwd).startsWith(checkout + path.sep)
    ));
    const hints = affected.map(([filename]) => {
      let hint = hintsByFile.get(filename);
      if (!hint) { hint = transcriptHints(filename); hintsByFile.set(filename, hint); }
      return hint;
    });
    if (hints.some(hint => hint.unreadable)) { leave("unreadable-transcript"); continue; }
    const remotes = hints.flatMap(hint => hint.remotes);
    if (remotes.some(remote => projectIdentityFromRemote(remote, repo)?.project !== identity.project)) { leave("conflicting-repository-hint"); continue; }
    if (affected.some(([, file]) => file.project.startsWith("dir-")
      ? file.project !== directoryProjectId(path.resolve(file.cwd!))
      : canonicalProject(file.project) !== identity.project)) { leave("conflicting-project-identity"); continue; }
    if (Object.entries(map).some(([mappedCwd, mapping]) => (
      mappedCwd === checkout || mappedCwd.startsWith(checkout + path.sep)
    ) && mapping.repo !== repo)) { leave("conflicting-recorded-worktree"); continue; }
    const branches = hints.flatMap(hint => hint.branches);
    /* Branches corroborate against repository refs, including branches whose
       checkout was removed. A branch alone never chooses a repository. */
    const refsDirectory = branchRefsDirectory(repo);
    const branchProof = branches.some(branch => {
      if (!refsDirectory || branch.includes("..") || path.isAbsolute(branch)) return false;
      try {
        const ref = path.join(refsDirectory, "refs", "heads", branch);
        return (fs.existsSync(ref) && fs.statSync(ref).isFile())
          || fs.readFileSync(path.join(refsDirectory, "packed-refs"), "utf8").split("\n").some(line => line.endsWith(` refs/heads/${branch}`));
      } catch { return false; }
    });
    if (!held && !remotes.length && !branchProof) {
      leave(branches.length ? "unproven-branch-hint" : "missing-native-evidence"); continue;
    }
    const registrations = affected.filter(([, file]) => file.project.startsWith("dir-"))
      .map(([, file]) => ({ source: file.project, target: identity.project, displayName: identity.displayName }));
    if (!projectAliasesCanAccept(registrations)) { leave("project-alias-conflict"); continue; }
    if (project && identity.project !== project) { leave("target-outside-project"); continue; }
    report.folded.push({ ...item, checkout, target: identity.project, repo, worktree: held?.worktree ?? path.basename(checkout),
      reason: held ? "recorded-worktree" : remotes.length ? "sibling-name-and-repository-hint" : "sibling-name-and-branch-hint" });
  }
  return report;
}

/** Dry-run never scans or writes, including receipts in the domain layer. */
export async function backfillWorktreeProjects(options: { dryRun?: boolean; project?: string } = {},
  rescan: () => Promise<void> = async () => {
    const { discoverFilesWithProjectCatalog } = await import("@/lib/scanner/discover");
    const scan = await discoverFilesWithProjectCatalog();
    if (!scan.complete) throw new Error("Worktree recovery was recorded; catalog rescan is incomplete, retry the action");
  },
): Promise<WorktreeBackfillReport> {
  const catalog = JSON.parse(fs.readFileSync(statePath("project-catalog.json"), "utf8")) as { files: Record<string, CatalogFile> };
  if (!catalog.files || typeof catalog.files !== "object" || Array.isArray(catalog.files)) throw new Error("Project catalog is unreadable");
  let map: Record<string, WorktreeMapping> = {};
  try { map = JSON.parse(fs.readFileSync(statePath("worktree-map.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!map || typeof map !== "object" || Array.isArray(map)
    || Object.values(map).some(item => !item || typeof item.repo !== "string" || typeof item.worktree !== "string")) throw new Error("Worktree map is unreadable");
  const report = planWorktreeBackfill(catalog.files, map, options.project, projectCurationSnapshot().manualProjects);
  if (options.dryRun !== false) return report;
  report.dryRun = false;
  if (report.folded.length) {
    recordRecoveredWorktrees(report.folded.map(item => ({ cwd: item.checkout ?? item.cwd, repo: item.repo!, worktree: item.worktree! })));
    const registrations = report.folded.map(item => ({ source: item.source, target: item.target!, displayName: projectIdentityFromRepositoryRoot(item.repo!)!.displayName }));
    recordProjectSuccessions(registrations);
    if (registrations.some(item => canonicalProject(item.source) !== item.target)) throw new Error("Worktree mapping recorded; project folding is incomplete, retry the action");
  }
  await rescan();
  report.rescanned = true;
  return report;
}
