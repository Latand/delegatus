import { createHash } from "node:crypto";
import { agentRegistry, type DeliveryOperationOwner } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { statePath } from "@/lib/configDir";
import { readSelf } from "@/lib/links/self";
import { seatMessageKeys } from "@/lib/orchestrator/seatDeliveryKeys";
import { orchestratorSeatFor, previousOrchestratorSeats } from "@/lib/orchestrator/seats";
import { canonicalProject } from "@/lib/projects/aliases";
import { findSeatRound } from "@/lib/prototypeReview/seatRounds";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";
import { sharedStateReadonlyDatabase } from "@/lib/state/sqliteStateStore";
import { databaseFileIdentity } from "@/lib/state/currentDatabase";
import { loadPrototypeTask } from "@/lib/tasks/store";
import { hardenedRedact } from "@/lib/view/compactText";
import { crossProjectRoleScope } from "../roleScopes";
import { projectScope, roleMemoryCollection } from "../roleStore";
import type { DecisionAuthor, DecisionRuleSource } from "../roleTypes";

export const DECISION_BATCH_LIMIT = 50;
export const LEGATUS_SCOPE = crossProjectRoleScope("legatus");

type EvidenceLocation = { reviewId: string; taskId: string | null } | { messageRef: string };
export type DecisionEvidenceRef = EvidenceLocation & { id: string; project: string; at: string };
type Evidence = { ref: DecisionEvidenceRef; rank: number; text: string[]; context: string[]; voice?: true };

function reference(location: EvidenceLocation, project: string, at: string, version: unknown): DecisionEvidenceRef {
  const id = createHash("sha256").update(JSON.stringify([location, at, version])).digest("hex").slice(0, 16);
  return { ...location, id: `r_${id}`, project: canonicalProject(project), at };
}

function legatusProject(): string | null {
  const self = readSelf();
  return self ? `legatus:${self.installId}` : null;
}

export function activeLegatusProject(): string | null {
  const project = legatusProject();
  return project && orchestratorSeatFor(project).active?.conversationId ? project : null;
}

function formEvidence(round: PrototypeReviewRound): Evidence | null {
  const decision = round.decision;
  const actor = decision?.decidedBy?.kind;
  if (!decision || (actor !== "operator" && actor !== "member")) return null;
  const answers = decision.answers ?? [];
  const text = [decision.comment, ...answers.map(answer => answer.customText), decision.originalReply]
    .filter((value): value is string => typeof value === "string" && !!value.trim());
  const context = [round.title];
  let deviates = !!decision.rejected || !!decision.chosen.length;
  for (const question of round.questions ?? []) {
    const answer = answers.find(item => item.questionId === question.id);
    if (!answer) continue;
    const selected = answer.options.flatMap(index => question.options[index] ? [question.options[index]] : []);
    deviates ||= !!answer.other || selected.some(option => !option.recommended);
    const labels = selected.map(option => option.label).join(", ");
    context.push(`${question.text} → ${answer.skipped ? "Skipped" : labels}`);
  }
  for (const variant of round.variants) if (decision.chosen.includes(variant.number)) context.push(variant.name);
  if (decision.rejected) context.push("All variants rejected");
  return {
    ref: reference({ reviewId: round.id, taskId: round.taskId }, round.project, decision.at,
      [decision.revision, decision.decidedBy, text, decision.chosen, answers, decision.rejected]),
    rank: text.length ? 0 : deviates ? 1 : 2, text, context,
  };
}

/** Only server-stamped, delivered submissions count. Form deliveries and seat
 * setup are generated messages, so they have their own evidence path. */
function messageEvidence(owner: DeliveryOperationOwner, project: string): Evidence | null {
  const origin = owner.command.origin;
  const key = owner.clientMessageId;
  if (origin?.kind !== "operator" || owner.terminalState !== "delivered" || !owner.settledAt
    || !owner.evidenceText?.trim() || !key || key.startsWith(seatMessageKeys.decision) || /^(?:spawn_|orchmandate_)/.test(key)
    || owner.command.operationId.startsWith("spawn_message_")) return null;
  const voice = origin.channel === "voice-delegatus";
  return {
    ref: reference({ messageRef: owner.command.operationId }, project, owner.settledAt, [owner.conversationId, origin, owner.evidenceText]),
    rank: voice ? 1 : 0, text: [owner.evidenceText], context: [], ...(voice ? { voice: true } : {}),
  };
}

/** Read text only from the current local review rows. Replicas have no
 * server-attributed actor and cannot enter this query. SQL caps the rows before
 * any round bodies enter JavaScript, including on a catch-up pass. */
function recentForms(after: string, through: string): Evidence[] {
  const filename = statePath("state.sqlite");
  if (!databaseFileIdentity(filename)) return [];
  const db = sharedStateReadonlyDatabase(filename);
  const rows = db.query<{ body: string }, [string, string, number]>(`
    WITH rounds(body) AS (
      SELECT value_json FROM state_rows WHERE collection='seat-decisions'
      UNION ALL
      SELECT json_set(round.value, '$.project', json_extract(task.value_json, '$.project'),
        '$.taskId', json_extract(task.value_json, '$.id'))
      FROM state_rows task CROSS JOIN json_each(task.value_json, '$.prototypeReviews') round
      WHERE task.collection='tasks' AND task.row_key >= 't:' AND task.row_key < 't;'
    ), answered AS (
      SELECT body, json_extract(body, '$.decision.at') AS at,
        CASE
          WHEN trim(coalesce(json_extract(body, '$.decision.comment'), '')) <> ''
            OR trim(coalesce(json_extract(body, '$.decision.originalReply'), '')) <> ''
            OR EXISTS (SELECT 1 FROM json_each(body, '$.decision.answers') answer
              WHERE trim(coalesce(json_extract(answer.value, '$.customText'), '')) <> '') THEN 0
          WHEN json_extract(body, '$.decision.rejected') = 1
            OR json_array_length(body, '$.decision.chosen') > 0
            OR EXISTS (SELECT 1 FROM json_each(body, '$.decision.answers') answer
              WHERE json_extract(answer.value, '$.other') = 1)
            OR EXISTS (SELECT 1 FROM json_each(body, '$.decision.answers') answer
              CROSS JOIN json_each(body, '$.questions') question
              CROSS JOIN json_each(answer.value, '$.options') selected
              WHERE json_extract(answer.value, '$.questionId') = json_extract(question.value, '$.id')
                AND coalesce(json_extract(question.value, '$.options[' || max(0, CAST(selected.value AS INTEGER)) || '].recommended'), 0) = 0)
            THEN 1
          ELSE 2
        END AS priority
      FROM rounds
      WHERE json_extract(body, '$.decision.decidedBy.kind') IN ('operator', 'member')
    )
    SELECT body FROM answered WHERE at > ? AND at <= ?
      ORDER BY priority, at DESC, json_extract(body, '$.id') LIMIT ?
  `).all(after, through, DECISION_BATCH_LIMIT);
  return rows.flatMap(({ body }) => {
    const evidence = formEvidence(JSON.parse(body) as PrototypeReviewRound);
    return evidence ? [evidence] : [];
  });
}

function recentMessages(project: string, after: string, through: string): Evidence[] {
  const seat = orchestratorSeatFor(project).active;
  const former = previousOrchestratorSeats(project).filter(item => item.heldTo > after);
  const recipients = [
    ...(seat?.conversationId ? [{ conversationId: seat.conversationId, heldFrom: seat.designatedAt, heldTo: null }] : []),
    ...former,
  ];
  const seen = new Set<string>();
  return recipients.flatMap(({ conversationId, heldFrom, heldTo }) =>
    agentRegistry().recentTerminalDeliveryOwners(conversationId as ViewerConversationId).flatMap(owner => {
      const evidence = messageEvidence(owner, project);
      if (!evidence || evidence.ref.at <= after || evidence.ref.at > through
        || (heldFrom && owner.createdAt < heldFrom) || (heldTo && owner.createdAt > heldTo)) return [];
      const key = owner.deliveryId;
      if (seen.has(key)) return [];
      seen.add(key);
      return [evidence];
    }));
}

export function selectDecisionEvidence(after: string, through: string): DecisionEvidenceRef[] {
  const project = legatusProject();
  const rules = roleMemoryCollection();
  return [...recentForms(after, through), ...(project ? recentMessages(project, after, through) : [])]
    .sort((a, b) => a.rank - b.rank || b.ref.at.localeCompare(a.ref.at) || a.ref.id.localeCompare(b.ref.id))
    .filter(({ ref }) => !rules?.get(`r:${ref.id}`))
    .slice(0, DECISION_BATCH_LIMIT).map(({ ref }) => ref);
}

export function evidenceScopes(refs: readonly DecisionEvidenceRef[]): string[] {
  return refs.flatMap(ref => "reviewId" in ref ? [projectScope(ref.project)] : []);
}

function currentEvidence(ref: DecisionEvidenceRef): Evidence | null {
  let evidence: Evidence | null;
  if ("reviewId" in ref) {
    const task = ref.taskId === null ? null : loadPrototypeTask(ref.taskId);
    const ownedRound = task?.prototypeReviews?.find(round => round.id === ref.reviewId);
    const round = ref.taskId === null ? findSeatRound(ref.reviewId)
      : task && ownedRound ? { ...ownedRound, project: task.project, taskId: task.id } : null;
    evidence = round ? formEvidence(round) : null;
  } else {
    const owner = agentRegistry().deliverySnapshotForOperation(ref.messageRef).deliveryOperationOwners[ref.messageRef];
    evidence = owner ? messageEvidence(owner, ref.project) : null;
  }
  return evidence?.ref.id === ref.id && evidence.ref.project === canonicalProject(ref.project) ? evidence : null;
}

export function readDecisionEvidence(ref: DecisionEvidenceRef) {
  const evidence = currentEvidence(ref);
  if (!evidence) return null;
  const bounded = (text: string) => hardenedRedact(text).slice(0, 800);
  return {
    id: ref.id, project: evidence.ref.project, at: ref.at, kind: "reviewId" in ref ? "form" : "message",
    ...(evidence.voice ? { channel: "voice" } : {}),
    text: evidence.text.slice(0, 10).map(bounded), context: bounded(evidence.context.join("\n")),
  };
}

export function decisionRuleSource(ref: DecisionEvidenceRef, quote?: string): DecisionRuleSource | null {
  const evidence = currentEvidence(ref);
  if (!evidence) return null;
  const author: DecisionAuthor = evidence.voice ? "voice"
    : quote?.trim() && evidence.text.some(text => text.includes(quote)) ? "typed" : "clicked";
  return {
    origin: "decision", roleId: null, fixRound: false, project: evidence.ref.project, author,
    ...("reviewId" in ref ? { reviewId: ref.reviewId } : { messageRef: ref.messageRef }),
  };
}
