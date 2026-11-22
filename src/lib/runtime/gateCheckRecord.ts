// A bounded lookup under the recorder's own temporary root, independent of
// Viewer state and of the log hint supplied by a native tool caller.
import fs from "node:fs";
import path from "node:path";
import { digest, identitySchema, physical, readEnvelope, writeEnvelope } from "../recordedChecks/wire";

export const GATE_CHECK_ROOT_ENV = "LLV_GATE_CHECK_ROOT";
export const GATE_CHECK_ROOT_IDENTITY_ENV = "LLV_GATE_CHECK_ROOT_DIRECTORY_IDENTITY";
export const GATE_CHECK_LAUNCH_ROOT_ENV = "LLV_GATE_CHECK_LAUNCH_ROOT";

function gateRunLog(log: string, root: string): string {
  let parent: string;
  try { parent = fs.realpathSync(path.dirname(log)); }
  catch (error) {
    throw new Error(`gate log parent cannot be resolved (resolvedRoot=${JSON.stringify(root)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const resolvedLog = path.join(parent, path.basename(log));
  const withinRoot = (candidate: string) => {
    const relative = path.relative(root, candidate);
    return Boolean(relative) && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  if (!withinRoot(resolvedLog))
    throw new Error(`gate log is outside the recorder's temporary root (resolvedRoot=${JSON.stringify(root)})`);
  // A missing filename is available for the exclusive open. An existing
  // symlink must have a resolvable target within the root.
  let target: string;
  try {
    if (!fs.lstatSync(resolvedLog, { throwIfNoEntry: false })?.isSymbolicLink()) return resolvedLog;
    target = fs.realpathSync(resolvedLog);
  } catch (error) {
    throw new Error(`gate log target cannot be resolved (resolvedRoot=${JSON.stringify(root)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!withinRoot(target))
    throw new Error(`gate log is outside the recorder's temporary root (resolvedRoot=${JSON.stringify(root)})`);
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
function verifiedIndex(root: string): string {
  const directory = indexDirectory(root);
  physical(directory);
  return directory;
}

/** Publish before command dispatch so every started run is addressable by id. */
export function publishGateRun(root: string, record: GateRunRecord): void {
  fs.mkdirSync(indexDirectory(root), { recursive: true, mode: 0o700 });
  const directory = verifiedIndex(root);
  const filename = path.join(directory, `${record.runId}.json`);
  if (fs.existsSync(filename)) throw new Error("gate run id already exists");
  writeEnvelope(filename, record);
}

export function resolveGateRun(root: string, runId: string): GateRunRecord {
  if (!/^[a-f0-9]{64}$/.test(runId)) throw new Error("invalid gate run id");
  const record = readEnvelope(path.join(verifiedIndex(root), `${runId}.json`)) as GateRunRecord | null;
  if (!record || record.runId !== runId || typeof record.log !== "string" || !path.isAbsolute(record.log)
    || record.rootDirectoryIdentity !== physical(root) || !identitySchema.safeParse(record.recorder).success
    || !Number.isFinite(record.deadlineUptimeMs)) throw new Error("invalid gate run record");
  const log = gateRunLog(record.log, root);
  if (log !== record.log || record.directoryIdentity !== physical(`${log}.gate`)
    || digest(readEnvelope(path.join(`${log}.gate`, "completion.json"))) !== digest(record))
    throw new Error("gate run record identity changed");
  return record;
}
