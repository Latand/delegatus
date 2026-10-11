import { attentionReason } from "@/components/attention";
import { withoutArchivedPredecessors } from "@/lib/accounts/identity";
import type { SeatTickWorkerAskInput } from "@/lib/monitor/types";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import type { Pipeline } from "@/lib/pipelines/types";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { laneNeedKind, laneRouteNow } from "./routeTypes";

/*
 * The seat's half of routing (docs/design/attention-auto-resolve.md,
 * «Implementation plan for acceptance 3»): every wait the projection routed to
 * a project's seat, as one line the seat tick puts on the wake. Each line says
 * who asked, what they asked in their own words, and the tool that answers it
 * where it asked, so the answer goes back to the asking conversation or lane;
 * and how to hand it to the operator when only they can decide.
 */

const LABEL_MAX = 700;
const QUESTION_MAX = 360;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

function conversationLine(file: FileEntry, reason: NonNullable<ReturnType<typeof attentionReason>>): string {
  const who = file.durableLineage?.role?.trim() || "agent";
  const title = clip(cleanTitle(file.title ?? "", 90) || who, 90);
  const id = file.conversationId ?? file.path;
  const escalate = `if only the operator can decide, ask them with publish_prototype_review, then dismiss_attention escalate {reviewId} with target {kind:"conversation", conversationId:"${id}", reasonId:"${reason.id}"}`;
  switch (reason.kind) {
    case "memory":
      return `${title} — ${who} was killed out of memory${reason.header ? ` (${clip(reason.header, 80)})` : ""}; resume it or close its work with conversation_action; ${escalate}`;
    case "permission":
      return `${title} — ${who} waits on a tool permission request${reason.header ? `: ${clip(reason.header, QUESTION_MAX)}` : ""}; answer it with conversation_action permission; ${escalate}`;
    default:
      return `${title} — ${who} asks: «${clip(reason.header || "see its last message", QUESTION_MAX)}»; reply with send_message to ${id}, which reaches that conversation; ${escalate}`;
  }
}

/** A parked lane's question in the stage's own words. */
function laneQuestion(pipeline: Pipeline): string {
  const stageId = pipeline.cursor?.stageId;
  const attempt = stageId ? pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) : undefined;
  const summary = attempt?.report?.verdict.status === "needs_decision" ? attempt.report.summary?.trim() : null;
  return summary ? `«${clip(summary, QUESTION_MAX)}»` : `stopped: ${clip(pipeline.stateDetail ?? "no reason recorded", QUESTION_MAX)}`;
}

function laneLine(pipeline: Pipeline): string {
  const title = clip(pipeline.task || pipeline.id, 90);
  const stage = pipeline.cursor?.stageId ? ` stage ${pipeline.cursor.stageId}` : "";
  const escalate = `if only the operator can decide, ask them with publish_prototype_review, then dismiss_attention escalate {reviewId} with target {kind:"pipeline", pipelineId:"${pipeline.id}"}`;
  switch (laneNeedKind(pipeline)) {
    case "lane-merge":
      return `${title} — completed, its merge stopped: ${clip(pipeline.merge?.reason ?? "no reason recorded", QUESTION_MAX)}; repair it and pipeline_action retry-merge; ${escalate}`;
    case "lane-review":
      return `${title} —${stage} review budget spent, the last fix was not re-reviewed; pipeline_action accept-head once it holds; ${escalate}`;
    default:
      return `${title} —${stage} asks ${laneQuestion(pipeline)}; answer with pipeline_action resolve-decision (expectedRevision from get_pipeline), or retry-stage for a mechanical stop; ${escalate}`;
  }
}

/** Every wait the projection routed to this canonical project's seat, oldest
    conversation first, then the lanes. */
export function seatAgendaAsks(body: { files: readonly FileEntry[]; pipelines: readonly Pipeline[] }, now: number, project: string): SeatTickWorkerAskInput[] {
  const canonical = canonicalOrchestratorProject(project);
  const asks: (SeatTickWorkerAskInput & { since: number })[] = [];
  for (const file of withoutArchivedPredecessors([...body.files])) {
    if (canonicalOrchestratorProject(file.project) !== canonical) continue;
    const reason = attentionReason(file, now);
    if (!reason || reason.dismissal || reason.route?.owner !== "seat") continue;
    asks.push({ key: reason.route.key, id: file.conversationId ?? file.path, label: clip(conversationLine(file, reason), LABEL_MAX), since: reason.since });
  }
  asks.sort((a, b) => a.since - b.since);
  const lanes = body.pipelines
    .filter((pipeline) => canonicalOrchestratorProject(pipeline.project) === canonical)
    .flatMap((pipeline) => {
      const route = laneRouteNow(pipeline);
      return route?.owner === "seat" ? [{ key: route.key, id: pipeline.id, label: clip(laneLine(pipeline), LABEL_MAX) }] : [];
    });
  return [...asks.map((ask) => ({ key: ask.key, id: ask.id, label: ask.label })), ...lanes];
}
