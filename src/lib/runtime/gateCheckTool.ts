import fs from "node:fs";
import path from "node:path";
import { readEnvelope, writeEnvelope } from "../recordedChecks/wire";
import { procBackend } from "@/lib/proc";
import { codexSocketPath, verifiedCodexSocketOwner, type CodexSocketOwner } from "./codexSocketTransport";
import { waitForGateCompletion } from "./gateWait";

export const gateCheckTool = {
  type: "function", name: "wait_for_check",
  description: "Wait once for an existing recorded gate check through admission, execution and cleanup. Call after gate-slot.sh --record LOG reports recording started. Supply its absolute log path and the check reason. The recorder pins the deadline. This foreground wait works without recorded-check custody; keep the stage alive. A nonterminal result or refusal is unknown: retain evidence and stop, without polling or restarting the command.",
  inputSchema: { type: "object", properties: { log: { type: "string" }, reason: { type: "string" } }, required: ["log", "reason"], additionalProperties: false },
} as const;

type PhysicalGateCheckRoot = Readonly<{ root: string; physicalRoot: string; rootDirectoryIdentity: string }>;
export type GateCheckRoot = PhysicalGateCheckRoot & Readonly<{ additionalRoots?: readonly PhysicalGateCheckRoot[] }>;
type SavedGateCheckRoot = { identity?: unknown; root?: unknown; physicalRoot?: unknown; rootDirectoryIdentity?: unknown; additionalRoots?: unknown };
export const GATE_CHECK_ROOTS_ENV = "LLV_GATE_CHECK_ROOTS";
export const GATE_CHECK_ROOT_IDENTITY_ENV = "LLV_GATE_CHECK_ROOT_DIRECTORY_IDENTITY";

/** Capture once at launch/adoption; callbacks must retain this physical binding. */
export function bindGateCheckRoot(root: string, additionalRoots: readonly string[] = []): GateCheckRoot | null {
  try {
    if (!path.isAbsolute(root)) return null;
    const physicalRoot = fs.realpathSync(root);
    const stat = fs.statSync(physicalRoot);
    if (!stat.isDirectory()) return null;
    const paths = [...new Set(additionalRoots)].filter(value => value !== root);
    if (paths.length > 2) return null;
    const additional = paths.map(value => bindGateCheckRoot(value));
    if (additional.some(value => !value)) return null;
    return Object.freeze({ root, physicalRoot, rootDirectoryIdentity: `${stat.dev}:${stat.ino}`,
      ...(additional.length ? { additionalRoots: Object.freeze(additional as PhysicalGateCheckRoot[]) } : {}) });
  } catch { return null; }
}

function allowedRoots(binding: GateCheckRoot): readonly PhysicalGateCheckRoot[] {
  const { additionalRoots, ...primary } = binding;
  return [primary, ...(additionalRoots ?? [])];
}

function validateGateCheckRoot(binding: GateCheckRoot): void {
  for (const root of allowedRoots(binding)) {
    const current = bindGateCheckRoot(root.root);
    if (!current || current.physicalRoot !== root.physicalRoot || current.rootDirectoryIdentity !== root.rootDirectoryIdentity)
      throw new Error(`stage temporary root identity changed (root=${JSON.stringify(root.root)}, allowedRoots=${JSON.stringify(allowedRoots(binding))})`);
  }
}

/** Only the listener's immutable launch environment can extend recovered authority. */
function launchRoots(value: string): GateCheckRoot | null {
  try {
    const saved = JSON.parse(value) as GateCheckRoot;
    if (!saved || typeof saved.root !== "string" || typeof saved.physicalRoot !== "string"
      || typeof saved.rootDirectoryIdentity !== "string"
      || (saved.additionalRoots !== undefined && (!Array.isArray(saved.additionalRoots) || saved.additionalRoots.length > 2))) return null;
    const roots = allowedRoots(saved);
    if (roots.some(root => !root || typeof root.root !== "string" || typeof root.physicalRoot !== "string"
      || typeof root.rootDirectoryIdentity !== "string")) return null;
    const binding = bindGateCheckRoot(saved.root, roots.slice(1).map(root => root.root));
    return binding && JSON.stringify(allowedRoots(binding)) === JSON.stringify(roots) ? binding : null;
  } catch { return null; }
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
    const rootsProof = procBackend.readEnvVar(owner.process.pid, GATE_CHECK_ROOTS_ENV);
    const binding = rootsProof ? launchRoots(rootsProof) : bindGateCheckRoot(root);
    if (!binding || binding.root !== root || binding.rootDirectoryIdentity !== launchDirectoryIdentity
      || (saved && (binding.physicalRoot !== saved.physicalRoot || binding.rootDirectoryIdentity !== saved.rootDirectoryIdentity
        || JSON.stringify(binding.additionalRoots) !== JSON.stringify(saved.additionalRoots)))) return null;
    if (!saved) writeEnvelope(filename, { identity, ...binding });
    return verifiedCodexSocketOwner(owner) ? binding : null;
  } catch { return null; }
}

/** A read-only tool bound to the native stage's own launch directories. */
export async function runGateCheckTool(args: unknown, binding: GateCheckRoot | null, signal: AbortSignal) {
  try {
    const input = args as { log?: unknown; reason?: unknown } | null;
    if (!input || typeof input.log !== "string" || !path.isAbsolute(input.log)
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
      throw new Error("log and a bounded check reason are required");
    if (!binding) throw new Error(`stage temporary root is unavailable: the verified listener's launch TMPDIR or directory identity proof is unavailable or does not match (root=null, log=${JSON.stringify(input.log)})`);
    const { root } = binding;
    const roots = allowedRoots(binding);
    validateGateCheckRoot(binding);
    let parent: string;
    try {
      parent = fs.realpathSync(path.dirname(input.log));
    } catch (error) {
      throw new Error(`gate paths cannot be resolved (root=${JSON.stringify(root)}, allowedRoots=${JSON.stringify(roots)}, log=${JSON.stringify(input.log)}): ${error instanceof Error ? error.message : String(error)}`);
    }
    const log = path.join(parent, path.basename(input.log));
    const contained = roots.some(owner => {
      const relative = path.relative(owner.physicalRoot, log);
      return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
    });
    if (!contained)
      throw new Error(`gate log is outside this stage's temporary roots (root=${JSON.stringify(root)}, allowedRoots=${JSON.stringify(roots)}, log=${JSON.stringify(input.log)}, resolvedLog=${JSON.stringify(log)})`);
    validateGateCheckRoot(binding);
    // Keep the checked directory open. The reader follows this descriptor for
    // the log and every .gate record, so replacing a path component cannot
    // redirect a later read to another stage.
    const parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
    const openedParent = fs.realpathSync(`/proc/self/fd/${parentFd}`);
    const stillContained = roots.some(owner => {
      const relative = path.relative(owner.physicalRoot, openedParent);
      return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
    });
    if (!stillContained) throw new Error(`gate log directory changed outside this stage's temporary roots (allowedRoots=${JSON.stringify(roots)}, log=${JSON.stringify(input.log)})`);
    validateGateCheckRoot(binding);
    const pinnedLog = `/proc/self/fd/${parentFd}/${path.basename(log)}`;
    const result = await waitForGateCompletion(pinnedLog, signal);
    if (fs.realpathSync(path.dirname(input.log)) !== openedParent)
      throw new Error(`gate log directory changed during the wait (allowedRoots=${JSON.stringify(roots)}, log=${JSON.stringify(input.log)})`);
    validateGateCheckRoot(binding);
    return { success: true, contentItems: [{ type: "inputText" as const, text: JSON.stringify({ reason: input.reason, ...result,
      terminal: result.state.startsWith("finished"),
      ...(!result.state.startsWith("finished") ? { instruction: "No terminal result. Preserve this run and its evidence; do not poll or restart it." } : {}),
    }) }] };
    } finally { fs.closeSync(parentFd); }
  } catch (error) {
    return { success: false, contentItems: [{ type: "inputText" as const, text: `Check result unknown: ${error instanceof Error ? error.message : String(error)}. Preserve the original run and evidence.` }] };
  }
}
