import type { RetentionScan } from "./retentionInspection";
import { RetentionWorker, RetentionInspectionError, type RetentionInspection } from "./retentionWorker";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { finishTreeTrash, inspectTree, mountPointsUnder, removeTreeViaTrash, resolvePhysicalPath, type ProcessScan } from "@/lib/tempSweep";
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
  cursor?: { age: number; dir: string };
  recoveryCursor?: string;
  reclaimedCacheBytes: number; kept: { dir: string; reason: string; bytes: number }[]; errors: string[];
};
export type RetentionPorts = {
  inspection?: RetentionInspection;
  git?: typeof runGit; scan?: () => ProcessScan & Partial<Pick<RetentionScan, "uncertain">>; mountPoints?: (directory: string) => string[];
  now?: () => number; env?: Readonly<Record<string, string | undefined>>; reportFile?: string;
  current?: () => { record: LauncherRecord; inputs: RetentionInputs } | Promise<{ record: LauncherRecord; inputs: RetentionInputs }>;
  maxCandidates?: number;
  removeTree?: (directory: string) => Promise<void>;
  lockHead?: (directory: string) => (() => void) | null;
};
const under = (entry: string, root: string) => entry === root || entry.startsWith(root + path.sep);

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
  return withViewerOperation("self-update.retention", async () => {
  const inspection = ports.inspection ?? new RetentionWorker();
  const bytesOf = async (directory: string) => {
    try { return await inspection.bytes(directory); }
    catch (error) { throw new RetentionInspectionError(String(error)); }
  };
  try {
  const now = ports.now ?? Date.now;
  const run = ports.git ?? runGit;
  const report: RetentionReport = { at: new Date(now()).toISOString(), removed: [], reclaimedCacheBytes: 0, kept: [], errors: [] };
  const reportFile = ports.reportFile ?? statePath("self-update", "retention.json");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const previousTrash = fs.readdirSync(path.dirname(reportFile)).sort();
  let cursor: RetentionReport["cursor"];
  let recoveryCursor: string | undefined;
  try {
    const previousReport = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    const previous = previousReport.cursor;
    if (Number.isFinite(previous?.age) && typeof previous?.dir === "string" && path.dirname(previous.dir) === path.resolve(record.releasesDir)) cursor = previous;
    if (typeof previousReport.recoveryCursor === "string" && /^(cache|package|release-output)-trash-.*\.json$/.test(previousReport.recoveryCursor))
      recoveryCursor = previousReport.recoveryCursor;
  } catch { /* A first pass, or an older report with no cursor. */ }
  const mounts = ports.mountPoints ?? mountPointsUnder;
  const read = async () => ports.current?.() ?? { record, inputs };
  const budget = ports.maxCandidates ?? 4;
  const maxCandidates = Number.isFinite(budget) ? Math.max(1, Math.min(128, Math.floor(budget))) : 4;
  let worked = 0;
  const deadline = now() + 120_000;
  const scan = async () => {
    try {
      const value = ports.scan ? ports.scan() : await inspection.scan(path.resolve(record.releasesDir));
      if (!value.ownNamespace || ("complete" in value && !value.complete)) throw new Error("scan-unavailable: incomplete /proc inventory");
      return value;
    } catch (error) { throw new RetentionInspectionError(String(error)); }
  };
  type Candidate = { dir: string; sha: string; age: number; locked: boolean; identity: string };
  const byAge = (a: Candidate, b: Candidate) => a.age - b.age || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);
  const identity = (dir: string) => { const stat = fs.lstatSync(dir); return `${stat.dev}:${stat.ino}`; };
  const candidates: Candidate[] = [];
  const physicalPaths = new WeakMap<ProcessScan, Map<string, string>>();
  const uncertainReason = (dir: string, processes: ProcessScan) => {
    const uncertain = (processes as Partial<RetentionScan>).uncertain?.find(row => row.roots.some(root => under(dir, root) || under(root, dir)));
    return uncertain ? `process-unreadable:${uncertain.pid}:${uncertain.reason}` : null;
  };
  const heldByProcess = (dir: string, processes: ProcessScan) => {
    if (uncertainReason(dir, processes)) return true;
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
  const protect = (candidate: Candidate, current: Awaited<ReturnType<typeof read>>, processes: ProcessScan, recovering = false): string | null => {
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
    const uncertainty = uncertainReason(candidate.dir, processes);
    if (uncertainty) return uncertainty;
    if (heldByProcess(candidate.dir, processes)) return "process";
    if (candidate.locked) return "locked";
    if (!recovering && now() - releaseAge(candidate.dir, !!record.checkout) < DAY) return "recent";
    return null;
  };
  const freshProtection = async (candidate: Candidate, recovering = false) => {
    const current = await read();
    const processes = await scan();
    return protect(candidate, current, processes, recovering);
  };
  try {
    const processes = await scan();
    const initial = await read();
    const root = path.resolve(record.releasesDir);
    if (fs.realpathSync(root) !== root) throw new Error("release root is an alias; skipped");
    let listed: ReturnType<typeof parseWorktreeList> = [];
    if (record.checkout) {
      const result = await run(["worktree", "list", "--porcelain", "-z"], record.checkout);
      if (result.code !== 0) throw new Error(`cannot list release worktrees: ${result.stderr}`);
      listed = parseWorktreeList(result.stdout);
    }
    for (const name of fs.readdirSync(root).sort()) {
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
    const newest = new Set(candidates.filter(candidate => !protectedSet.get(candidate.dir) && now() - candidate.age >= DAY).sort((a, b) => byAge(b, a)).slice(0, keepCount).map(candidate => candidate.dir));
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
    const ordered = candidates.sort(byAge);
    const afterCursor = (candidate: Candidate) => cursor && (candidate.age > cursor.age || candidate.age === cursor.age && candidate.dir > cursor.dir);
    const window = cursor ? [...ordered.filter(afterCursor), ...ordered.filter(candidate => !afterCursor(candidate))] : ordered;
    for (const candidate of window) {
      try {
        const current = await read();
        let reason = protect(candidate, current, processes) ?? (now() - candidate.age < DAY ? "recent" : newest.has(candidate.dir) ? "newest" : null);
        if (mounts(candidate.dir).length) reason = "mount-boundary";
        if (identity(candidate.dir) !== candidate.identity || fs.realpathSync(candidate.dir) !== candidate.dir) reason = "changed";
        if (worked >= maxCandidates || now() >= deadline) {
          report.kept.push({ dir: candidate.dir, reason: reason ?? "pass-budget", bytes: 0 }); continue;
        }
        // Unknown ownership also protects generated contents of the release.
        if (uncertainReason(candidate.dir, processes)) {
          report.kept.push({ dir: candidate.dir, reason: reason!, bytes: 0 }); continue;
        }
        worked++;
        report.cursor = { age: candidate.age, dir: candidate.dir };
        if (reason) {
          const bytes = reason === "mount-boundary" ? 0 : await bytesOf(candidate.dir);
          report.kept.push({ dir: candidate.dir, reason, bytes });
          // Runtime caches and unfinished builds are kept. Only webpack is disposable.
          if (["mount-boundary", "in-flight", "changed"].includes(reason) || !record.checkout
            || ((await read()).inputs.inFlight ?? []).some(dir => under(dir, candidate.dir))) continue;
          const head = await run(["rev-parse", "HEAD"], candidate.dir);
          if (head.code !== 0 || builtRevision(candidate.dir) !== head.stdout.trim()) continue;
          const cache = path.join(candidate.dir, ".next/cache/webpack");
          if (!fs.existsSync(cache)) continue;
          if (fs.realpathSync(cache) !== cache || !fs.lstatSync(cache).isDirectory() || mounts(cache).length) continue;
          if (inspectTree(cache, { git: true, mounts: mounts(cache) }).hold) continue;
          const bytesBefore = await bytesOf(cache);
          const journal = path.join(path.dirname(reportFile), `cache-trash-${randomUUID()}.json`);
          const inUse = async (trash: string) => {
            const current = await read();
            const fresh = await scan();
            return heldByProcess(trash, fresh) || heldByProcess(cache, fresh)
              || (current.inputs.inFlight ?? []).some(dir => under(dir, candidate.dir));
          };
          if (await inUse(cache) || mounts(candidate.dir).length || fs.realpathSync(cache) !== cache || identity(candidate.dir) !== candidate.identity
            || inspectTree(cache, { git: true, mounts: mounts(cache) }).hold) continue;
          if (await removeTreeViaTrash(cache, { journal, held: inUse, remove: ports.removeTree,
            validate: trash => !inspectTree(trash, { git: true, mounts: mounts(trash) }).hold })) report.reclaimedCacheBytes += bytesBefore;
          continue;
        }
        // Awaited listing and measurements cannot carry stale authority into removal.
        const fresh = await scan();
        const latest = await read();
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
            report.kept.push({ dir: candidate.dir, reason: "uncommitted", bytes: await bytesOf(candidate.dir) }); continue;
          }
          const listing = await run(["worktree", "list", "--porcelain", "-z"], record.checkout);
          if (listing.code !== 0) throw new Error("cannot refresh release worktree listing");
          const entry = parseWorktreeList(listing.stdout).find(entry => path.resolve(entry.path) === candidate.dir);
          if (!entry || entry.locked || entry.head !== actualHead.stdout.trim() || await freshProtection(candidate) || mounts(candidate.dir).length) {
            report.kept.push({ dir: candidate.dir, reason: "changed", bytes: 0 }); continue;
          }
          let content = await worktreeStatus(candidate.dir);
          if (!content.ok || content.changed.length || content.ignored.length || !await safeTrackedFlags(candidate.dir)
            || !await safeRef(actualHead.stdout.trim())) {
            report.kept.push({ dir: candidate.dir, reason: "uncommitted", bytes: await bytesOf(candidate.dir) }); continue;
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
              held: async trash => !disposableGeneratedTree(trash, generated) || !!await freshProtection(candidate, true),
            })) { content = { ...content, ignored: [ignored] }; break; }
            content = await worktreeStatus(candidate.dir);
            if (!content.ok || content.changed.length || content.ignored.length || !await safeTrackedFlags(candidate.dir)) break;
          }
          if (!content.ok || content.changed.length || content.ignored.length) {
            report.kept.push({ dir: candidate.dir, reason: "uncommitted", bytes: await bytesOf(candidate.dir) }); continue;
          }
        }
        const bytes = await bytesOf(candidate.dir);
        if (await freshProtection(candidate) || mounts(candidate.dir).length || identity(candidate.dir) !== candidate.identity || fs.realpathSync(candidate.dir) !== candidate.dir) {
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
            || await freshProtection(candidate) || mounts(candidate.dir).length
            || identity(candidate.dir) !== candidate.identity || fs.realpathSync(candidate.dir) !== candidate.dir) {
            report.kept.push({ dir: candidate.dir, reason: "changed", bytes }); continue;
          }
          // Git checks above await subprocesses. Revalidate the marker's parent
          // at the unlink edge so a late .next symlink cannot redirect deletion.
          const nextDir = path.dirname(marker);
          let markerParentExists = false;
          try {
            const parent = fs.lstatSync(nextDir);
            markerParentExists = true;
            if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(nextDir) !== nextDir
              || !under(nextDir, candidate.dir)) {
              report.kept.push({ dir: candidate.dir, reason: "changed", bytes }); continue;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") markerParentExists = false;
            else {
              report.kept.push({ dir: candidate.dir, reason: "changed", bytes }); continue;
            }
          }
          if (markerParentExists && fs.existsSync(marker) && fs.lstatSync(marker).isDirectory()) {
            report.kept.push({ dir: candidate.dir, reason: "changed", bytes }); continue;
          }
          fs.rmSync(marker, { force: true });
          const result = await run(["worktree", "remove", candidate.dir], record.checkout);
          if (result.code !== 0) throw new Error(`cannot remove release: ${result.stderr || result.stdout}`);
        } else {
          const packageTree = inspectTree(candidate.dir, { git: true, mounts: mounts(candidate.dir) });
          if (packageTree.hold) {
            report.kept.push({ dir: candidate.dir, reason: packageTree.hold, bytes: await bytesOf(candidate.dir) }); continue;
          }
          const journal = path.join(path.dirname(reportFile), `package-trash-${randomUUID()}.json`);
          if (!await removeTreeViaTrash(candidate.dir, { journal, context: { sha: candidate.sha }, held: async trash => {
            const current = await read(); const activeProcesses = await scan();
            const reason = protect({ dir: candidate.dir, sha: candidate.sha, age: candidate.age, locked: candidate.locked, identity: candidate.identity }, current, activeProcesses, true);
            if (reason) report.kept.push({ dir: candidate.dir, reason, bytes: 0 });
            const processHeld = heldByProcess(trash, activeProcesses);
            if (processHeld && !reason) report.kept.push({ dir: candidate.dir, reason: "process", bytes: 0 });
            return !!reason || processHeld
              || !!inspectTree(trash, { git: true, mounts: mounts(trash) }).hold;
          }, validate: trash => !inspectTree(trash, { git: true, mounts: mounts(trash) }).hold, remove: ports.removeTree })) continue;
        }
        report.removed.push({ dir: candidate.dir, sha: candidate.sha, bytes });
        } finally { releaseHead?.(); }
      } catch (error) { if (error instanceof RetentionInspectionError) throw error; report.errors.push(`${candidate.dir}: ${String(error)}`); }
    }
    // Recover only intents whose original path belongs to this releases root.
    let recovered = 0;
    const recoveryFiles = previousTrash.filter(file => /^(cache|package|release-output)-trash-.*\.json$/.test(file));
    const afterRecoveryCursor = (file: string) => recoveryCursor !== undefined && file > recoveryCursor;
    const recoveryWindow = recoveryCursor
      ? [...recoveryFiles.filter(afterRecoveryCursor), ...recoveryFiles.filter(file => !afterRecoveryCursor(file))]
      : recoveryFiles;
    for (const file of recoveryWindow) {
      if (recovered >= maxCandidates || now() >= deadline) break;
      const journal = path.join(path.dirname(reportFile), file);
      recovered++;
      report.recoveryCursor = file;
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
        const held = async (trash: string) => {
          const current = await read();
          const processes = await scan();
          const processHeld = heldByProcess(trash, processes) || heldByProcess(row.directory, processes);
          if (processHeld) {
            if (packageTrash) report.kept.push({ dir: row.directory, reason: "process", bytes: 0 });
            return true;
          }
          if (outputCandidate) {
            const reason = protect(outputCandidate, current, processes, true);
            if (reason) report.kept.push({ dir: outputCandidate.dir, reason, bytes: 0 });
            return !!reason;
          }
          if (!packageTrash) return (current.inputs.inFlight ?? []).some(dir => under(row.directory, dir));
          const reason = protect({ dir: row.directory, sha: row.context?.sha ?? "", age: 0, locked: false, identity: row.identity }, current, processes, true);
          if (reason) report.kept.push({ dir: row.directory, reason, bytes: 0 });
          return !!reason;
        };
        if (mounts(row.trash).length) { report.kept.push({ dir: row.directory, reason: "mount-boundary", bytes: 0 }); continue; }
        const bytes = fs.existsSync(row.trash) ? await bytesOf(row.trash) : 0;
        if (await finishTreeTrash(journal, held, ports.removeTree,
          trash => (!outputCandidate || disposableGeneratedTree(trash, generatedOutput))
            && (outputTrash || !inspectTree(trash, { git: true, mounts: mounts(trash) }).hold))) {
          if (packageTrash) report.removed.push({ dir: row.directory, sha: row.context?.sha ?? "", bytes });
          else if (!outputTrash) report.reclaimedCacheBytes += bytes;
        }
      } catch (error) { if (error instanceof RetentionInspectionError) throw error; report.errors.push(String(error)); }
    }
  } catch (error) { report.errors.push(String(error)); }
  try { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); writeJsonDurably(reportFile, report); }
  catch (error) {
    report.errors.push(`cannot write retention report: ${String(error)}`);
    console.error("[self-update] cannot write retention report", String(error));
  }
  console.log(`[self-update] retention removed ${report.removed.length}; reclaimed ${report.reclaimedCacheBytes} cache bytes; ${report.errors.length} error(s)`);
  return report;
  } finally { await inspection.close(); }
  });
}

export function releaseRetentionStatus() {
  try {
    const report = JSON.parse(fs.readFileSync(statePath("self-update", "retention.json"), "utf8")) as RetentionReport;
    return { at: report.at, removed: report.removed.length, removedBytes: report.removed.reduce((sum, row) => sum + row.bytes, 0),
      reclaimedCacheBytes: report.reclaimedCacheBytes, kept: report.kept.length, errors: report.errors.length };
  } catch { return null; }
}
