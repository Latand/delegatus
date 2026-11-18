import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { loadPrototypeTask } from "@/lib/tasks/store";
import { issueReportDecisionApproves } from "@/lib/issueReports/approvalForm";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { attemptTempJournalPath, tempSweepMode } from "@/lib/tempSweep";
import { attemptTempRemaining } from "./attemptTempDeadline";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { attemptTempAuthority, attemptScratchAuthority, recordingAttemptTempState } from "./attemptTempProduction";

/** Installed by the release/operations owner from reviewed retained evidence.
 * The executor has no operation that creates or amends these bindings. Legacy
 * forms named a retained artifact without including its digest in the form. */
export type AttemptTempApprovalBinding = {
  version: 1; taskId: string; project: string; reviewId: string; inputDigest: string;
  manifestSha256: string; manifestName: string; count: number;
  scopeQuestionId: string; executeQuestionId: string;
};
export type ApprovedAttemptTempRequest = { reviewId: string; manifest: string };
type SelectedRoot = { directory: string; identity: string; pipelineId: string | null; launchId: string;
  createdAt: number; released: boolean; retainUntilClose: boolean; uid: number };
type ReceiptRow = { directory: string; identity: string; disposition: string; bytes: number; reason: string; at: string };
export type ApprovedAttemptTempReport = { version: 1; reviewId: string; manifestSha256: string;
  mode: "on" | "dry-run"; checked: number; removed: number; removedBytes: number; skipped: number;
  removedThisRun: number; removedBytesThisRun: number;
  complete: boolean; freeBefore: number; freeBeforeThisRun: number; freeAfter: number; filesystem: string; rows: ReceiptRow[] };
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024, MAX_JOURNAL_BYTES = 8 * 1024 * 1024, MAX_ROOTS = 1024;

function regularFile(file: string, maxBytes: number): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || fs.realpathSync(file) !== path.resolve(file))
    throw new Error("approved attempt-temp input must be a bounded physical regular file");
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || bytes.length > maxBytes)
    throw new Error("approved attempt-temp input changed while reading");
  return bytes;
}

/** Read the local primary round, including its server-recorded decision actor.
 * Replicated summaries, caller assertions and recommendations grant nothing. */
function approval(request: ApprovedAttemptTempRequest) {
  if (!/^pr_[a-f0-9]{32}$/.test(request.reviewId)) throw new Error("full review identifier required");
  const file = statePath("attempt-temp-approvals", request.reviewId + ".json");
  const raw = regularFile(file, 16 * 1024), binding = JSON.parse(raw.toString()) as AttemptTempApprovalBinding;
  const permissions = fs.statSync(file);
  if ((permissions.mode & 0o022) || process.getuid && permissions.uid !== process.getuid()) throw new Error("approval binding is writable by another owner");
  if (binding.version !== 1 || binding.reviewId !== request.reviewId || !/^[a-f0-9]{64}$/.test(binding.inputDigest)
    || !/^[a-f0-9]{64}$/.test(binding.manifestSha256) || !Number.isInteger(binding.count) || binding.count < 1 || binding.count > MAX_ROOTS
    || path.basename(binding.manifestName) !== binding.manifestName || binding.manifestName !== path.basename(request.manifest)
    || !binding.scopeQuestionId || !binding.executeQuestionId || binding.scopeQuestionId === binding.executeQuestionId)
    throw new Error("invalid approved attempt-temp binding");
  const task = loadPrototypeTask(binding.taskId, statePath("tasks.json")), round = task?.prototypeReviews?.find(round => round.id === request.reviewId);
  if (!task || task.project !== binding.project || !round || round.project !== binding.project || round.taskId !== task.id
    || round.inputDigest !== binding.inputDigest || !round.questions?.some(q => q.id === binding.scopeQuestionId)
    || !round.questions.some(q => q.id === binding.executeQuestionId)
    || !issueReportDecisionApproves(round.decision, binding.scopeQuestionId)
    || !issueReportDecisionApproves(round.decision, binding.executeQuestionId))
    throw new Error("stored operator decision does not authorize this manifest execution");
  return { file, binding, revision: digest(raw) + ":" + digest(JSON.stringify(round)) };
}

export function approvedAttemptTempSelection(request: ApprovedAttemptTempRequest) {
  const proof = approval(request), bytes = regularFile(request.manifest, MAX_MANIFEST_BYTES);
  if (digest(bytes) !== proof.binding.manifestSha256) throw new Error("manifest digest differs from approved artifact");
  const manifest = JSON.parse(bytes.toString());
  if (!Array.isArray(manifest.candidates) || manifest.candidates.length !== proof.binding.count)
    throw new Error("manifest row count differs from approved artifact");
  const scratch = path.resolve(statePath("scratch")), seen = new Set<string>();
  if (fs.realpathSync(scratch) !== scratch) throw new Error("scratch ancestry is not physical");
  const rows: SelectedRoot[] = manifest.candidates.map((row: { path: string; launchId: string; laneId: string | null;
    evidence: { registry: { devInode: string; createdAt: string; released: boolean; retainUntilClose: boolean; uid: number } } }) => {
    const registry = row.evidence?.registry, directory = row.path;
    if (typeof directory !== "string" || path.resolve(directory) !== directory || path.dirname(directory) !== scratch
      || !/^llv-(?:stage|read-only-stage|stage-config)-[A-Za-z0-9]+$/.test(path.basename(directory)) || seen.has(directory)
      || Buffer.byteLength(path.basename(directory)) > 255
      || !registry || !/^\d+:\d+$/.test(registry.devInode) || !Number.isFinite(Date.parse(registry.createdAt))
      || typeof registry.released !== "boolean" || typeof registry.retainUntilClose !== "boolean"
      || !Number.isInteger(registry.uid) || typeof row.launchId !== "string" || !row.launchId
      || row.laneId !== null && typeof row.laneId !== "string") throw new Error("manifest contains an unsupported or duplicate root");
    seen.add(directory);
    return { directory, identity: registry.devInode, createdAt: Date.parse(registry.createdAt), released: registry.released,
      retainUntilClose: registry.retainUntilClose, uid: registry.uid, pipelineId: row.laneId, launchId: row.launchId };
  });
  const byDirectory = new Map(rows.map(row => [row.directory, row]));
  const current = () => { try { return approval(request).revision === proof.revision; } catch { return false; } };
  const selection: NonNullable<AttemptTempSweepOptions["selection"]> = {
    directories: rows.map(row => row.directory), watches: [proof.file],
    current: owner => {
      const row = byDirectory.get(owner.directory);
      return current() && !!row && row.identity === owner.identity && row.pipelineId === owner.pipelineId && row.launchId === owner.launchId
        && row.createdAt === owner.createdAt && row.released === !!owner.released && row.retainUntilClose === !!owner.retainUntilClose;
    },
  };
  return { ...proof, rows, selection, current };
}

/** One bounded page through the existing attempt-temp owner and its lock,
 * claims, namespace proofs, reference checks and native remover. No other
 * retention domain is visited. A durable intent precedes each target. */
export async function runApprovedAttemptTempSweep(request: ApprovedAttemptTempRequest,
  ports: Pick<AttemptTempSweepOptions, "scan">, env: NodeJS.ProcessEnv = process.env): Promise<ApprovedAttemptTempReport> {
  const mode = tempSweepMode(env);
  if (!mode) throw new Error("attempt-temp cleanup is disabled");
  const proof = approvedAttemptTempSelection(request);
  const journal = statePath("attempt-temp-approved", request.reviewId + ".json");
  const deadline = performance.now() + attemptTempRemaining(40_000);
  return withFileTransactionAsync(journal, "approved attempt-temp execution", async () => {
    const store = new AttemptTempStore();
    try {
      const space = () => { const value = fs.statfsSync(statePath("scratch")); return value.bavail * value.bsize; };
      const filesystem = String(fs.statSync(statePath("scratch")).dev);
      const freeBeforeThisRun = space();
      let freeBefore = freeBeforeThisRun, removedThisRun = 0, removedBytesThisRun = 0;
      let rows: ReceiptRow[] = [];
      if (fs.existsSync(journal)) {
        const prior = JSON.parse(regularFile(journal, MAX_JOURNAL_BYTES).toString()) as ApprovedAttemptTempReport;
        if (prior.version !== 1 || prior.reviewId !== request.reviewId || prior.manifestSha256 !== proof.binding.manifestSha256
          || prior.filesystem !== filesystem || !Array.isArray(prior.rows) || prior.rows.length > MAX_ROOTS
          || prior.rows.some(row => !proof.rows.some(root => root.directory === row.directory && root.identity === row.identity)
            || !["pending", "removed", "preview", "held", "live", "evidence", "operator", "failed"].includes(row.disposition)
            || !Number.isFinite(row.bytes) || row.bytes < 0 || typeof row.reason !== "string" || row.reason.length > 512 || !Number.isFinite(Date.parse(row.at)))
          || new Set(prior.rows.map(row => row.directory)).size !== prior.rows.length)
          throw new Error("execution journal does not belong to approved manifest");
        if (!Number.isFinite(prior.freeBefore) || prior.freeBefore < 0) throw new Error("invalid execution journal space observation");
        rows = prior.rows;
        if (!(prior.mode === "dry-run" && mode === "on")) freeBefore = prior.freeBefore;
      }
      const result = (): ApprovedAttemptTempReport => ({ version: 1, reviewId: request.reviewId, manifestSha256: proof.binding.manifestSha256,
        mode, checked: rows.length, removed: rows.filter(row => row.disposition === "removed").length,
        removedBytes: rows.filter(row => row.disposition === "removed").reduce((sum, row) => sum + row.bytes, 0),
        removedThisRun, removedBytesThisRun,
        skipped: rows.filter(row => row.disposition !== "removed" && row.disposition !== "pending").length,
        complete: rows.length === proof.rows.length && rows.every(row => row.disposition !== "pending"), freeBefore, freeBeforeThisRun, freeAfter: space(), filesystem, rows });
      // Bound every writer's diagnostic so its complete manifest output fits
      // both the replay reader and the helper's 8 MiB response protocol.
      const record = (row: ReceiptRow) => { rows = [...rows.filter(old => old.directory !== row.directory), { ...row, reason: row.reason.slice(0, 512) }]; writeJsonDurably(journal, result()); };
      let visited = 0;
      // Fresh rows go before interrupted ones so a bounded page of blocked
      // recoveries cannot starve the rest of the approved inventory.
      const selected = new Map(proof.rows.map(root => [root.directory, root]));
      // record() moves each admitted row to the durable tail. Reuse that
      // order even when wall time is frozen or moves backwards.
      const ordered = [...proof.rows.filter(root => !rows.some(row => row.directory === root.directory)),
        ...rows.map(row => selected.get(row.directory)!)];
      for (const row of ordered) {
        const prior = rows.find(old => old.directory === row.directory);
        // A completed receipt cannot authorize a replacement with the same name.
        if (prior?.disposition === "removed") continue;
        if (++visited > 32 || Math.min(attemptTempRemaining(40_000), deadline - performance.now()) <= 1000) break;
        if (!proof.current()) throw new Error("operator decision or approval binding changed");
        record({ directory: row.directory, identity: row.identity, disposition: "pending", bytes: 0, reason: "admitted; reconcile native retirement journal after interruption", at: new Date(Date.now()).toISOString() });
        if (!row.pipelineId) {
          record({ directory: row.directory, identity: row.identity, disposition: "held", bytes: 0,
            reason: "standalone root has no lane retirement claim; retained for its lifecycle owner", at: new Date(Date.now()).toISOString() }); continue;
        }
        const stat = fs.lstatSync(row.directory, { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== row.identity || stat.uid !== row.uid) {
          record({ directory: row.directory, identity: row.identity, disposition: "held", bytes: 0,
            reason: stat ? "fresh root identity differs from manifest" : "root absent; reclaimed allocation unknown", at: new Date(Date.now()).toISOString() }); continue;
        }
        if (fs.existsSync(attemptTempJournalPath(row.directory))) {
          record({ directory: row.directory, identity: row.identity, disposition: "pending", bytes: 0,
            reason: "native retirement journal requires owner reconciliation", at: new Date(Date.now()).toISOString() }); continue;
        }
        const report = await sweepAttemptTemps(store, { scan: ports.scan, state: recordingAttemptTempState(store), authority: attemptScratchAuthority,
          evidenceAuthority: attemptTempAuthority, requireExpired: true,
          mode, runBudgetMs: Math.min(attemptTempRemaining(40_000), deadline - performance.now()), selection: { ...proof.selection, directories: [row.directory] } });
        const outcome = report.outcomes.at(-1);
        if (mode === "on" && outcome?.disposition === "removed") { removedThisRun++; removedBytesThisRun += outcome.bytes; }
        record({ directory: row.directory, identity: row.identity,
          disposition: mode === "dry-run" ? "preview" : outcome?.disposition === "deferred" ? "pending" : outcome?.disposition ?? "pending",
          bytes: mode === "dry-run" ? 0 : outcome?.bytes ?? 0, reason: outcome?.reason ?? "no final outcome; reconcile before retry", at: new Date(Date.now()).toISOString() });
      }
      const report = result(); writeJsonDurably(journal, report); return report;
    } finally { store.close(); }
  }, { waitMs: attemptTempRemaining(40_000) });
}
