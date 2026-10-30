// Standalone producer protocol. Bundled into the gate; never resolves Viewer state.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { uptime } from "node:os";
import { pipeline } from "node:stream/promises";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited, hostProcessIdentity } from "../runtime/signalSandboxContext";
import { captureProcessIdentity, type ProcessIdentity } from "../processIdentity";

export const ENVELOPE_BYTES = 64 * 1024;
// The existing service kernel watchdog has a 60-second window and a bounded
// stop job. Unknown cleanup cannot extend native-host custody beyond this.
export const CUSTODY_CLEANUP_MS = 65_000;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, entry) => {
  if (entry && typeof entry === "object" && !Array.isArray(entry))
    return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
  return entry;
})).digest("hex");
export const custodyClock = () => uptime() * 1000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(4096).refine(value => !path.isAbsolute(value)
  && !value.split(/[\\/]/).some(part => !part || part === "." || part === ".."));
export const identitySchema = z.object({ pid: z.number().int().positive(), startIdentity: z.string().min(1).max(128), bootEpoch: z.string().min(1).max(256) }).strict();
export const manifestSchema = z.object({
  version: z.literal(1), deadline: z.number().int().positive(), executionMs: z.number().int().positive(),
  deadlineUptimeMs: z.number().positive(), clockBootEpoch: z.string().min(1).max(256),
  cwd: z.string().min(1), selection: z.array(z.string().min(1).max(1024)).min(1).max(512),
  inputs: z.array(z.object({ root: z.string().min(1), file: relative, sha256: hash }).strict()).min(1).max(512),
  roots: z.array(z.object({ directory: z.string().min(1), identity: z.string().regex(/^\d+:\d+$/), purpose: z.enum(["evidence", "configuration"]) }).strict()).min(1).max(8),
  outputs: z.array(z.object({ root: z.string().min(1), file: relative }).strict()).min(1).max(64),
  completion: z.object({ root: z.string().min(1), file: relative }).strict(),
  configurationDigest: hash,
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export const descriptorSchema = z.object({ version: z.literal(1), runId: hash, manifest: manifestSchema,
  argv: z.array(z.string()).min(1), recorder: identitySchema, wrapper: identitySchema.nullable(),
  directoryIdentity: z.string(), startedAt: z.number(), startedUptimeMs: z.number().positive(), deadlineUptimeMs: z.number().positive(), descriptorDigest: hash }).strict();
export type Descriptor = z.infer<typeof descriptorSchema>;
const cancellationSchema = z.object({ reason: z.enum(["deadline", "SIGTERM", "SIGINT", "owner"]), at: z.number(), atUptimeMs: z.number().positive() }).strict();
export const supervisorCancellation = (reason: z.infer<typeof cancellationSchema>["reason"]) => ({ reason, at: Date.now(), atUptimeMs: custodyClock() });
export const reportSchema = z.object({ version: z.literal(1), runId: hash, descriptorDigest: hash,
  supervisor: identitySchema, command: identitySchema.nullable(), kind: z.enum(["portable", "service", "namespace"]),
  boundary: z.enum(["direct", "namespace"]).default("direct"),
  cancellation: cancellationSchema.nullable().default(null),
  service: z.object({ unit: z.string().max(256), invocation: z.string().max(128), cgroup: z.string().max(2048) }).nullable(),
  commandExit: z.number().int().min(0).max(255).nullable(), commandSignal: z.string().max(64).nullable(),
  cleanup: z.enum(["pending", "confirmed", "unknown"]), phase: z.enum(["dispatch", "close"]), at: z.number(), atUptimeMs: z.number().positive(),
}).strict();
export type ProducerReport = z.infer<typeof reportSchema>;
export const terminalSchema = z.object({ version: z.literal(1), runId: hash, descriptorDigest: hash,
  wrapperExit: z.number().int().min(0).max(255), wrapperSignal: z.string().max(64).nullable(),
  cancellation: cancellationSchema.nullable(),
  closedAt: z.number(), closedUptimeMs: z.number().positive(), report: reportSchema.nullable(), reports: z.array(reportSchema).max(4).default([]) }).strict();
export type Terminal = z.infer<typeof terminalSchema>;
export const completionSchema = z.object({ selection: z.array(z.string()), visited: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(), outcomes: z.array(z.object({ name: z.string(), exit: z.number().int().min(0).max(255) }).strict()) }).strict();

/** The native launch filters its creation hint, but the agent keeps the
 * realized config home. Both forms identify the same registered cleanup unit. */
export function requiredConfigurationRoot(env: Readonly<Partial<NodeJS.ProcessEnv>>) {
  if (env.LLV_AGENT_SANDBOX_ROOT) return env.LLV_AGENT_SANDBOX_ROOT;
  const config = env.XDG_CONFIG_HOME;
  if (config && path.basename(config) === "config" && path.basename(path.dirname(config)).startsWith("llv-stage-config-"))
    return path.dirname(config);
  return undefined;
}

export function physical(directory: string): string {
  if (path.resolve(directory) !== fs.realpathSync(directory)) throw new Error("recorded check path has an indirect parent");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("recorded check directory is not owned");
  return `${stat.dev}:${stat.ino}`;
}
export function ownedFile(root: string, file: string): string {
  relative.parse(file); physical(root);
  const target = path.join(root, file);
  if (fs.realpathSync(target) !== target) throw new Error("recorded check file has an indirect path");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error("recorded check file is not an owned regular file");
  return target;
}
export function evidenceStamp(root: string, file: string): string {
  const stat = fs.statSync(ownedFile(root, file), { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function evidenceFile(filename: string) {
  if (path.resolve(filename) !== fs.realpathSync(filename)) throw new Error("recorded evidence path changed");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()
      || process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${fd}`) !== filename)
      throw new Error("recorded evidence file identity changed");
    return { fd, stat };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function evidenceSignal(deadline: number) {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new Error("recorded evidence operation deadline exceeded");
  return AbortSignal.timeout(remaining);
}
export async function fileDigest(filename: string, deadline = performance.now() + 30_000): Promise<string> {
  const signal = evidenceSignal(deadline), { fd, stat } = evidenceFile(filename);
  try {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filename, { fd, autoClose: false, signal })) hash.update(chunk);
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("recorded evidence changed during read");
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
export async function retainFile(source: string, target: string, deadline: number) {
  const signal = evidenceSignal(deadline), { fd } = evidenceFile(source);
  let destination: number | undefined;
  try {
    destination = fs.openSync(target, "wx", 0o600);
    await pipeline(fs.createReadStream(source, { fd, autoClose: false }),
      fs.createWriteStream(target, { fd: destination, autoClose: false }), { signal });
    fs.fsyncSync(destination);
  } catch (error) {
    if (destination !== undefined) {
      fs.closeSync(destination); destination = undefined;
      fs.rmSync(target, { force: true });
    }
    throw error;
  } finally {
    if (destination !== undefined) fs.closeSync(destination);
    fs.closeSync(fd);
  }
}
export function readEnvelope(filename: string): unknown {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > ENVELOPE_BYTES) throw new Error("invalid recorded check envelope");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
export function writeEnvelope(filename: string, value: unknown) {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > ENVELOPE_BYTES) throw new Error("recorded check envelope exceeds its bound");
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** The producer and admission both use this builder's hashed physical inputs. */
export async function buildManifest(input: Omit<Manifest, "version" | "inputs" | "roots" | "deadlineUptimeMs" | "clockBootEpoch"> & {
  roots: Array<{ directory: string; purpose: "evidence" | "configuration" }>;
  inputs: Array<{ root: string; file: string }>;
  executionEnvironment?: Readonly<Partial<NodeJS.ProcessEnv>>;
}): Promise<Manifest> {
  const { executionEnvironment, ...declaration } = input;
  const deadlineUptimeMs = custodyClock() + (input.deadline - Date.now());
  const clockBootEpoch = cpuOwnerIdentity(process.pid).bootEpoch;
  const requiredRoots = [...declaration.roots];
  const configuration = requiredConfigurationRoot(executionEnvironment ?? process.env);
  if (configuration && !requiredRoots.some(root => path.resolve(root.directory) === path.resolve(configuration)))
    requiredRoots.push({ directory: configuration, purpose: "configuration" });
  const roots = requiredRoots.map(root => ({ ...root, directory: path.resolve(root.directory), identity: physical(path.resolve(root.directory)) }));
  const inputs = [];
  for (const entry of input.inputs) inputs.push({ ...entry, sha256: await fileDigest(ownedFile(entry.root, entry.file)) });
  const manifest = manifestSchema.parse({ ...declaration, version: 1, deadlineUptimeMs, clockBootEpoch, roots, inputs });
  await verifyManifest(manifest);
  return manifest;
}
export async function verifyManifest(manifest: Manifest, deadline = performance.now() + 10_000) {
  const roots = new Map(manifest.roots.map(root => [root.directory, root]));
  if (roots.size !== manifest.roots.length || new Set(manifest.selection).size !== manifest.selection.length) throw new Error("duplicate recorded check identity");
  for (const root of roots.values()) if (physical(root.directory) !== root.identity) throw new Error("recorded check root changed");
  for (const entry of [...manifest.outputs, manifest.completion, ...manifest.inputs]) {
    relative.parse(entry.file);
    if (!roots.has(entry.root) || roots.get(entry.root)!.purpose !== "evidence") throw new Error("recorded check file is outside its evidence roots");
  }
  if (!path.isAbsolute(manifest.cwd) || !manifest.roots.some(root => manifest.cwd === root.directory || manifest.cwd.startsWith(root.directory + path.sep))) throw new Error("recorded check cwd is outside its roots");
  const stamp = (entry: Manifest["inputs"][number]) => evidenceStamp(entry.root, entry.file);
  const sources = manifest.inputs.map(entry => ({ entry, stamp: stamp(entry) }));
  for (const { entry } of sources) if (await fileDigest(ownedFile(entry.root, entry.file), deadline) !== entry.sha256) throw new Error("recorded check source changed");
  // Hash outside shared admission. Its final synchronous boundary rejects
  // any intervening write or replacement, including a restored mtime.
  const assertUnchanged = () => {
    for (const root of roots.values()) if (physical(root.directory) !== root.identity) throw new Error("recorded check root changed during verification");
    for (const source of sources) if (stamp(source.entry) !== source.stamp) throw new Error("recorded check source changed after verification");
  };
  assertUnchanged();
  return assertUnchanged;
}
export function descriptorDigest(value: Omit<Descriptor, "descriptorDigest" | "wrapper">): string { return digest(value); }
export function producerCommandIdentity(pid: number | undefined): ProcessIdentity | null {
  if (!pid) return null;
  try {
    const identity = hostProcessIdentity(captureProcessIdentity(pid));
    return identity.startIdentity && identity.bootEpoch ? identity : null;
  } catch { return null; }
}
export type RecordedSupervisorObligation = { recorder: Descriptor["recorder"]; deadlineUptimeMs: number };
export function recordedSupervisorObligation(): RecordedSupervisorObligation | null {
  const directory = process.env.LLV_RECORDED_CHECK_DIRECTORY;
  if (!directory) return null;
  const descriptor = descriptorSchema.parse(readEnvelope(path.join(directory, "descriptor.json")));
  if (descriptor.runId !== process.env.LLV_RECORDED_CHECK_ID || physical(directory) !== descriptor.directoryIdentity)
    throw new Error("recorded supervisor obligation changed");
  return { recorder: descriptor.recorder, deadlineUptimeMs: descriptor.deadlineUptimeMs };
}
export function recordedSupervisorRefusal(obligation: RecordedSupervisorObligation | null): "deadline" | "owner" | null {
  if (!obligation) return null;
  if (custodyClock() >= obligation.deadlineUptimeMs) return "deadline";
  return cpuOwnerStatus(obligation.recorder) !== "alive" || cpuOwnerExited(obligation.recorder) ? "owner" : null;
}
export function producerReport(kind: ProducerReport["kind"], command: ProcessIdentity | null, fields: Partial<ProducerReport> = {}): ProducerReport | null {
  const directory = process.env.LLV_RECORDED_CHECK_DIRECTORY;
  if (!directory) return null;
  const descriptor = descriptorSchema.parse(readEnvelope(path.join(directory, "descriptor.json")));
  if (physical(directory) !== descriptor.directoryIdentity || descriptor.runId !== process.env.LLV_RECORDED_CHECK_ID) throw new Error("recorded check producer binding changed");
  const cgroup = process.env.LLV_OWNED_TEST_RUN_CGROUP, invocation = process.env.INVOCATION_ID;
  const service = cgroup && invocation ? { unit: path.basename(cgroup), cgroup, invocation } : null;
  const report = reportSchema.parse({ version: 1, runId: descriptor.runId, descriptorDigest: descriptor.descriptorDigest,
    supervisor: cpuOwnerIdentity(process.pid), command, kind, service, commandExit: null, commandSignal: null,
    cleanup: "pending", phase: "dispatch", at: Date.now(), atUptimeMs: custodyClock(), ...fields });
  writeEnvelope(path.join(directory, `${kind}.json`), report);
  writeEnvelope(path.join(directory, "supervisor.json"), report);
  return report;
}
