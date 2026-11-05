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

/** The listener keeps its launch environment when a different Viewer connects.
 * Store only the wait root beside that verified listener, never the environment.
 * Older Linux listeners can supply their original TMPDIR once, through /proc. */
export function socketGateCheckRoot(owner: CodexSocketOwner, launchRoot?: string): string | null {
  if (!verifiedCodexSocketOwner(owner)) return null;
  const filename = path.join(path.dirname(codexSocketPath(owner.endpoint)!), "gate-root.json");
  const identity = JSON.stringify([owner.process.pid, owner.process.startIdentity, owner.process.bootEpoch]);
  try {
    let root = launchRoot;
    if (root === undefined) {
      try {
        const saved = readEnvelope(filename) as { identity?: unknown; root?: unknown; physicalRoot?: unknown; rootDirectoryIdentity?: unknown } | null;
        if (!saved || saved.identity !== identity || typeof saved.root !== "string" || !path.isAbsolute(saved.root)
          || typeof saved.physicalRoot !== "string" || !path.isAbsolute(saved.physicalRoot)
          || typeof saved.rootDirectoryIdentity !== "string") return null;
        const liveRoot = procBackend.readEnvVar(owner.process.pid, "TMPDIR") ?? undefined;
        // On platforms that expose a live process environment, it is the
        // authority for the launch root. The record only carries that binding
        // across Viewer restarts; its process identity alone is insufficient.
        if (liveRoot !== undefined && path.resolve(liveRoot) !== path.resolve(saved.root)) return null;
        const realRoot = fs.realpathSync(saved.root);
        const stat = fs.statSync(realRoot);
        if (realRoot !== saved.physicalRoot || `${stat.dev}:${stat.ino}` !== saved.rootDirectoryIdentity
          || !stat.isDirectory() || !verifiedCodexSocketOwner(owner)) return null;
        return saved.root;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
      // The current Viewer's environment says nothing about the retained CLI.
      root = procBackend.readEnvVar(owner.process.pid, "TMPDIR") ?? undefined;
    }
    if (!root || !path.isAbsolute(root) || !verifiedCodexSocketOwner(owner)) return null;
    const physicalRoot = fs.realpathSync(root);
    const stat = fs.statSync(physicalRoot);
    if (!stat.isDirectory()) return null;
    writeEnvelope(filename, { identity, root, physicalRoot, rootDirectoryIdentity: `${stat.dev}:${stat.ino}` });
    return verifiedCodexSocketOwner(owner) ? root : null;
  } catch { return null; }
}

/** A read-only tool bound to the native stage's own temporary root. */
export async function runGateCheckTool(args: unknown, root: string | null, signal: AbortSignal) {
  try {
    const input = args as { log?: unknown; reason?: unknown } | null;
    if (!input || typeof input.log !== "string" || !path.isAbsolute(input.log)
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
      throw new Error("log and a bounded check reason are required");
    if (!root) throw new Error(`stage temporary root is unavailable (root=null, log=${JSON.stringify(input.log)})`);
    let ownerRoot: string, parent: string;
    try {
      ownerRoot = fs.realpathSync(root);
      parent = fs.realpathSync(path.dirname(input.log));
    } catch (error) {
      throw new Error(`gate paths cannot be resolved (root=${JSON.stringify(root)}, log=${JSON.stringify(input.log)}): ${error instanceof Error ? error.message : String(error)}`);
    }
    const log = path.join(parent, path.basename(input.log));
    const relative = path.relative(ownerRoot, log);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw new Error(`gate log is outside this stage's temporary root (root=${JSON.stringify(root)}, log=${JSON.stringify(input.log)}, resolvedRoot=${JSON.stringify(ownerRoot)}, resolvedLog=${JSON.stringify(log)})`);
    const result = await waitForGateCompletion(log, signal);
    return { success: true, contentItems: [{ type: "inputText" as const, text: JSON.stringify({ reason: input.reason, ...result,
      terminal: result.state.startsWith("finished"),
      ...(!result.state.startsWith("finished") ? { instruction: "No terminal result. Preserve this run and its evidence; do not poll or restart it." } : {}),
    }) }] };
  } catch (error) {
    return { success: false, contentItems: [{ type: "inputText" as const, text: `Check result unknown: ${error instanceof Error ? error.message : String(error)}. Preserve the original run and evidence.` }] };
  }
}
