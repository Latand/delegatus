import fs from "node:fs";
import path from "node:path";
import { readEnvelope, writeEnvelope } from "../recordedChecks/wire";
import { procBackend } from "@/lib/proc";
import { codexSocketPath, verifiedCodexSocketOwner, type CodexSocketOwner } from "./codexSocketTransport";
import { gateCompletionIdentity, waitForGateCompletion } from "./gateWait";
import { GATE_CHECK_ROOT_IDENTITY_ENV, resolveGateRun } from "./gateCheckRecord";

export const gateCheckTool = {
  type: "function", name: "wait_for_check",
  description: "After recording starts, pass its runId and check reason (or the exact absolute log path for an older run) and keep the stage alive until this single wait returns.",
  inputSchema: { type: "object", properties: { runId: { type: "string" }, log: { type: "string" }, reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
} as const;

export type GateCheckRoot = Readonly<{ root: string; physicalRoot: string; rootDirectoryIdentity: string }>;
type SavedGateCheckRoot = { identity?: unknown; root?: unknown; physicalRoot?: unknown; rootDirectoryIdentity?: unknown };
export { GATE_CHECK_ROOT_IDENTITY_ENV } from "./gateCheckRecord";

/** Capture once at launch/adoption; callbacks must retain this physical binding. */
export function bindGateCheckRoot(root: string): GateCheckRoot | null {
  try {
    if (!path.isAbsolute(root)) return null;
    const physicalRoot = fs.realpathSync(root);
    const stat = fs.statSync(physicalRoot);
    return stat.isDirectory() ? Object.freeze({ root, physicalRoot, rootDirectoryIdentity: `${stat.dev}:${stat.ino}` }) : null;
  } catch { return null; }
}

function validateGateCheckRoot(binding: GateCheckRoot): void {
  const current = bindGateCheckRoot(binding.root);
  if (!current || current.physicalRoot !== binding.physicalRoot || current.rootDirectoryIdentity !== binding.rootDirectoryIdentity)
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
    const binding = bindGateCheckRoot(root);
    if (!binding || binding.rootDirectoryIdentity !== launchDirectoryIdentity
      || (saved && (binding.physicalRoot !== saved.physicalRoot || binding.rootDirectoryIdentity !== saved.rootDirectoryIdentity))) return null;
    if (!saved) writeEnvelope(filename, { identity, ...binding });
    return verifiedCodexSocketOwner(owner) ? binding : null;
  } catch { return null; }
}

/** A read-only tool bound to the native stage's own temporary root. */
export function prepareGateCheckTool(args: unknown, binding: GateCheckRoot | null) {
  const input = args as { runId?: unknown; log?: unknown; reason?: unknown } | null;
  if (!input || (input.runId !== undefined ? typeof input.runId !== "string" : typeof input.log !== "string" || !path.isAbsolute(input.log))
    || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
    throw new Error("runId or an absolute log and a bounded check reason are required");
  if (!binding) throw new Error(`stage temporary root is unavailable: the verified listener's launch TMPDIR or directory identity proof is unavailable or does not match (root=null, log=${JSON.stringify(input.log)})`);
  const { root, physicalRoot: ownerRoot } = binding;
  validateGateCheckRoot(binding);
  const record = typeof input.runId === "string" ? resolveGateRun(ownerRoot, input.runId) : null;
  const requestedLog = record?.log ?? (input.log as string);
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
  return { log, reason: input.reason, runId: gateCompletionIdentity(log).runId, record };
}

export async function runGateCheckTool(args: unknown, binding: GateCheckRoot | null, signal: AbortSignal, expectedRunId?: string) {
  let reportedRunId: string | undefined;
  try {
    const prepared = prepareGateCheckTool(args, binding);
    const { record } = prepared;
    const completionId = expectedRunId ?? prepared.runId;
    reportedRunId = record?.runId ?? completionId;
    const result = await waitForGateCompletion(prepared.log, signal, completionId);
    validateGateCheckRoot(binding!);
    if (record && JSON.stringify(resolveGateRun(binding!.physicalRoot, record.runId)) !== JSON.stringify(record))
      throw new Error("gate run record changed during the wait");
    return { success: true, contentItems: [{ type: "inputText" as const, text: JSON.stringify({ reason: prepared.reason, ...result,
      ...(record ? { runId: record.runId } : {}),
      terminal: result.state.startsWith("finished"),
      ...(!result.state.startsWith("finished") ? { outcome: "unknown", instruction: "No terminal result. Preserve this run and its evidence; do not poll or restart it." } : {}),
    }) }] };
  } catch (error) {
    return { success: false, contentItems: [{ type: "inputText" as const, text: `Check result unknown${reportedRunId ? ` (runId=${reportedRunId})` : ""}: ${(error instanceof Error ? error.message : String(error)).slice(0, 8192)}. Preserve the original run and evidence.` }] };
  }
}
