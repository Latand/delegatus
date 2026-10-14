import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import { readOnlyConversationLookupFromSnapshot, type agentRegistry } from "@/lib/agent/registry";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { canonicalProject } from "@/lib/projects/aliases";
import { RoleMemoryRefusal } from "../roleStore";
import { roleMemoryEnabled } from "../settings";
import { machinePass, passForConversation, patchPass, readPass, passIsLive } from "./store";

type Snapshot = ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]>;

/** Admission can precede the launch HTTP response. Bind only its exact receipt. */
export function curatorCallerOf(conversationId: string | null, snapshot: Snapshot) {
  if (!roleMemoryEnabled() || !conversationId) throw new RoleMemoryRefusal("CURATE_CALLER", "only the live curator conversation may curate rules");
  const id = readOnlyConversationLookupFromSnapshot(snapshot).canonicalConversationId(conversationId as `conversation_${string}`);
  let pass = passForConversation(id);
  const receipt = Object.values(snapshot.receipts).find(r => r.conversationId === id && r.agentRole === "curator" && r.clientAttemptId?.startsWith("curate_") && !r.rejection && !["failed", "conflicted"].includes(r.state));
  if (!receipt) throw new RoleMemoryRefusal("CURATE_CALLER", "curator has no admitted pass receipt");
  const conversationRole = conversationAgentRole(snapshot, id);
  if (conversationRole !== "curator" && (conversationRole !== null || receipt.agentRole !== "curator")) {
    throw new RoleMemoryRefusal("CURATE_CALLER", "caller is not a curator");
  }
  const conversation = snapshot.conversations[id];
  const receiptProject = conversationProjectKey(conversation?.projectOwnership, receipt.launchProfile, { project: receipt.explicitProject });
  const held = readPass(receipt.clientAttemptId!);
  if (!receiptProject || !held || canonicalProject(receiptProject) !== canonicalProject(held.project)
    || receipt.explicitProject && canonicalProject(receipt.explicitProject) !== canonicalProject(held.project)) {
    throw new RoleMemoryRefusal("CURATE_CALLER", "curator receipt belongs to a different project");
  }
  if (!pass) {
    if (held && passIsLive(held) && (!held.conversationId || held.conversationId === id) && machinePass()?.id === held.id) {
      pass = patchPass(held.id, { conversationId: id, launchId: receipt.launchId, transcriptPath: receipt.artifactPath });
    }
  }
  if (!pass || !passIsLive(pass) || pass.clientAttemptId !== receipt.clientAttemptId || pass.conversationId !== id || machinePass()?.id !== pass.id) throw new RoleMemoryRefusal("CURATE_CALLER", "this conversation does not own the live pass");
  return pass;
}
