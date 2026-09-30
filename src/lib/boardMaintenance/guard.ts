import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import type { BoardTask } from "@/lib/tasks/types";
import { projectForCwd } from "@/lib/scanner/describe";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { maintenanceRunForConversation, readMaintenanceRun, bindMaintenanceConversation } from "./store";
import { maintenanceRunIsLive, type MaintenanceRun, type MaintenanceChange } from "./types";

type RegistrySnapshot = ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]>;

export interface MaintainerCaller { conversationId: string; project: string | null; run: MaintenanceRun | null }
export function maintainerCallerOf(conversationId: string | null, snapshot: RegistrySnapshot): MaintainerCaller | null {
  if (!conversationId) return null;
  const id = readOnlyConversationLookupFromSnapshot(snapshot).canonicalConversationId(conversationId as `conversation_${string}`);
  const role = conversationAgentRole(snapshot, id);
  if (role && role !== "maintainer") return null;
  let run = maintenanceRunForConversation(id);
  if (!run) {
    const receipt = Object.values(snapshot.receipts).find(r => r.conversationId === id && r.agentRole === "maintainer" && r.clientAttemptId?.startsWith("maint_"));
    if (receipt?.clientAttemptId) {
      run = readMaintenanceRun(receipt.clientAttemptId);
      if (run && maintenanceRunIsLive(run)) run = bindMaintenanceConversation(run.runId, { conversationId: id, launchId: receipt.launchId, transcriptPath: receipt.artifactPath });
    }
  }
  if (!run && role !== "maintainer") return null;
  return { conversationId: id, run, project: run?.project ?? snapshot.conversations[id]?.projectOwnership?.project ?? (snapshot.conversations[id]?.generations.at(-1)?.launchProfile.cwd ? projectForCwd(snapshot.conversations[id].generations.at(-1)!.launchProfile.cwd!) : null) };
}
export interface MaintenanceRefusal { code: string; error: string; field?: string }
/** Input contains fresh work evidence, re-read at the task mutation boundary. */
export function maintainerTaskWriteRefusal(input: { caller: MaintainerCaller; args: Record<string, unknown>; task?: BoardTask; create?: boolean; openPipeline?: string; liveAgent?: string }): MaintenanceRefusal | null {
  const { caller, args, task } = input;
  const refuse = (code: string, error: string, field?: string) => ({ code, error, field });
  if (caller.run && !maintenanceRunIsLive(caller.run)) return refuse("maintainer_run_ended", "This maintenance run has ended; Delegatus accepts no more board writes from it.");
  if (task?.details?.startsWith("Delegatus board maintenance run")) return refuse("maintainer_delete_refused", "Delegatus manages maintenance cards. Leave this card alone.");
  const project = input.create ? args.project : task?.project;
  if (!caller.project || typeof project !== "string" || canonicalOrchestratorProject(project) !== canonicalOrchestratorProject(caller.project) || args.project !== undefined && canonicalOrchestratorProject(String(args.project)) !== canonicalOrchestratorProject(caller.project)) {
    return refuse("maintainer_project_refused", `This run maintains ${caller.project ?? "an unknown project"}; task ${task?.id ?? "new"} belongs to ${String(project)}.`);
  }
  const deleting = ["removeLine", "detachLinks", "assignments", "groupHidden", "origin", "sources", "workLinks"].find(field => args[field] !== undefined)
    ?? (!input.create && ["placement", "beforeTaskId", "afterTaskId"].find(field => args[field] !== undefined))
    ?? (args.board === "hidden" && !input.create ? "board" : args.hide === true ? "hide" : args.details === null || args.details === "" ? "details" : undefined);
  if (deleting) return refuse("maintainer_delete_refused", `A maintenance run deletes nothing and takes nothing off the board; ${deleting} was refused. Use appendLine or replaceLine, or put it on your attention list.`, deleting);
  const created = caller.run?.log.changes.some(c => c.tool === "create_task" && c.taskId === task?.id);
  if (!input.create && typeof args.details === "string" && !created) return refuse("maintainer_details_overwrite_refused", "details as a whole field would replace what the task holds. Send appendLine or replaceLine.", "details");
  if (args.status === "done" && (input.openPipeline || input.liveAgent)) return refuse("maintainer_done_refused", `Task ${task?.id} has ${input.openPipeline ? `an open pipeline ${input.openPipeline}` : `a live agent ${input.liveAgent}`}. A maintenance run never marks such a task done; correct only a plainly wrong status, or put it on your attention list.`, "status");
  if (args.replaceLine && !(args.replaceLine as { text?: unknown }).text) return refuse("maintainer_delete_refused", "An empty replacement deletes a details line. Use a nonempty replacement.", "replaceLine");
  return null;
}
export function maintenanceChange(tool: MaintenanceChange["tool"], before: BoardTask | undefined, after: BoardTask, fields: string[]): MaintenanceChange {
  return { at: new Date().toISOString(), taskId: after.id, tool, fields,
    ...(fields.includes("status") ? { statusFrom: before?.status, statusTo: after.status } : {}),
    ...(fields.includes("text") ? { titleFrom: before?.text.split("\n")[0], titleTo: after.text.split("\n")[0], textBefore: before?.text } : {}),
  };
}
