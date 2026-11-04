import { mergeOnReviewSetting } from "@/lib/projects/settings";
import { workspacePrincipalAllows } from "@/lib/team/workspacePrincipal";
import { integrationScope, integrationRequirementRevision, INTEGRATION_STAGES } from "./integration";
import type { Pipeline } from "./types";

/** Shared by controller admission and the durable delivery's final dispatch. */
export function integrationAuthorityRefusal(pipeline: Pipeline, now: number, reconcilePublication = false): string | null {
  const integration = pipeline.merge?.integration;
  if (!integration || !pipeline.cursor || !INTEGRATION_STAGES.includes(pipeline.cursor.stageId as typeof INTEGRATION_STAGES[number])) return null;
  if (!reconcilePublication || pipeline.delivery?.operation?.state !== "running") {
    const policy = mergeOnReviewSetting(pipeline.project);
    if (pipeline.workspace && !workspacePrincipalAllows(pipeline.workspace, pipeline.project)
      || !policy.enabled || policy.changedAt !== integration.decisionRevision || integration.scope !== integrationScope(pipeline)
      || integration.requirementRevision !== integrationRequirementRevision(pipeline) || integration.ownerEpoch !== pipeline.delivery?.epoch) {
      return "integration requirements, policy or delivery authority changed; review before continuing";
    }
  }
  return now >= Date.parse(integration.deadline)
    ? "integration session deadline expired; reconcile the current attempt before retrying" : null;
}
