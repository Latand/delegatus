import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import type { BoardTask } from "@/lib/tasks/types";
import { projectForCwd } from "@/lib/scanner/describe";
import { canonicalOrchestratorProject, orchestratorSeatForOrUnknown, revokedOrchestratorSeatConversationsOrUnknown } from "@/lib/orchestrator/seats";
import { maintenanceRunForConversation, maintenanceRunIdForConversation, readMaintenanceRun, bindMaintenanceConversation } from "./store";
import { maintenanceRunIsLive, type MaintenanceRun, type MaintenanceChange } from "./types";

type RegistrySnapshot = ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]>;

export interface MaintainerCaller { conversationId: string; project: string | null; run: MaintenanceRun | null; endedScheduledRun?: boolean }
export function maintainerCallerOf(conversationId: string | null, snapshot: RegistrySnapshot): MaintainerCaller | null {
  if (!conversationId) return null;
  const id = readOnlyConversationLookupFromSnapshot(snapshot).canonicalConversationId(conversationId as `conversation_${string}`);
  const role = conversationAgentRole(snapshot, id);
  if (role && role !== "maintainer") return null;
  const indexedRunId = maintenanceRunIdForConversation(id);
  let run = maintenanceRunForConversation(id);
  let identifiedScheduledRun = Boolean(indexedRunId);
  if (!run) {
    const receipt = Object.values(snapshot.receipts).find(r => r.conversationId === id && r.agentRole === "maintainer" && r.clientAttemptId?.startsWith("maint_"));
    if (receipt?.clientAttemptId) {
      identifiedScheduledRun = true;
      run = readMaintenanceRun(receipt.clientAttemptId);
      if (run && maintenanceRunIsLive(run)) run = bindMaintenanceConversation(run.runId, { conversationId: id, launchId: receipt.launchId, transcriptPath: receipt.artifactPath });
    }
  }
  const endedScheduledRun = identifiedScheduledRun && !run;
  if (!run && role !== "maintainer" && !endedScheduledRun) return null;
  return { conversationId: id, run, endedScheduledRun, project: run?.project ?? snapshot.conversations[id]?.projectOwnership?.project ?? (snapshot.conversations[id]?.generations.at(-1)?.launchProfile.cwd ? projectForCwd(snapshot.conversations[id].generations.at(-1)!.launchProfile.cwd!) : null) };
}
export interface MaintenanceRefusal { code: string; error: string; field?: string }
/** A retired seat's own card, verified against current/pending designations.
 * An ordinary release task linked to a former seat is still work. The launch
 * origin or the seat placeholder title must identify the seat card itself.
 * Resolve aliases on both sides so an identity migration cannot hide a seat.
 */
export function retiredSeatTask(
  task: BoardTask,
  snapshot: RegistrySnapshot,
  seatsFor = orchestratorSeatForOrUnknown,
  revokedFor = revokedOrchestratorSeatConversationsOrUnknown,
): boolean {
  const seats = seatsFor(task.project);
  if (!seats || task.assignments.length === 0) return false;
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const canonical = (id: string) => lookup.canonicalConversationId(id as `conversation_${string}`);
  const current = [seats.active, seats.pending].filter(s => s !== null);
  const revoked = revokedFor(canonical);
  if (!revoked) return false;
  const placeholder = /^orchestrator\s*·/i.test(task.text.split("\n")[0]);
  const identities = task.assignments.map(a => {
    const pathId = a.path ? lookup.conversationForPath(a.path)?.id : null;
    const id = a.conversationId ? canonical(a.conversationId) : pathId ? canonical(pathId) : null;
    return { assignment: a, id };
  });
  if (identities.some(({ assignment: a, id }) => !id || current.some(s => s.conversationId && canonical(s.conversationId) === id || a.path && s.path === a.path))) return false;
  return identities.some(({ assignment: a, id }) => {
    const ownOrigin = task.origin && (task.origin.kind === "launch" || task.origin.kind === "conversation")
      && [a.clientAttemptId, a.launchId, a.conversationId, a.path].includes(task.origin.key);
    return !!id && (placeholder || ownOrigin) && (revoked.has(id) || conversationAgentRole(snapshot, id) === "orchestrator");
  });
}
/** Input contains fresh work evidence, re-read at the task mutation boundary. */
export function maintainerTaskWriteRefusal(input: { caller: MaintainerCaller; args: Record<string, unknown>; task?: BoardTask; create?: boolean; openPipeline?: string; liveAgent?: string; retiredSeat?: boolean }): MaintenanceRefusal | null {
  const { caller, args, task } = input;
  const refuse = (code: string, error: string, field?: string) => ({ code, error, field });
  if (caller.endedScheduledRun || caller.run && !maintenanceRunIsLive(caller.run)) return refuse("maintainer_run_ended", "This maintenance run has ended; Delegatus accepts no more board writes from it.");
  if (task?.details?.startsWith("Delegatus board maintenance run")) return refuse("maintainer_delete_refused", "Delegatus manages maintenance cards. Leave this card alone.");
  const project = input.create ? args.project : task?.project;
  if (!caller.project || typeof project !== "string" || canonicalOrchestratorProject(project) !== canonicalOrchestratorProject(caller.project) || args.project !== undefined && canonicalOrchestratorProject(String(args.project)) !== canonicalOrchestratorProject(caller.project)) {
    return refuse("maintainer_project_refused", `This run maintains ${caller.project ?? "an unknown project"}; task ${task?.id ?? "new"} belongs to ${String(project)}.`);
  }
  const retiring = input.retiredSeat && (args.status ?? task?.status) === "done" && !input.openPipeline && !input.liveAgent;
  const deleting = ["removeLine", "detachLinks", "assignments", "groupHidden", "origin", "sources", "workLinks"].find(field => args[field] !== undefined)
    ?? (!input.create && ["placement", "beforeTaskId", "afterTaskId"].find(field => args[field] !== undefined))
    ?? (args.board === "hidden" && !input.create && !retiring ? "board" : args.hide === true && !retiring ? "hide" : args.details === null || typeof args.details === "string" && args.details.trim() === "" ? "details" : undefined);
  if (deleting) return refuse("maintainer_delete_refused", `A maintenance run deletes nothing and takes nothing off the board; ${deleting} was refused. Use appendLine or replaceLine, or put it on your attention list.`, deleting);
  const created = caller.run?.log.changes.some(c => c.tool === "create_task" && c.taskId === task?.id);
  if (!input.create && typeof args.details === "string" && !created) return refuse("maintainer_details_overwrite_refused", "details as a whole field would replace what the task holds. Send appendLine or replaceLine.", "details");
  if (args.status === "done" && (input.openPipeline || input.liveAgent)) return refuse("maintainer_done_refused", `Task ${task?.id} has ${input.openPipeline ? `an open pipeline ${input.openPipeline}` : `a live agent ${input.liveAgent}`}. A maintenance run never marks such a task done; correct only a plainly wrong status, or put it on your attention list.`, "status");
  if (args.replaceLine && (typeof (args.replaceLine as { text?: unknown }).text !== "string" || !(args.replaceLine as { text: string }).text.trim())) return refuse("maintainer_delete_refused", "An empty replacement deletes a details line. Use a nonempty replacement.", "replaceLine");
  return null;
}
export function maintenanceChange(tool: MaintenanceChange["tool"], before: BoardTask | undefined, after: BoardTask, fields: string[]): MaintenanceChange {
  return { at: new Date().toISOString(), taskId: after.id, tool, fields,
    ...(fields.includes("status") ? { statusFrom: before?.status, statusTo: after.status } : {}),
    ...(fields.includes("text") ? { titleFrom: before?.text.split("\n")[0], titleTo: after.text.split("\n")[0], textBefore: before?.text } : {}),
  };
}
