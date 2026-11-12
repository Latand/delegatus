import fs from "node:fs";
import crypto from "node:crypto";
import { agentRegistry, resolveConversationAlias } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { processIdentityStatus, systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";
import { differentKernelBoot } from "@/lib/runtime/agentScope";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { PipelineStageHostRef } from "./types";
import type { HostTerminationProgress } from "./hostTerminationProof";

export function recordedProcessTerminated(identity: ProcessIdentity): boolean {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return false;
  try {
    const currentBoot = systemBootEpoch();
    if (process.platform === "linux") {
      const namespace = fs.readlinkSync("/proc/self/ns/pid");
      if (!currentBoot?.endsWith(`:pidns:${namespace}`) || Number(fs.readlinkSync("/proc/self")) !== process.pid) return false;
    }
    // A verified kernel reboot ends the old process even without a start
    // token. A different PID namespace leaves its old process unobservable.
    if (process.platform === "linux" && identity.bootEpoch && currentBoot && identity.bootEpoch !== currentBoot) {
      return differentKernelBoot(identity.bootEpoch, currentBoot);
    }
    return processIdentityStatus(identity, {
      pidAlive: pid => {
        if (process.platform !== "linux") return procBackend.pidAlive(pid);
        try { fs.statSync(`/proc/${pid}`); return true; }
        catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            // A hidden live PID or an unavailable proc mount is unknown.
            try { process.kill(pid, 0); }
            catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code === "ESRCH") return false;
              throw probeError;
            }
          }
          throw error;
        }
      },
      processIdentity: pid => procBackend.processIdentity(pid),
      bootEpoch: () => currentBoot,
    }) === "dead";
  } catch { return false; }
}

/** Read only the addressed conversation. A missing registry row, unreadable
 * kernel evidence or an incomplete live identity cannot prove termination.
 * Retained native waiters and captured descendants belong to the same proof. */
export type HostTerminationProbe = { terminated: boolean; progress?: HostTerminationProgress; checked: number };
export type HostTerminationInput = { owner: string; identities: readonly ProcessIdentity[]; progress?: HostTerminationProgress; limit?: number };
export function probePipelineStageHostTermination(target: PipelineStageHostRef, input: HostTerminationInput): HostTerminationProbe {
  const unknown: HostTerminationProbe = { terminated: false, checked: 0 };

  try {
    const registry = agentRegistry();
    const conversation = (target.conversationId?.startsWith("conversation_")
      ? registry.conversation(target.conversationId as ViewerConversationId) : null)
      ?? (target.agentPath ? registry.conversationForPath(target.agentPath) : null);
    if (!conversation) return unknown;
    const snapshot = registry.livenessConversationSnapshot(conversation.id);
    const current = snapshot.conversations[resolveConversationAlias(snapshot, conversation.id)];
    if (target.conversationId?.startsWith("conversation_")
      && resolveConversationAlias(snapshot, target.conversationId as ViewerConversationId) !== current?.id) return unknown;
    if (!current?.generations.length || current.generations.some(generation => !snapshot.entries[`${current.engine}:${generation.id}`])) return unknown;
    if (target.agentPath && !current.generations.some(generation => generation.path === target.agentPath)
      && !current.continuityPaths.includes(target.agentPath)) return unknown;
    const identities: ProcessIdentity[] = [...input.identities];
    const owners: unknown[] = [];
    const entries = Object.values(snapshot.entries);
    for (const entry of entries) {
      if (entry.pendingAction) return unknown;
      owners.push([entry.key, entry.claimOwner, entry.claimEpoch, entry.structuredHost?.writerClaimEpoch,
        entry.accountId, entry.artifactPath, entry.structuredHostOperationId, entry.structuredHost?.scope, entry.structuredTerminationCaptureId]);
      const domain = entry.structuredHost?.signalDomain;
      // claimOwner is the Viewer writer, shared by many native hosts. Its
      // identity fences the source above; its life does not keep this host alive.
      const recorded = [entry.structuredHost?.process, entry.structuredHost?.exitProcess, entry.paneAgent, entry.hostExitProcess,
        domain?.monitor, domain?.bubblewrap, domain?.init, domain?.native,
        ...(entry.pendingHostExits ?? []).map(exit => exit.process), ...(entry.structuredTerminationSurvivors ?? [])]
        .filter((identity): identity is ProcessIdentity => Boolean(identity));
      if (!recorded.length && !["dead", "unhosted"].includes(entry.status)) return unknown;
      identities.push(...recorded);
    }
    if (!identities.length) return unknown;
    const ordered = [...new Map(identities.map(identity => [JSON.stringify([identity.pid, identity.startIdentity, identity.bootEpoch ?? null]), identity])).entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const source = crypto.createHash("sha256").update(JSON.stringify(["termination-v1", input.owner, registry.filename,
      current.id, current.engine, current.generations, current.continuityPaths, owners, systemBootEpoch(), ordered.map(([key]) => key)])).digest("hex");
    let next = input.progress?.source === source && input.progress.next <= ordered.length ? input.progress.next : 0;
    let checked = 0;
    const limit = Math.max(0, Math.min(64, input.limit ?? 64));
    while (next < ordered.length && checked < limit) {
      checked++;
      if (!recordedProcessTerminated(ordered[next]![1])) break;
      next++;
    }
    return { terminated: next === ordered.length, progress: { source, next }, checked };
  } catch { return unknown; }
}

/** Point probe for callers without durable progress. */
export function pipelineStageHostTerminated(target: PipelineStageHostRef): boolean {
  return probePipelineStageHostTermination(target, { owner: "point-probe", identities: [] }).terminated;
}
