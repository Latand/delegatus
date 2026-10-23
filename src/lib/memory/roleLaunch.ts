import fs from "node:fs";
import path from "node:path";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import { statePath } from "@/lib/configDir";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { roleIsClean } from "./eligibility";
import { learnedRulesSnapshot } from "./roleStore";
import type { AgentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { recordMemoryDelivery, type MemoryEngineStart } from "./deliveryLedger";
import { roleMemoryEnabled } from "./settings";
import { applyOperatorMemorySelector, operatorMemoryEnabled } from "./operatorMemory";
import { memorySelection, prepareRoleSelection, selectionCandidate, frozenSelection } from "./roleSelection";
import { MEMORY_SELECTION_DEADLINE_MS, selectRoleMemory } from "./roleSelect";
import { stateLockDeferral, waitForStateLock } from "@/lib/state/lockWait";

/** Leave headroom below Linux's single-argument ceiling, including the notice. */
export const LEARNED_RULES_MAX_BYTES = 120_000;

/** Rebuild the text-free selector only after durable seat membership proves
    adoption. A stage can use a seat role name and still retain its own clean
    memory fence and selector. */
export function roleMemoryProfileForIdentity(
  profile: LaunchProfile | null | undefined,
  roleId: "orchestrator" | "maintainer" | null | undefined,
  project: string | null | undefined,
  designatedSeat = false,
  /** Proven from the durable record (operatorRootConversation): the selector is re-derived for Delegatus mode. */
  operatorRoot = false,
): LaunchProfile | null | undefined {
  if (profile && !roleId && !designatedSeat) {
    const next = { ...profile };
    applyOperatorMemorySelector(next, project, operatorRoot);
    return next.learnedRules === profile.learnedRules ? profile : next;
  }
  if (!profile || !roleId || !project || project === "*") return profile;
  if (roleId !== "orchestrator" && roleId !== "maintainer") return profile;
  if (!designatedSeat) return profile;
  return {
    ...profile,
    cleanMemory: false,
    learnedRules: { project, roleId },
  };
}

/** Identity comes from durable membership, including resumed and migrated generations. */
export function memoryStartIdentity(registry: AgentRegistry, conversationId: string | undefined, transcriptPath?: string) {
  const id = conversationId ?? (transcriptPath ? registry.conversationForPath(transcriptPath)?.id : undefined);
  if (!id) throw Error("memory delivery requires a durable conversation identity");
  const members = registry.conversationMemberships(id as ViewerConversationId).filter(row => row.kind === "pipeline" && row.stageId && Number.isSafeInteger(row.round) && row.round! > 0);
  const member = members.length === 1 ? members[0] : undefined;
  return { conversationId: id, ...(member ? { attempt: { pipelineId: member.containerId, stageId: member.stageId!, attempt: member.round! } } : {}) };
}

/** The selector survives in receipts; only engine options carry its text.
 * A ledger refusal stops a start: a successfully started attempt must have evidence. */
export async function learnedRulesForLaunchProfile(profile: Pick<LaunchProfile, "cleanMemory" | "learnedRules"> | null | undefined, start?: MemoryEngineStart): Promise<string | undefined> {
  const marker = profile?.learnedRules;
  const clean = profile?.cleanMemory === true;
  const select = () => {
    if (!marker || clean || roleIsClean(marker.roleId) || !roleMemoryEnabled()) return undefined;
    // An operator selector reads rules only while the engines' memory is off.
    if (marker.reader === "operator" && !operatorMemoryEnabled()) return undefined;
    try { return learnedRulesSnapshot(marker.project, marker.roleId, LEARNED_RULES_MAX_BYTES, marker.reader === "operator" ? "operator" : undefined); }
    catch (error) {
      if (stateLockDeferral(error)) throw error;
      // Store diagnostics can contain private text; log only the cause class.
      console.warn("[role-memory] learned rules unavailable at engine start; starting without rules");
      return undefined;
    }
  };
  if (!start?.attempt || !marker || clean || roleIsClean(marker.roleId) || !roleMemoryEnabled()) return start ? recordMemoryDelivery(start, clean, select) : select()?.block;
  await prepareRoleSelection();
  const existing = await waitForStateLock("memory.selection-read", () => memorySelection(start.attempt!));
  const snapshot = existing ? undefined : await waitForStateLock("memory.selection-snapshot", select);
  if (!existing && !snapshot) return recordMemoryDelivery(start, clean, select);
  const candidate = existing ?? selectionCandidate(start.attempt, snapshot!);
  if (!existing && snapshot) {
    const deadline = performance.now() + MEMORY_SELECTION_DEADLINE_MS;
    try {
      const { findPipelineRecord } = await import("@/lib/pipelines/store");
      const pipeline = await waitForStateLock("memory.selection-brief", () => findPipelineRecord(start.attempt!.pipelineId), { waitMs: Math.max(0, deadline - performance.now()) });
      const stage = pipeline?.stages.find(stage => stage.id === start.attempt!.stageId);
      const brief = [pipeline?.task?.slice(0, 2000), pipeline?.spec?.slice(0, 8000), stage?.prompt?.slice(0, 3000)].filter(Boolean).join("\n");
      Object.assign(candidate, await selectRoleMemory(snapshot.candidates, brief, { timeoutMs: Math.max(0, deadline - performance.now()) }), { shadow: process.env.LLV_ROLE_MEMORY_SHADOW !== "off" });
    } catch {
      Object.assign(candidate, { shadow: process.env.LLV_ROLE_MEMORY_SHADOW !== "off", reason: "selector-error" });
    }
  }
  return recordMemoryDelivery(start, clean, () => {
    if (!roleMemoryEnabled()) return undefined;
    return frozenSelection(candidate, snapshot);
  });
}

/** Retire old pointer files only at activation by the state owner. */
export function sweepOldLearnedRulesFiles(now = Date.now()): void {
  const directory = statePath("role-memory", "launch");
  assertStateStartupMutation(directory, "retire learned-rule launch files");
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^learned-rules-[a-f0-9]{64}\.md$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (now - fs.lstatSync(file).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(file);
  }
  if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
}
