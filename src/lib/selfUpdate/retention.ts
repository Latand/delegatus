import type { RetentionScan } from "./retentionInspection";
import { RetentionWorker, RetentionInspectionError, type RetentionInspection } from "./retentionWorker";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { inspectTree, matchesSnapshot, mountPointsUnder, resolvePhysicalPath, type ProcessScan } from "@/lib/tempSweep";
import { classifyStatus, disposableGeneratedTree, disposableIgnoredPath, keptIgnored, lockCheckoutHead, parseWorktreeList } from "@/lib/pipelines/worktreeSweep";
import { runGit } from "./git";
import { builtRevision } from "./steps";
import { adoptLegacyTrash, isGatedTrashRow, quarantineTree, reopenGate, settleGatedTrash } from "./gatedTrash";
import type { LauncherRecord } from "./launcher";

const DAY = 86_400_000;
const TRASH_JOURNAL = /^(cache|package|release-output|release)-trash-.*\.json$/;
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
    if (typeof previousReport.recoveryCursor === "string" && TRASH_JOURNAL.test(previousReport.recoveryCursor))
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
  const freshObservation = async () => {
    // Early refusals before a tree is quarantined. Only gatedObservation, read
    // with the tree off its path and behind a closed gate, authorizes removal.
    await read();
    await scan();
    const current = await read();
    const processes = await scan();
    return { current, processes };
  };
  const union = (first: ProcessScan, second: ProcessScan): ProcessScan => ({ ...second,
    processes: [...first.processes, ...second.processes],
    uncertain: [...(first as Partial<RetentionScan>).uncertain ?? [], ...(second as Partial<RetentionScan>).uncertain ?? []] } as ProcessScan);
  /** With a gate closed, a process can no longer reach the tree by any path,
   * so a holder found now held it before. Two scans catch a descriptor handed
   * to a child between them; the owner read follows the last scan, so a hold
   * added while it ran is seen. This process's own cwd is the trash. */
  const gatedObservation = async (trash: string) => {
    const scanned = union(await scan(), await scan());
    const processes = { ...scanned, processes: scanned.processes.map(proc => proc.pid === process.pid
      ? { ...proc, paths: proc.paths.filter(entry => entry !== trash) } : proc) };
    const current = await read();
    return { current, processes };
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
    const { current, processes } = await freshObservation();
    return protect(candidate, current, processes, recovering);
  };
  /** The last word on a quarantined release, read with its gate closed. */
  const gatedReleaseHold = async (candidate: Candidate, trash: string, gate: string) => {
    const { current, processes } = await gatedObservation(trash);
    return protect(candidate, current, processes, true) ?? (heldByProcess(gate, processes) ? "process" : null);
  };
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
  /** Git's view of a quarantined checkout, before its gate closes: an edit
   * made before the rename restores the release. */
  const releaseContentHold = async (trash: string, sha: string) => {
    const content = await worktreeStatus(trash);
    if (!content.ok || content.changed.length || content.ignored.length || !await safeTrackedFlags(trash)) return "uncommitted";
    const head = await run(["rev-parse", "--verify", "HEAD"], trash);
    return head.code === 0 && head.stdout.trim() === sha ? null : "changed";
  };
  /** The tree is gone; drop only its own registration, never other prunable ones. */
  const dropWorktreeMetadata = async (directory: string) => {
    if (fs.existsSync(directory)) { report.errors.push(`${directory}: path reacquired after removal; worktree registration kept`); return; }
    const listing = await run(["worktree", "list", "--porcelain", "-z"], record.checkout!);
    if (listing.code === 0 && !parseWorktreeList(listing.stdout).some(entry => path.resolve(entry.path) === directory)) return;
    const result = await run(["worktree", "remove", directory], record.checkout!);
    if (result.code !== 0) report.errors.push(`${directory}: cannot drop removed release registration: ${result.stderr || result.stdout}`);
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
            const { current, processes: fresh } = await freshObservation();
            return heldByProcess(trash, fresh) || heldByProcess(cache, fresh)
              || (current.inputs.inFlight ?? []).some(dir => under(dir, candidate.dir));
          };
          if (await inUse(cache) || mounts(candidate.dir).length || fs.realpathSync(cache) !== cache || identity(candidate.dir) !== candidate.identity
            || inspectTree(cache, { git: true, mounts: mounts(cache) }).hold) continue;
          const row = quarantineTree(cache, journal);
          if (!row) continue;
          const outcome = await settleGatedTrash(journal, row, { remove: ports.removeTree,
            observe: async (trash, gate) => {
              const { current, processes: fresh } = await gatedObservation(trash);
              return heldByProcess(gate, fresh) || heldByProcess(cache, fresh)
                || (current.inputs.inFlight ?? []).some(dir => under(dir, candidate.dir)) ? "process" : null;
            },
            validate: root => !inspectTree(root, { git: true, mounts: mounts(row.trash) }).hold });
          if (outcome.removed) report.reclaimedCacheBytes += bytesBefore;
          continue;
        }
        // Awaited listing and measurements cannot carry stale authority into removal.
        const { current: latest, processes: fresh } = await freshObservation();
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
            const row = quarantineTree(target, journal);
            if (!row || !(await settleGatedTrash(journal, row, { remove: ports.removeTree,
              observe: async (trash, gate) => {
                const { current, processes: fresh } = await gatedObservation(trash);
                return protect(candidate, current, fresh, true) ?? (heldByProcess(gate, fresh) ? "process" : null);
              },
              validate: root => disposableGeneratedTree(root, generated),
            })).removed) { content = { ...content, ignored: [ignored] }; break; }
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
          // Rename out of the release path, recheck Git content there, then
          // remove from behind the closed gate. The ready marker goes first.
          const journal = path.join(path.dirname(reportFile), `release-trash-${randomUUID()}.json`);
          const row = quarantineTree(candidate.dir, journal, { sha: candidate.sha });
          if (!row) { report.kept.push({ dir: candidate.dir, reason: "changed", bytes }); continue; }
          const outcome = await settleGatedTrash(journal, row, { remove: ports.removeTree, first: [".next/DELEGATUS_RELEASE_READY"],
            beforeGate: trash => releaseContentHold(trash, candidate.sha),
            observe: (trash, gate) => gatedReleaseHold(candidate, trash, gate) });
          if (!outcome.removed) { report.kept.push({ dir: candidate.dir, reason: outcome.reason, bytes }); continue; }
          report.removed.push({ dir: candidate.dir, sha: candidate.sha, bytes });
          await dropWorktreeMetadata(candidate.dir);
          continue;
        } else {
          const packageTree = inspectTree(candidate.dir, { git: true, mounts: mounts(candidate.dir) });
          if (packageTree.hold) {
            report.kept.push({ dir: candidate.dir, reason: packageTree.hold, bytes: await bytesOf(candidate.dir) }); continue;
          }
          const journal = path.join(path.dirname(reportFile), `package-trash-${randomUUID()}.json`);
          const row = quarantineTree(candidate.dir, journal, { sha: candidate.sha });
          if (!row) { report.kept.push({ dir: candidate.dir, reason: "changed", bytes: 0 }); continue; }
          const outcome = await settleGatedTrash(journal, row, { remove: ports.removeTree,
            observe: (trash, gate) => gatedReleaseHold(candidate, trash, gate),
            validate: root => !inspectTree(root, { git: true, mounts: mounts(row.trash) }).hold });
          if (!outcome.removed) { report.kept.push({ dir: candidate.dir, reason: outcome.reason, bytes: 0 }); continue; }
        }
        report.removed.push({ dir: candidate.dir, sha: candidate.sha, bytes });
        } finally { releaseHead?.(); }
      } catch (error) { if (error instanceof RetentionInspectionError) throw error; report.errors.push(`${candidate.dir}: ${String(error)}`); }
    }
    // Recover only intents whose original path belongs to this releases root.
    let recovered = 0;
    const recoveryFiles = previousTrash.filter(file => TRASH_JOURNAL.test(file));
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
        const gated = isGatedTrashRow(row);
        const packageTrash = file.startsWith("package-");
        const outputTrash = file.startsWith("release-output-");
        const releaseTrash = file.startsWith("release-trash-");
        let outputCandidate: Candidate | undefined;
        let generatedOutput = false;
        if (packageTrash) {
          if (record.checkout || path.dirname(row.directory) !== root || !/^npm-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(path.basename(row.directory))) continue;
        } else if (releaseTrash) {
          if (!record.checkout || !gated || path.dirname(row.directory) !== root || !/^[a-f0-9]{12}$/.test(path.basename(row.directory))) continue;
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
        const wholeRelease = packageTrash || releaseTrash;
        if (mounts(row.trash).length) { report.kept.push({ dir: row.directory, reason: "mount-boundary", bytes: 0 }); continue; }
        // A journal from before gates existed: its trash moves behind a gate
        // too, after the checks its own replay made; held, it returns there.
        const quarantine = gated ? row : adoptLegacyTrash(journal, row,
          trash => !!row.snapshot && matchesSnapshot(trash, row.snapshot) && !mountPointsUnder(trash).length);
        if (!quarantine) continue;
        /** `gate` names the closed gate around the quarantined tree. */
        const hold = (gate: string, current: Awaited<ReturnType<typeof read>>, processes: ProcessScan): string | null => {
          if ([gate, row.directory, quarantine.legacyTrash].some(entry => entry && heldByProcess(entry, processes))) return "process";
          if (outputCandidate) return protect(outputCandidate, current, processes, true);
          if (!wholeRelease) return (current.inputs.inFlight ?? []).some(dir => under(row.directory, dir)) ? "in-flight" : null;
          return protect({ dir: row.directory, sha: row.context?.sha ?? "", age: 0, locked: false, identity: row.identity }, current, processes, true);
        };
        const reportHold = (reason: string) => {
          if (wholeRelease) report.kept.push({ dir: row.directory, reason, bytes: 0 });
          else if (outputCandidate && reason !== "process") report.kept.push({ dir: outputCandidate.dir, reason, bytes: 0 });
        };
        reopenGate(quarantine);
        if (mounts(quarantine.trash).length) { report.kept.push({ dir: row.directory, reason: "mount-boundary", bytes: 0 }); continue; }
        const bytes = fs.existsSync(quarantine.trash) ? await bytesOf(quarantine.trash) : 0;
        const outcome = await settleGatedTrash(journal, quarantine, { remove: ports.removeTree,
          first: releaseTrash ? [".next/DELEGATUS_RELEASE_READY"] : undefined,
          beforeGate: releaseTrash ? trash => releaseContentHold(trash, quarantine.context?.sha ?? "") : undefined,
          observe: async (trash, gate) => { const { current, processes } = await gatedObservation(trash); return hold(gate, current, processes); },
          // A checkout release is itself a Git worktree; Git checked its content before the gate.
          validate: releaseTrash ? undefined : tree => (!outputCandidate || disposableGeneratedTree(tree, generatedOutput))
            && (outputTrash || !inspectTree(tree, { git: true, mounts: mounts(quarantine.trash) }).hold) });
        if (!outcome.removed) reportHold(outcome.reason);
        else {
          if (wholeRelease) report.removed.push({ dir: row.directory, sha: row.context?.sha ?? "", bytes });
          else if (!outputTrash) report.reclaimedCacheBytes += bytes;
          if (releaseTrash) await dropWorktreeMetadata(row.directory);
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
