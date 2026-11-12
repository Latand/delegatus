import fs from "node:fs";
import crypto from "node:crypto";
import { agentRegistry, resolveConversationAlias } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { processIdentityStatus, systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";
import { differentKernelBoot } from "@/lib/runtime/agentScope";
import { agentScopeCommand, recordedAgentScope } from "@/lib/runtime/agentScope";
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
export type HostTerminationProbe = { terminated: boolean; progress?: HostTerminationProgress; checked: number; sourceRevision?: string };
export type HostTerminationInput = { owner: string; identities: readonly ProcessIdentity[]; identitySources?: readonly (readonly ProcessIdentity[])[];
  identitySourceRevision?: string; progress?: HostTerminationProgress; limit?: number;
  scopeState?: (unit: string) => Promise<string> };
export async function probePipelineStageHostTermination(target: PipelineStageHostRef, input: HostTerminationInput): Promise<HostTerminationProbe> {
  const unknown: HostTerminationProbe = { terminated: false, checked: 0 };

  try {
    const registry = agentRegistry();
    const conversation = (target.conversationId?.startsWith("conversation_")
      ? registry.conversation(target.conversationId as ViewerConversationId) : null)
      ?? (target.agentPath ? registry.conversationForPath(target.agentPath) : null);
    if (!conversation) return unknown;
    // Fence the exact registry image used to collect evidence. The later scope
    // query is asynchronous, so its completion must never bless an older read.
    const sourceRevision = registry.livenessRevision();
    const snapshot = registry.livenessConversationSnapshot(conversation.id);
    if (registry.livenessRevision() !== sourceRevision) return unknown;
    const current = snapshot.conversations[resolveConversationAlias(snapshot, conversation.id)];
    if (target.conversationId?.startsWith("conversation_")
      && resolveConversationAlias(snapshot, target.conversationId as ViewerConversationId) !== current?.id) return unknown;
    if (!current?.generations.length || current.generations.some(generation => !snapshot.entries[`${current.engine}:${generation.id}`])) return unknown;
    if (target.agentPath && !current.generations.some(generation => generation.path === target.agentPath)
      && !current.continuityPaths.includes(target.agentPath)) return unknown;
    const registryIdentitySources: ProcessIdentity[][] = [];
    const entries = Object.values(snapshot.entries);
    const scopes = new Map<string, ReturnType<typeof recordedAgentScope>>();
    for (const entry of entries) {
      if (entry.pendingAction) return unknown;
      const scope = recordedAgentScope(entry.structuredHost);
      if (scope) scopes.set(`${scope.unit}\u0000${scope.bootEpoch ?? ""}`, scope);
      const domain = entry.structuredHost?.signalDomain;
      // claimOwner is the Viewer writer, shared by many native hosts. Its
      // identity fences the source above; its life does not keep this host alive.
      const recorded = [entry.structuredHost?.process, entry.structuredHost?.exitProcess, entry.paneAgent, entry.hostExitProcess,
        domain?.monitor, domain?.bubblewrap, domain?.init, domain?.native]
        .filter((identity): identity is ProcessIdentity => Boolean(identity));
      if (!recorded.length && !["dead", "unhosted"].includes(entry.status)) return unknown;
      if (recorded.length) registryIdentitySources.push(recorded);
      if (entry.pendingHostExits?.length) {
        const exits = entry.pendingHostExits;
        registryIdentitySources.push(new Proxy([] as ProcessIdentity[], { get: (_target, key) => {
          if (key === "length") return exits.length;
          if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) return exits[Number(key)]?.process;
          return undefined;
        } }));
      }
      if (entry.structuredTerminationSurvivors?.length) registryIdentitySources.push(entry.structuredTerminationSurvivors);
    }
    // A root PID can disappear while a detached child remains in its recorded
    // systemd scope. The scope is the ownership boundary, including legacy
    // memory.unit records. Only not-found (or a proven earlier kernel boot)
    // establishes that the scope has gone; unreadable and loaded scopes stay
    // unconfirmed.
    for (const scope of scopes.values()) {
      if (!scope) continue;
      const currentBoot = systemBootEpoch();
      if (scope.bootEpoch && currentBoot && scope.bootEpoch !== currentBoot) {
        if (differentKernelBoot(scope.bootEpoch, currentBoot)) continue;
        return unknown;
      }
      try {
        const loadState = input.scopeState ? await input.scopeState(scope.unit)
          : await agentScopeCommand(["show", "--value", "-p", "LoadState", scope.unit]);
        if (loadState !== "not-found") return unknown;
      } catch { return unknown; }
    }
    const identitySources = [...(input.identities.length ? [input.identities] : []), ...(input.identitySources ?? []), ...registryIdentitySources];
    const identityCount = identitySources.reduce((count, source) => count + source.length, 0);
    if (!identityCount) return unknown;
    // The owner and registry row custody fence the source. Keep the identity
    // list in its recorded order and resume by index: sorting and deduplicating
    // the full retained tree made even a zero-probe checkpoint O(tree size).
    const source = crypto.createHash("sha256").update(JSON.stringify(["termination-v2", input.owner, registry.filename,
      sourceRevision, input.identitySourceRevision ?? null, current.id, current.engine, current.generations.length, current.continuityPaths.length,
      systemBootEpoch(), identityCount])).digest("hex");
    let next = input.progress?.source === source && input.progress.next <= identityCount ? input.progress.next : 0;
    let checked = 0;
    const limit = Math.max(0, Math.min(64, input.limit ?? 64));
    while (next < identityCount && checked < limit) {
      checked++;
      let at = next, identity: ProcessIdentity | undefined;
      for (const identities of identitySources) {
        if (at < identities.length) { identity = identities[at]; break; }
        at -= identities.length;
      }
      if (!identity) return unknown;
      if (!recordedProcessTerminated(identity)) break;
      next++;
    }
    if (registry.livenessRevision() !== sourceRevision) return unknown;
    return { terminated: next === identityCount, progress: { source, next }, checked, sourceRevision };
  } catch { return unknown; }
}

/** Synchronous fence used inside the SQLite write checkpoint after async scope
 * evidence and all bounded process pages have completed. */
export function pipelineStageHostTerminationSourceCurrent(sourceRevision: string): boolean {
  try { return agentRegistry().livenessRevision() === sourceRevision; }
  catch { return false; }
}

/** Point probe for callers without durable progress. */
export async function pipelineStageHostTerminated(target: PipelineStageHostRef): Promise<boolean> {
  return (await probePipelineStageHostTermination(target, { owner: "point-probe", identities: [] })).terminated;
}
