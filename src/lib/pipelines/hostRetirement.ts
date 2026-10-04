import type { Pipeline, PipelineStageHostRef } from "./types";

/** Match each recorded identity independently: adoption and runtime succession
    can change one field while retaining the same host. */
export function pipelineHostHasLiveWork(
  pipelines: readonly Pipeline[],
  target: Pick<PipelineStageHostRef, "conversationId" | "agentPath" | "paneId" | "launchId"> & { sessionId?: string | null },
  resolveConversation: (id: string) => string = id => id,
): boolean {
  const sameConversation = (id: string | null) => !!id && !!target.conversationId
    && resolveConversation(id) === resolveConversation(target.conversationId);
  const samePath = (value: string | null) => !!value && !!target.agentPath && value === target.agentPath;
  for (const pipeline of pipelines) {
    const publication = pipeline.delivery?.operation;
    const result = publication?.result;
    const publishing = (publication !== undefined && (publication.state !== "settled" || !result
      || (result.ok !== true && result.ok !== false)
      || (result.ok === false && typeof result.error !== "string")
      || (result.ok === true && (typeof result.sha !== "string"
        || !["published", "unavailable"].includes(result.remote)
        || (result.uncertain !== undefined && result.uncertain !== false)))
      || (publication.executor !== undefined && publication.executor.finished !== true)))
      || pipeline.publicationAdmission?.state === "pending"
      || pipeline.remoteAction?.state === "pending"
      || pipeline.cursor?.state === "committing";
    if ((sameConversation(pipeline.srcConversationId) || samePath(pipeline.srcPath))
      && (publishing || !["completed", "closed"].includes(pipeline.state))) return true;
    for (const run of pipeline.runs) for (const attempt of run.attempts) {
      const matches = sameConversation(attempt.conversationId) || samePath(attempt.agentPath)
        || (!!target.paneId && attempt.paneId === target.paneId)
        || (!!target.launchId && attempt.launchId === target.launchId)
        || (!!target.sessionId && attempt.sessionId === target.sessionId);
      if (!matches) continue;
      // Completion stamps can survive a restart/resume. A running owner still
      // holds the host, even with an older verdict on the same attempt.
      if (publishing || ["pending", "spawning", "running", "reviewing", "committing"].includes(attempt.state)
        || !(attempt.verdict || attempt.completedAt)
        || (attempt.activation && attempt.activation.phase !== "settled")) return true;
    }
  }
  return false;
}
