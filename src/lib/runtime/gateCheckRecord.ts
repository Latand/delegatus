// Bounded lookups scoped to the recorder's launch, independent of any log
// hint supplied by a native tool caller.
import fs from "node:fs";
import path from "node:path";
import { digest, identitySchema, physical, readEnvelope, writeEnvelope } from "../recordedChecks/wire";

export const GATE_CHECK_ROOT_ENV = "LLV_GATE_CHECK_ROOT";
export const GATE_CHECK_ROOT_IDENTITY_ENV = "LLV_GATE_CHECK_ROOT_DIRECTORY_IDENTITY";
export const GATE_CHECK_LAUNCH_ROOT_ENV = "LLV_GATE_CHECK_LAUNCH_ROOT";
export const GATE_CHECK_EVIDENCE_ENV = "LLV_GATE_CHECK_EVIDENCE";

export type GateCheckEvidence = Readonly<{ directory: string; identity: string }>;
export type GateCheckRoot = Readonly<{ root: string; physicalRoot: string; rootDirectoryIdentity: string; evidence?: GateCheckEvidence }>;

export function gateCheckLaunchEnvironment(binding: GateCheckRoot): Record<string, string> {
  return {
    [GATE_CHECK_LAUNCH_ROOT_ENV]: binding.root,
    [GATE_CHECK_ROOT_ENV]: binding.physicalRoot,
    [GATE_CHECK_ROOT_IDENTITY_ENV]: binding.rootDirectoryIdentity,
    ...(binding.evidence ? { [GATE_CHECK_EVIDENCE_ENV]: JSON.stringify({ ...binding.evidence, rootDirectoryIdentity: binding.rootDirectoryIdentity }) } : {}),
  };
}

export function readGateCheckEvidence(value: string | null | undefined, rootIdentity: string): GateCheckEvidence | undefined {
  if (value == null) return undefined;
  const proof = JSON.parse(value) as Partial<GateCheckEvidence> & { rootDirectoryIdentity?: string } | null;
  if (!proof || typeof proof.directory !== "string" || !path.isAbsolute(proof.directory)
    || typeof proof.identity !== "string" || !/^\d+:\d+$/.test(proof.identity))
    throw new Error("invalid gate evidence root proof");
  if (proof.rootDirectoryIdentity !== rootIdentity) return undefined;
  return { directory: proof.directory, identity: proof.identity };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function evidenceRoot(evidence: GateCheckEvidence, scratch: string): string {
  if (evidence.directory === scratch || isWithin(scratch, evidence.directory) || physical(evidence.directory) !== evidence.identity)
    throw new Error("gate evidence root identity changed");
  return evidence.directory;
}

function gateRunLog(log: string, root: string): string {
  let parent: string;
  try { parent = fs.realpathSync(path.dirname(log)); }
  catch (error) {
    throw new Error(`gate log parent cannot be resolved (resolvedRoot=${JSON.stringify(root)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const resolvedLog = path.join(parent, path.basename(log));
  if (!isWithin(root, resolvedLog))
    throw new Error(`gate log is outside the recorder's temporary root (resolvedRoot=${JSON.stringify(root)})`);
  // The log is created with an exclusive open after its ticket directory. A
  // pre-existing symlink would redirect that open outside the checked parent.
  try {
    if (fs.lstatSync(resolvedLog).isSymbolicLink() && !isWithin(root, fs.realpathSync(resolvedLog)))
      throw new Error(`gate log is outside the recorder's temporary root (resolvedRoot=${JSON.stringify(root)})`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("resolvedRoot=")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`gate log target cannot be resolved (resolvedRoot=${JSON.stringify(root)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return resolvedLog;
}

/** Keep recorded runs under the native launch root even when a check gives
 * its command a nested TMPDIR. Both path and inode proof are pinned at launch.
 */
export function recorderGatePaths(log: string, temporaryRoot: string, env: Record<string, string | undefined> = process.env) {
  const launchRoot = env[GATE_CHECK_ROOT_ENV];
  const launchIdentity = env[GATE_CHECK_ROOT_IDENTITY_ENV];
  const initialRoot = env[GATE_CHECK_LAUNCH_ROOT_ENV];
  if (launchRoot === undefined && launchIdentity === undefined && initialRoot === undefined) {
    const root = fs.realpathSync(temporaryRoot);
    return { root, log: gateRunLog(log, root) };
  }
  if (!launchRoot || !path.isAbsolute(launchRoot) || !launchIdentity || !initialRoot || !path.isAbsolute(initialRoot))
    throw new Error("gate launch root proof is incomplete");
  const root = fs.realpathSync(launchRoot);
  const stat = fs.statSync(root);
  // The host pins a canonical physical path at launch. Do not silently
  // normalize a later alias (for example, the old path replaced by a symlink
  // after the directory was moved): the inode can still match while the
  // launch binding has changed and its waiter will reject the resulting run.
  // The initial TMPDIR may itself be an alias. Its target must still agree
  // with the binding retained by the native waiter, even for a nested TMPDIR.
  if (root !== launchRoot || fs.realpathSync(initialRoot) !== root
    || !stat.isDirectory() || `${stat.dev}:${stat.ino}` !== launchIdentity)
    throw new Error("gate launch root identity changed");
  return { root, log: gateRunLog(log, root) };
}

export type GateRunRecord = {
  runId: string; log: string; rootDirectoryIdentity: string;
  recorder: ReturnType<typeof identitySchema.parse>; directoryIdentity: string; deadlineUptimeMs: number;
};

const indexDirectory = (root: string) => path.join(root, ".gate-runs");
const MAX_RETAINED_RUNS = 10_000;
function verifiedIndex(root: string): string {
  const directory = indexDirectory(root);
  physical(directory);
  return directory;
}

/** Publish before command dispatch so every started run is addressable by id. */
export function publishGateRun(root: string, record: GateRunRecord, evidence?: GateCheckEvidence): void {
  writeRunIndex(root, record);
  // The stage's evidence directory survives removal of its attempt scratch.
  if (evidence) writeRunIndex(evidenceRoot(evidence, root), record);
}

function writeRunIndex(root: string, record: GateRunRecord): void {
  fs.mkdirSync(indexDirectory(root), { recursive: true, mode: 0o700 });
  const directory = verifiedIndex(root);
  const filename = path.join(directory, `${record.runId}.json`);
  if (fs.existsSync(filename)) throw new Error("gate run id already exists");
  writeEnvelope(filename, record);
}

export function validateGateRunId(runId: string): void {
  if (runId.length !== 64 || !/^[a-f0-9]{64}$/.test(runId)) throw new Error("invalid gate run id");
}

function readRunIndex(root: string, runId: string, evidence?: GateCheckEvidence): GateRunRecord | undefined {
  try {
    const indexRoot = evidence ? evidenceRoot(evidence, root) : root;
    return readEnvelope(path.join(verifiedIndex(indexRoot), `${runId}.json`)) as GateRunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export function lookupGateRun(root: string, rootIdentity: string, runId: string, scratchPresent: boolean, evidence?: GateCheckEvidence): GateRunRecord {
  validateGateRunId(runId);
  const local = scratchPresent ? readRunIndex(root, runId) : undefined;
  const retained = evidence ? readRunIndex(root, runId, evidence) : undefined;
  if (local === undefined && retained === undefined) throw new Error("unknown gate run id");
  if (local !== undefined && retained !== undefined && digest(local) !== digest(retained))
    throw new Error("gate run record copies disagree");
  const record = local === undefined ? retained : local;
  if (!record || record.runId !== runId || typeof record.log !== "string" || !path.isAbsolute(record.log)
    || path.resolve(record.log) !== record.log || typeof record.directoryIdentity !== "string"
    || !identitySchema.safeParse(record.recorder).success || !Number.isFinite(record.deadlineUptimeMs))
    throw new Error("invalid gate run record");
  if (record.rootDirectoryIdentity !== rootIdentity) {
    // A shared retained index can resolve a run launched by another stage.
    // Permit that only after the caller's scratch is gone; the exact indexed
    // run id and its retained ticket remain the authority for recovery.
    if (scratchPresent || retained === undefined) throw new Error("invalid gate run record");
    validateRetainedLogRecord(record, runId, root, rootIdentity);
    return record;
  }
  if (!isWithin(root, record.log)) throw new Error("invalid gate run record");
  return record;
}

/** Resolve an older absolute-log wait from the listener-owned retained index
 * after the launch scratch directory has disappeared. The scan is bounded and
 * every candidate is re-read through the normal root and record validation. */
export function lookupGateRunByLog(root: string, rootIdentity: string, log: string, evidence?: GateCheckEvidence): GateRunRecord {
  if (!evidence) throw new Error("retained gate evidence is unavailable");
  const index = verifiedIndex(evidenceRoot(evidence, root));
  const entries = fs.readdirSync(index, { withFileTypes: true });
  if (entries.length > MAX_RETAINED_RUNS) throw new Error("retained gate index exceeds the lookup bound");
  const matches: GateRunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    // Evidence is shared by every stage in a pipeline. Read and filter first:
    // another stage's valid record has a different scratch identity and must
    // not prevent this caller from finding its own absolute log.
    const runId = entry.name.slice(0, -5);
    const record = readRunIndex(root, runId, evidence);
    if (record?.log !== log) continue;
    validateRetainedLogRecord(record, runId, root, rootIdentity);
    matches.push(record);
  }
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous retained gate log" : "unknown retained gate log");
  return matches[0];
}

function validateRetainedLogRecord(record: GateRunRecord, runId: string, root: string, rootIdentity: string): void {
  if (record.runId !== runId || typeof record.log !== "string" || !path.isAbsolute(record.log)
    || path.resolve(record.log) !== record.log || typeof record.rootDirectoryIdentity !== "string"
    || !/^\d+:\d+$/.test(record.rootDirectoryIdentity) || typeof record.directoryIdentity !== "string"
    || !/^\d+:\d+$/.test(record.directoryIdentity) || !identitySchema.safeParse(record.recorder).success
    || !Number.isFinite(record.deadlineUptimeMs)) throw new Error("invalid gate run record");

  // When this is the caller's launch, preserve the full containment and inode
  // checks. A retained record from a different stage is scoped by its exact
  // canonical log and the listener-owned evidence index.
  if (record.rootDirectoryIdentity === rootIdentity && isWithin(root, record.log)) return;
  if (record.rootDirectoryIdentity === rootIdentity) throw new Error("invalid gate run record");
}

export function verifyGateRunTicket(record: GateRunRecord): void {
  const dir = `${record.log}.gate`;
  if (record.directoryIdentity !== physical(dir) || digest(readEnvelope(path.join(dir, "completion.json"))) !== digest(record))
    throw new Error("gate run record identity changed");
}

export function resolveGateRun(root: string, runId: string): GateRunRecord {
  const record = lookupGateRun(root, physical(root), runId, true);
  verifyGateRunTicket(record);
  return record;
}
