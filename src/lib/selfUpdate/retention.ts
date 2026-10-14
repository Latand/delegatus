import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { finishTreeTrash, inspectTree, mountPointsUnder, removeTreeViaTrash, resolvePhysicalPath, scanProcesses, type ProcessScan } from "@/lib/tempSweep";
import { classifyStatus, disposableGeneratedTree, disposableIgnoredPath, keptIgnored, lockCheckoutHead, parseWorktreeList } from "@/lib/pipelines/worktreeSweep";
import { runGit } from "./git";
import { builtRevision } from "./steps";
import type { LauncherRecord } from "./launcher";

const DAY = 86_400_000;
export type RetentionInputs = {
  rollbackPointers?: (string | null)[];
  rollbackPackage?: string | null;
  inFlight?: string[];
};
export type RetentionReport = {
  at: string; removed: { dir: string; sha: string; bytes: number }[];
  reclaimedCacheBytes: number; kept: { dir: string; reason: string; bytes: number }[]; errors: string[];
};
export type RetentionPorts = {
  git?: typeof runGit; scan?: () => ProcessScan; mountPoints?: (directory: string) => string[];
  now?: () => number; env?: Readonly<Record<string, string | undefined>>; reportFile?: string;
  current?: () => { record: LauncherRecord; inputs: RetentionInputs };
  removeTree?: (directory: string) => Promise<void>;
  lockHead?: (directory: string) => (() => void) | null;
};
const under = (entry: string, root: string) => entry === root || entry.startsWith(root + path.sep);

/** A lower-bound allocation count. Symlinks and device boundaries are never followed. */
function bytesOf(directory: string): number {
  let bytes = 0; let count = 0;
  const pending = [directory];
  const device = fs.lstatSync(directory).dev;
  while (pending.length && count++ < 200_000) {
    const file = pending.pop()!;
    const stat = fs.lstatSync(file);
    if (stat.dev !== device) continue;
    if (stat.isDirectory()) pending.push(...fs.readdirSync(file).map(name => path.join(file, name)));
    if (stat.isDirectory() || stat.nlink === 1) bytes += stat.blocks * 512;
  }
  return bytes;
}

function pointerDir(raw: string | null): string | null {
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (!value || typeof value.dir !== "string" || !path.isAbsolute(value.dir)) throw new Error("invalid release pointer");
  return path.resolve(value.dir);
}

function releaseAge(directory: string, checkout: boolean): number {
  const times = [fs.lstatSync(directory).mtimeMs];
  for (const file of checkout ? [".next/DELEGATUS_RELEASE_READY", ".next/BUILD_ID"] : ["package.json"]) {
    try { times.push(fs.lstatSync(path.join(directory, file)).mtimeMs); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return Math.max(...times);
}

/** Successful applies call this after persisting their outcome, while update admission is held. */
export async function retainReleases(record: LauncherRecord, inputs: RetentionInputs = {}, ports: RetentionPorts = {}): Promise<RetentionReport> {
  const now = ports.now ?? Date.now;
  const run = ports.git ?? runGit;
  const report: RetentionReport = { at: new Date(now()).toISOString(), removed: [], reclaimedCacheBytes: 0, kept: [], errors: [] };
  const reportFile = ports.reportFile ?? statePath("self-update", "retention.json");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const previousTrash = fs.readdirSync(path.dirname(reportFile));
  const mounts = ports.mountPoints ?? mountPointsUnder;
  const read = () => ports.current?.() ?? { record, inputs };
  const scan = () => {
    const value = (ports.scan ?? scanProcesses)();
    if (!value.ownNamespace) throw new Error("scan-unavailable: release retention requires /proc");
    return value;
  };
  type Candidate = { dir: string; sha: string; age: number; locked: boolean; identity: string };
  const identity = (dir: string) => { const stat = fs.lstatSync(dir); return `${stat.dev}:${stat.ino}`; };
  const candidates: Candidate[] = [];
  const physicalPaths = new WeakMap<ProcessScan, Map<string, string>>();
  const heldByProcess = (dir: string, processes: ProcessScan) => {
    const resolved = physicalPaths.get(processes) ?? new Map<string, string>();
    physicalPaths.set(processes, resolved);
    const physical = (entry: string) => {
      const known = resolved.get(entry);
      if (known !== undefined) return known;
      let target: string;
      try { target = fs.realpathSync(entry); } catch { target = resolvePhysicalPath(entry); }
      resolved.set(entry, target); return target;
    };
    return processes.processes.some(proc => proc.paths.some(entry => {
      const target = entry.replace(/ \(deleted\)$/, "");
      return under(target, dir) || under(physical(target), dir);
    }) || proc.references?.some(entry => entry.includes(dir)));
  };
  const protect = (candidate: Candidate, current: ReturnType<typeof read>, processes: ProcessScan, recovering = false): string | null => {
    const { record: owner, inputs: state } = current;
    if (owner.releasesDir !== record.releasesDir || owner.checkout !== record.checkout || owner.releasePointer !== record.releasePointer)
      throw new Error("installation changed during retention");
    let active: string | null = null;
    try { active = pointerDir(fs.readFileSync(owner.releasePointer, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const names = (directory: string | null) => directory !== null && under(directory, candidate.dir);
    if (names(active)) return "active";
    if ((state.rollbackPointers ?? []).some(raw => names(pointerDir(raw))) || names(state.rollbackPackage ?? null)) return "rollback";
    if ((state.inFlight ?? []).some(names)) return "in-flight";
    if ([owner.web.revision, owner.runtimeHost.revision, owner.launcher.revision].some(sha => sha && candidate.sha.startsWith(sha))) return "serving";
    if (heldByProcess(candidate.dir, processes)) return "process";
    if (candidate.locked) return "locked";
    if (!recovering && now() - releaseAge(candidate.dir, !!record.checkout) < DAY) return "recent";
    return null;
  };
  try {
    const initial = read();
    const processes = scan();
    const root = path.resolve(record.releasesDir);
    if (fs.realpathSync(root) !== root) throw new Error("release root is an alias; skipped");
    let listed: ReturnType<typeof parseWorktreeList> = [];
    if (record.checkout) {
      const result = await run(["worktree", "list", "--porcelain", "-z"], record.checkout);
      if (result.code !== 0) throw new Error(`cannot list release worktrees: ${result.stderr}`);
      listed = parseWorktreeList(result.stdout);
    }
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (record.checkout ? !/^[a-f0-9]{12}$/.test(name) : !/^npm-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(name)) continue;
      const registered = listed.find(entry => path.resolve(entry.path) === dir && !entry.bare && !entry.prunable);
      if (record.checkout && !registered) { report.kept.push({ dir, reason: "unregistered", bytes: 0 }); continue; }
      let sha = registered?.head ?? "";
      if (!record.checkout) {
        try { sha = JSON.parse(fs.readFileSync(path.join(dir, "node_modules/delegatus-cli/package.json"), "utf8")).gitHead ?? ""; }
        catch { /* Unknown package revision cannot match serving revisions. */ }
      }
      candidates.push({ dir, sha, age: releaseAge(dir, !!record.checkout), locked: registered?.locked ?? false, identity: identity(dir) });
    }
    const rawKeep = Number((ports.env ?? process.env).LLV_SELF_UPDATE_KEEP_RELEASES?.trim() || 3);
    const keepCount = Number.isFinite(rawKeep) ? Math.max(1, Math.floor(rawKeep)) : 3;
    // Validate every safety input before the first mutation.
    const protectedSet = new Map(candidates.map(candidate => [candidate.dir, protect(candidate, initial, processes)]));
    const newest = new Set(candidates.filter(candidate => !protectedSet.get(candidate.dir) && now() - candidate.age >= DAY).sort((a, b) => b.age - a.age).slice(0, keepCount).map(candidate => candidate.dir));
    const worktreeStatus = async (directory: string) => {
      const status = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], directory);
      if (status.code !== 0) return { ok: false, changed: ["status unavailable"], ignored: [] as string[], allIgnored: [] as string[] };
      const classified = classifyStatus(status.stdout, true);
      return { ok: true, changed: classified.changed, ignored: keptIgnored(directory, classified.ignored), allIgnored: classified.ignored };
    };
    const safeTrackedFlags = async (directory: string) => {
      const tagged = await run(["ls-files", "--cached", "-v", "-z"], directory);
      return tagged.code === 0 && tagged.stdout.split("\0").filter(Boolean).every(row => row.startsWith("H "));
    };
    const safeRef = async (sha: string) => {
      const refs = await run(["for-each-ref", "--contains", sha, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/self-update/tip"], record.checkout!);
      return refs.code === 0 && refs.stdout.split("\n").some(ref => ref.trim().length > 0);
    };
    for (const candidate of candidates.sort((a, b) => a.age - b.age)) {
      try {
        const current = read();
        let reason = protect(candidate, current, scan()) ?? (now() - candidate.age < DAY ? "recent" : newest.has(candidate.dir) ? "newest" : null);
        if (mounts(candidate.dir).length) reason = "mount-boundary";
        if (identity(candidate.dir) !== candidate.identity || fs.realpathSync(candidate.dir) !== candidate.dir) reason = "changed";
        if (reason) {
          const bytes = reason === "mount-boundary" ? 0 : bytesOf(candidate.dir);
          report.kept.push({ dir: candidate.dir, reason, bytes });
          // Runtime caches and unfinished builds are kept. Only webpack is disposable.
          if (["mount-boundary", "in-flight", "changed"].includes(reason) || !record.checkout) continue;
          const head = await run(["rev-parse", "HEAD"], candidate.dir);
          if (head.code !== 0 || builtRevision(candidate.dir) !== head.stdout.trim()) continue;
          const cache = path.join(candidate.dir, ".next/cache/webpack");
          if (!fs.existsSync(cache)) continue;
          if (fs.realpathSync(cache) !== cache || !fs.lstatSync(cache).isDirectory() || mounts(cache).length) continue;
          if (inspectTree(cache, { git: true, mounts: mounts(cache) }).hold) continue;
          const bytesBefore = bytesOf(cache);
          const journal = path.join(path.dirname(reportFile), `cache-trash-${randomUUID()}.json`);
          const inUse = (trash: string) => heldByProcess(trash, scan()) || heldByProcess(cache, scan())
            || (read().inputs.inFlight ?? []).some(dir => under(dir, candidate.dir));
          if (inUse(cache) || mounts(candidate.dir).length || fs.realpathSync(cache) !== cache || identity(candidate.dir) !== candidate.identity
            || inspectTree(cache, { git: true, mounts: mounts(cache) }).hold) continue;
          if (await removeTreeViaTrash(cache, { journal, held: inUse, remove: ports.removeTree,
            validate: trash => !inspectTree(trash, { git: true, mounts: mounts(trash) }).hold })) report.reclaimedCacheBytes += bytesBefore;
          continue;
        }
        // Awaited listing and measurements cannot carry stale authority into removal.
        const latest = read();
        const fresh = scan();
        if (protect(candidate, latest, fresh) || mounts(candidate.dir).length || identity(candidate.dir) !== candidate.identity) {
          report.kept.push({ dir: candidate.dir, reason: "changed", bytes: 0 }); continue;
        }
        let releaseHead: (() => void) | null = null;
        if (record.checkout) {
          releaseHead = (ports.lockHead ?? (directory => lockCheckoutHead(directory, entry => entry, report.errors)))(candidate.dir);
          if (!releaseHead) { report.kept.push({ dir: candidate.dir, reason: "locked", bytes: 0 }); continue; }
        }
        try {
        if (record.checkout) {
          const actualHead = await run(["rev-parse", "--verify", "HEAD"], candidate.dir);
          if (actualHead.code !== 0 || actualHead.stdout.trim() !== candidate.sha) {
            report.kept.push({ dir: candidate.dir, reason: "uncommitted", bytes: bytesOf(candidate.dir) }); continue;
          }
          const listing = await run(["worktree", "list", "--porcelain", "-z"], record.checkout);
          if (listing.code !== 0) throw new Error("cannot refresh release worktree listing");
          const entry = parseWorktreeList(listing.stdout).find(entry => path.resolve(entry.path) === candidate.dir);
          if (!entry || entry.locked || entry.head !== actualHead.stdout.trim() || protect(candidate, read(), scan()) || mounts(candidate.dir).length) {
            report.kept.push({ dir: candidate.dir, reason: "changed", bytes: 0 }); continue;
          }
          let content = await worktreeStatus(candidate.dir);
          if (!content.ok || content.changed.length || content.ignored.length || !await safeTrackedFlags(candidate.dir)
            || !await safeRef(actualHead.stdout.trim())) {
            report.kept.push({ dir: candidate.dir, reason: "uncommitted", bytes: bytesOf(candidate.dir) }); continue;
          }
          for (const ignored of content.allIgnored) {
            if (!disposableIgnoredPath(candidate.dir, ignored)) { content = { ...content, ignored: [ignored] }; break; }
            const target = path.join(candidate.dir, ignored);
            let stat: fs.Stats;
            try { stat = fs.lstatSync(target); } catch { content = { ...content, ignored: [ignored] }; break; }
            if (!stat.isDirectory() || stat.isSymbolicLink()) { content = { ...content, ignored: [ignored] }; break; }
            const generated = ignored.split("/").some(name => ["node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".svelte-kit", "out", "dist", "build", "coverage", "test-results", "playwright-report", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis", ".venv", "venv", ".tox", ".nox"].includes(name) || name.endsWith(".egg-info"));
            const journal = path.join(path.dirname(reportFile), `release-output-trash-${randomUUID()}.json`);
            if (!await removeTreeViaTrash(target, { journal, remove: ports.removeTree,
              held: trash => !disposableGeneratedTree(trash, generated) || !!protect(candidate, read(), scan(), true),
            })) { content = { ...content, ignored: [ignored] }; break; }
            content = await worktreeStatus(candidate.dir);
            if (!content.ok || content.changed.length || content.ignored.length || !await safeTrackedFlags(candidate.dir)) break;
          }
          if (!content.ok || content.changed.length || content.ignored.length) {
            report.kept.push({ dir: candidate.dir, reason: "uncommitted", bytes: bytesOf(candidate.dir) }); continue;
          }
        }
        const bytes = bytesOf(candidate.dir);
        if (protect(candidate, read(), scan()) || mounts(candidate.dir).length || identity(candidate.dir) !== candidate.identity || fs.realpathSync(candidate.dir) !== candidate.dir) {
          report.kept.push({ dir: candidate.dir, reason: "changed", bytes }); continue;
        }
        if (record.checkout) {
          const marker = path.join(candidate.dir, ".next/DELEGATUS_RELEASE_READY");
          if (fs.existsSync(path.dirname(marker)) && fs.realpathSync(path.dirname(marker)) !== path.dirname(marker)) {
            report.kept.push({ dir: candidate.dir, reason: "changed", bytes }); continue;
          }
          const finalContent = await worktreeStatus(candidate.dir);
          if (!finalContent.ok || finalContent.changed.length || finalContent.ignored.length
            || !await safeTrackedFlags(candidate.dir) || !await safeRef(candidate.sha)) {
            report.kept.push({ dir: candidate.dir, reason: "uncommitted", bytes }); continue;
          }
          const finalHead = await run(["rev-parse", "--verify", "HEAD"], candidate.dir);
          if (finalHead.code !== 0 || finalHead.stdout.trim() !== candidate.sha
            || protect(candidate, read(), scan()) || mounts(candidate.dir).length
            || identity(candidate.dir) !== candidate.identity || fs.realpathSync(candidate.dir) !== candidate.dir) {
            report.kept.push({ dir: candidate.dir, reason: "changed", bytes }); continue;
          }
          fs.rmSync(marker, { force: true });
          const result = await run(["worktree", "remove", candidate.dir], record.checkout);
          if (result.code !== 0) throw new Error(`cannot remove release: ${result.stderr || result.stdout}`);
        } else {
          const journal = path.join(path.dirname(reportFile), `package-trash-${randomUUID()}.json`);
          if (!await removeTreeViaTrash(candidate.dir, { journal, context: { sha: candidate.sha }, held: trash => {
            const current = read(); const activeProcesses = scan();
            const reason = protect({ dir: candidate.dir, sha: candidate.sha, age: candidate.age, locked: candidate.locked, identity: candidate.identity }, current, activeProcesses, true);
            if (reason) report.kept.push({ dir: candidate.dir, reason, bytes: 0 });
            return !!reason || heldByProcess(trash, activeProcesses);
          }, remove: ports.removeTree })) continue;
        }
        report.removed.push({ dir: candidate.dir, sha: candidate.sha, bytes });
        } finally { releaseHead?.(); }
      } catch (error) { report.errors.push(`${candidate.dir}: ${String(error)}`); }
    }
    // Recover only intents whose original path belongs to this releases root.
    for (const file of previousTrash) {
      if (!/^(cache|package|release-output)-trash-.*\.json$/.test(file)) continue;
      const journal = path.join(path.dirname(reportFile), file);
      try {
        const row = JSON.parse(fs.readFileSync(journal, "utf8"));
        const packageTrash = file.startsWith("package-");
        const outputTrash = file.startsWith("release-output-");
        let outputCandidate: Candidate | undefined;
        let generatedOutput = false;
        if (packageTrash) {
          if (record.checkout || path.dirname(row.directory) !== root || !/^npm-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(path.basename(row.directory))) continue;
        } else if (outputTrash) {
          outputCandidate = candidates.find(candidate => under(row.directory, candidate.dir) && row.directory !== candidate.dir);
          if (!record.checkout || !outputCandidate || mounts(outputCandidate.dir).length || identity(outputCandidate.dir) !== outputCandidate.identity) continue;
          const relative = path.relative(outputCandidate.dir, row.directory);
          generatedOutput = relative.split(path.sep).some(name => ["node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".svelte-kit", "out", "dist", "build", "coverage", "test-results", "playwright-report", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis", ".venv", "venv", ".tox", ".nox"].includes(name) || name.endsWith(".egg-info"));
          if (!generatedOutput) continue;
        } else {
          const candidate = candidates.find(candidate => row.directory === path.join(candidate.dir, ".next/cache/webpack"));
          if (!candidate || mounts(candidate.dir).length || identity(candidate.dir) !== candidate.identity) continue;
        }
        const held = (trash: string) => {
          const processes = scan();
          if (heldByProcess(trash, processes) || heldByProcess(row.directory, processes)) return true;
          if (outputCandidate) {
            const reason = protect(outputCandidate, read(), processes, true);
            if (reason) report.kept.push({ dir: outputCandidate.dir, reason, bytes: 0 });
            return !!reason;
          }
          if (!packageTrash) return (read().inputs.inFlight ?? []).some(dir => under(row.directory, dir));
          const reason = protect({ dir: row.directory, sha: row.context?.sha ?? "", age: 0, locked: false, identity: row.identity }, read(), processes, true);
          if (reason) report.kept.push({ dir: row.directory, reason, bytes: 0 });
          return !!reason;
        };
        if (mounts(row.trash).length) { report.kept.push({ dir: row.directory, reason: "mount-boundary", bytes: 0 }); continue; }
        const bytes = fs.existsSync(row.trash) ? bytesOf(row.trash) : 0;
        if (await finishTreeTrash(journal, held, ports.removeTree,
          trash => (!outputCandidate || disposableGeneratedTree(trash, generatedOutput))
            && (packageTrash || outputTrash || !inspectTree(trash, { git: true, mounts: mounts(trash) }).hold))) {
          if (packageTrash) report.removed.push({ dir: row.directory, sha: row.context?.sha ?? "", bytes });
          else if (!outputTrash) report.reclaimedCacheBytes += bytes;
        }
      } catch (error) { report.errors.push(String(error)); }
    }
  } catch (error) { report.errors.push(String(error)); }
  try { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); writeJsonDurably(reportFile, report); }
  catch (error) {
    report.errors.push(`cannot write retention report: ${String(error)}`);
    console.error("[self-update] cannot write retention report", String(error));
  }
  console.log(`[self-update] retention removed ${report.removed.length}; reclaimed ${report.reclaimedCacheBytes} cache bytes; ${report.errors.length} error(s)`);
  return report;
}

export function releaseRetentionStatus() {
  try {
    const report = JSON.parse(fs.readFileSync(statePath("self-update", "retention.json"), "utf8")) as RetentionReport;
    return { at: report.at, removed: report.removed.length, removedBytes: report.removed.reduce((sum, row) => sum + row.bytes, 0),
      reclaimedCacheBytes: report.reclaimedCacheBytes, kept: report.kept.length, errors: report.errors.length };
  } catch { return null; }
}
