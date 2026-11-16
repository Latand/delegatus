// A bounded lookup under the recorder's own temporary root, independent of
// Viewer state and of the log hint supplied by a native tool caller.
import fs from "node:fs";
import path from "node:path";
import { digest, identitySchema, physical, readEnvelope, writeEnvelope } from "../recordedChecks/wire";

export function gateRunRoot(log: string, temporaryRoot: string): string {
  const root = fs.realpathSync(temporaryRoot);
  const relative = path.relative(root, log);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("gate log is outside the recorder's temporary root");
  return root;
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
  gateRunRoot(record.log, root);
  const log = path.join(fs.realpathSync(path.dirname(record.log)), path.basename(record.log));
  if (log !== record.log || record.directoryIdentity !== physical(`${log}.gate`)
    || digest(readEnvelope(path.join(`${log}.gate`, "completion.json"))) !== digest(record))
    throw new Error("gate run record identity changed");
  return record;
}
