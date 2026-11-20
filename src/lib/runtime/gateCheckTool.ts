import fs from "node:fs";
import path from "node:path";
import { digest, missingOwnedFile, physical, readEnvelope, writeEnvelope } from "../recordedChecks/wire";
import { procBackend } from "@/lib/proc";
import { codexSocketPath, verifiedCodexSocketOwner, type CodexSocketOwner } from "./codexSocketTransport";
import { gateCompletionIdentity, GateRecorderLostError, gateRecorderExited, validateGateWaitTimeout, waitForGateCompletion } from "./gateWait";
import { GATE_CHECK_EVIDENCE_ENV, GATE_CHECK_ROOT_ENV, GATE_CHECK_ROOT_IDENTITY_ENV,
  lookupGateRun, readGateCheckEvidence, validateGateRunId, verifyGateRunTicket, type GateCheckRoot, type GateRunRecord } from "./gateCheckRecord";

export const gateCheckTool = {
  type: "function", name: "wait_for_check",
  description: "After recording starts, pass its runId and check reason (or the exact absolute log path for an older run). A wait can return queued, finished or lost. An optional timeoutMs bounds the wait without cancelling the check.",
  inputSchema: { type: "object", properties: { runId: { type: "string" }, log: { type: "string" }, reason: { type: "string" },
    timeoutMs: { type: "number" } }, required: ["reason"], additionalProperties: false },
} as const;

type SavedGateCheckRoot = { identity?: unknown; root?: unknown; physicalRoot?: unknown; rootDirectoryIdentity?: unknown };
export { GATE_CHECK_ROOT_IDENTITY_ENV, type GateCheckRoot } from "./gateCheckRecord";

/** Capture once at launch/adoption; callbacks must retain this physical binding. */
export function bindGateCheckRoot(root: string, evidenceDirectory?: string): GateCheckRoot | null {
  try {
    if (!path.isAbsolute(root)) return null;
    const physicalRoot = fs.realpathSync(root);
    const stat = fs.statSync(physicalRoot);
    if (!stat.isDirectory()) return null;
    const evidence = evidenceDirectory ? { directory: evidenceDirectory, identity: physical(evidenceDirectory) } : undefined;
    return Object.freeze({ root, physicalRoot, rootDirectoryIdentity: `${stat.dev}:${stat.ino}`, ...(evidence ? { evidence } : {}) });
  } catch { return null; }
}

function gateCheckRootPresent(binding: GateCheckRoot): boolean {
  const current = bindGateCheckRoot(binding.root);
  if (current?.physicalRoot === binding.physicalRoot && current.rootDirectoryIdentity === binding.rootDirectoryIdentity) return true;
  if (!fs.lstatSync(binding.root, { throwIfNoEntry: false }) && !fs.lstatSync(binding.physicalRoot, { throwIfNoEntry: false })) return false;
  throw new Error(`stage temporary root identity changed (root=${JSON.stringify(binding.root)})`);
}

function validateGateCheckRoot(binding: GateCheckRoot): void {
  if (!gateCheckRootPresent(binding))
    throw new Error(`stage temporary root identity changed (root=${JSON.stringify(binding.root)})`);
}

/** The listener keeps its launch environment when a different Viewer connects.
 * The stage can edit the saved record, so recovery also needs the verified
 * listener's original TMPDIR. Refuse recovery when that evidence is unavailable. */
export function socketGateCheckRoot(owner: CodexSocketOwner, launchBinding?: GateCheckRoot | null): GateCheckRoot | null {
  if (!verifiedCodexSocketOwner(owner)) return null;
  const filename = path.join(path.dirname(codexSocketPath(owner.endpoint)!), "gate-root.json");
  const identity = JSON.stringify([owner.process.pid, owner.process.startIdentity, owner.process.bootEpoch]);
  try {
    // A new socket launch already captured this physical binding before spawn.
    // Some platforms cannot read another process's environment, so keep that
    // proof instead of trying to rediscover it from the listener.
    if (launchBinding !== undefined) {
      if (!launchBinding) return null;
      validateGateCheckRoot(launchBinding);
      if (!verifiedCodexSocketOwner(owner)) return null;
      writeEnvelope(filename, { identity, ...launchBinding });
      return verifiedCodexSocketOwner(owner) ? launchBinding : null;
    }

    let root: string | undefined;
    let saved: SavedGateCheckRoot | null = null;
    try {
      saved = readEnvelope(filename) as SavedGateCheckRoot | null;
      if (!saved || saved.identity !== identity || typeof saved.root !== "string" || !path.isAbsolute(saved.root)
        || typeof saved.physicalRoot !== "string" || !path.isAbsolute(saved.physicalRoot)
        || typeof saved.rootDirectoryIdentity !== "string") return null;
      const liveRoot = procBackend.readEnvVar(owner.process.pid, "TMPDIR");
      if (!liveRoot || path.resolve(liveRoot) !== path.resolve(saved.root)) return null;
      root = saved.root;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    // The current Viewer's environment says nothing about the retained CLI.
    if (root === undefined) root = procBackend.readEnvVar(owner.process.pid, "TMPDIR") ?? undefined;
    if (!root || !verifiedCodexSocketOwner(owner)) return null;
    // This listener-owned launch proof is required for both saved and missing
    // records. TMPDIR locates the root; only its launch-time device/inode
    // distinguishes the original directory from a replacement at that path.
    const launchDirectoryIdentity = procBackend.readEnvVar(owner.process.pid, GATE_CHECK_ROOT_IDENTITY_ENV);
    if (!launchDirectoryIdentity) return null;
    const evidence = readGateCheckEvidence(procBackend.readEnvVar(owner.process.pid, GATE_CHECK_EVIDENCE_ENV), launchDirectoryIdentity);
    const liveBinding = bindGateCheckRoot(root);
    const launchPhysicalRoot = liveBinding?.physicalRoot ?? procBackend.readEnvVar(owner.process.pid, GATE_CHECK_ROOT_ENV);
    if (!launchPhysicalRoot || !path.isAbsolute(launchPhysicalRoot) || (!liveBinding && !evidence)) return null;
    const binding = Object.freeze({ root, physicalRoot: launchPhysicalRoot, rootDirectoryIdentity: launchDirectoryIdentity,
      ...(evidence ? { evidence } : {}) });
    gateCheckRootPresent(binding);
    if (saved && (binding.physicalRoot !== saved.physicalRoot || binding.rootDirectoryIdentity !== saved.rootDirectoryIdentity)) return null;
    if (!saved) writeEnvelope(filename, { identity, ...binding });
    return verifiedCodexSocketOwner(owner) ? binding : null;
  } catch { return null; }
}

/** A read-only tool bound to the native stage's own temporary root. */
export function prepareGateCheckTool(args: unknown, binding: GateCheckRoot | null) {
  const input = args as { runId?: unknown; log?: unknown; reason?: unknown; timeoutMs?: unknown } | null;
  if (!input || (input.runId !== undefined ? typeof input.runId !== "string" : typeof input.log !== "string" || !path.isAbsolute(input.log))
    || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
    throw new Error("runId or an absolute log and a bounded check reason are required");
  const { reason, timeoutMs } = input;
  if (timeoutMs !== undefined) validateGateWaitTimeout(timeoutMs);
  if (typeof input.runId === "string") validateGateRunId(input.runId);
  if (!binding) throw new Error(`stage temporary root is unavailable: the verified listener's launch TMPDIR or directory identity proof is unavailable or does not match (root=null, log=${JSON.stringify(input.log)})`);
  const { root, physicalRoot: ownerRoot } = binding;
  if (typeof input.runId === "string") {
    const record = lookupGateRun(ownerRoot, binding.rootDirectoryIdentity, input.runId, gateCheckRootPresent(binding), binding.evidence);
    return { log: record.log, reason, runId: digest({ log: record.log, ticket: record }), record, timeoutMs, binding };
  }
  validateGateCheckRoot(binding);
  const requestedLog = input.log as string;
  let parent: string;
  try {
    parent = fs.realpathSync(path.dirname(requestedLog));
  } catch (error) {
    throw new Error(`gate paths cannot be resolved (root=${JSON.stringify(root)}, log=${JSON.stringify(input.log)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const log = path.join(parent, path.basename(requestedLog));
  const relative = path.relative(ownerRoot, log);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error(`gate log is outside this stage's temporary root (root=${JSON.stringify(root)}, log=${JSON.stringify(input.log)}, resolvedRoot=${JSON.stringify(ownerRoot)}, resolvedLog=${JSON.stringify(log)})`);
  validateGateCheckRoot(binding);
  return { log, reason, runId: gateCompletionIdentity(log).runId, record: null, timeoutMs, binding };
}

type PreparedGateCheck = ReturnType<typeof prepareGateCheckTool>;
class GateScratchMissingError extends Error {}

function recheckGateRunRecord(binding: GateCheckRoot, record: GateRunRecord): boolean {
  const scratchPresent = gateCheckRootPresent(binding);
  const current = lookupGateRun(binding.physicalRoot, binding.rootDirectoryIdentity, record.runId, scratchPresent, binding.evidence);
  if (digest(current) !== digest(record)) throw new Error("gate run record changed during the wait");
  return scratchPresent;
}

function recheckGateRun({ binding, record }: PreparedGateCheck): void {
  if (!record) { validateGateCheckRoot(binding); return; }
  if (!recheckGateRunRecord(binding, record)) throw new GateScratchMissingError("The recording's scratch directory is missing");
  verifyGateRunTicket(record);
}

function lostGateReason(error: unknown, prepared: PreparedGateCheck): string | undefined {
  const { binding, record, log } = prepared;
  if (error instanceof GateRecorderLostError) {
    try {
      recheckGateRun(prepared);
      if (gateCompletionIdentity(log).runId !== prepared.runId) throw new Error("gate completion run identity changed");
      return "The recorder exited before publishing a terminal verdict";
    } catch (recheckError) {
      if (!(recheckError instanceof GateScratchMissingError) && (recheckError as NodeJS.ErrnoException).code !== "ENOENT") throw recheckError;
      error = recheckError;
    }
  }
  if (!(error instanceof GateScratchMissingError) && (error as NodeJS.ErrnoException).code !== "ENOENT") return;
  if (!record || !gateRecorderExited(record.recorder)) return;
  const { physicalRoot } = binding;
  if (!recheckGateRunRecord(binding, record) || [log, path.join(`${log}.gate`, "owner.json"), path.join(`${log}.gate`, "completion.json")]
    .some(file => missingOwnedFile(physicalRoot, path.relative(physicalRoot, file))))
    return "The recording's scratch files are missing and its recorder exited without a readable verdict";
}

function gateAnswer(result: object) {
  return { success: true, contentItems: [{ type: "inputText" as const, text: JSON.stringify(result) }] };
}

export async function runGateCheckTool(args: unknown, binding: GateCheckRoot | null, signal: AbortSignal, expectedRunId?: string) {
  let reportedRunId: string | undefined;
  try {
    const prepared = prepareGateCheckTool(args, binding);
    const { record } = prepared;
    const completionId = expectedRunId ?? prepared.runId;
    reportedRunId = record?.runId ?? completionId;
    if (completionId !== prepared.runId) throw new Error("gate completion run identity changed");
    try {
      if (signal.aborted) throw new Error("gate completion wait cancelled; command result unknown");
      recheckGateRun(prepared);
      const result = await waitForGateCompletion(prepared.log, signal, completionId, prepared.timeoutMs);
      recheckGateRun(prepared);
      const terminal = result.state.startsWith("finished");
      return gateAnswer({ reason: prepared.reason, ...result, runId: reportedRunId, terminal,
        ...(!terminal ? { outcome: "unknown", instruction: "Preserve this run and its evidence. A later wait can read the same run." } : {}),
      });
    } catch (error) {
      const reason = lostGateReason(error, prepared);
      if (!reason) throw error;
      return gateAnswer({ runId: reportedRunId, state: "lost", outcome: "lost", terminal: true, code: null, reason,
        instruction: "Preserve the original evidence. Once the original work stops, you may rerun the check once with a fresh log." });
    }
  } catch (error) {
    return { success: false, contentItems: [{ type: "inputText" as const, text: `Check result unknown${reportedRunId ? ` (runId=${reportedRunId})` : ""}: ${(error instanceof Error ? error.message : String(error)).slice(0, 8192)}. Preserve the original run and evidence.` }] };
  }
}
