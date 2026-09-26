import { roleNameById } from "@/components/builderCopy";
import { blockAgeSeconds } from "@/components/pipelines/pipelineBlockModel";
import { stageCardLabel, stageLatestAttemptPlace } from "@/components/pipelines/pipelineModel";
import { humanizeDuration } from "@/components/turnDuration";
import type { DismissedBy } from "@/lib/attention/dismissalTypes";
import type { TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { attentionReason, type ConversationReason } from "../attention";
import type { NeedReason } from "./needReason";

/**
 * The ONE line every attention surface shows for a waiting agent (issue #1167).
 *
 * The dock badge, the toast and the island popover all answer the same
 * question — «what do you owe this agent?» — and each used to answer it in its
 * own words: the toast said «Agent is waiting for a reply» and named no
 * decision at all, while the popover derived a snippet of its own. Three
 * parallel strings over one signal is how a toast and a badge start describing
 * different things, so the derivation lives here once and every surface reads
 * it.
 *
 * `attentionReason` is the eligibility authority, and this module CALLS it
 * rather than re-deciding: a conversation the queue does not count, including
 * one whose reason the operator dismissed, is a conversation this line refuses
 * to name. Without that gate a toast left up over a settled session announced
 * a wait while the popover behind it held no such row, which is the
 * one-signal-two-descriptions defect this issue exists to remove.
 */

/** The role a pipeline stage records when its stage carries no role at all
    (`engine.ts` writes `roleId ?? "agent"`). It is the ABSENCE of a role
    spelled as a word, so it attributes nothing and never reaches the line. */
const UNNAMED_ROLE = "agent";

/**
 * Who is waiting, when the conversation's evidence names a role.
 *
 * The same fail-open ladder the registry walks in `conversationAgentRole`: the
 * conversation's own role first (`durableLineage.role` already collapses the
 * launch receipt's `agentRole` and the durable spawn edge behind it), then its
 * newest container membership — the read model keeps memberships in the order
 * the registry appended them, so the last row is the newest. A stage slot is
 * real evidence of the job an agent was given; dropping it left a pipeline
 * builder's question attributed to nobody.
 */
function roleLabel(t: TFunction, file: FileEntry): string | null {
  const lineage = file.durableLineage;
  const seat = lineage?.memberships.findLast((membership) => {
    const named = membership.role.trim();
    return named !== "" && named !== UNNAMED_ROLE;
  });
  const role = lineage?.role?.trim() || seat?.role.trim();
  return role ? roleNameById(t, role) : null;
}

/**
 * The wait itself, from a FIXED vocabulary — the agent's own question header,
 * or one of the localized phrases.
 *
 * Nothing is lifted out of a question body or off a scraped screen: a line
 * assembled from whatever the terminal happened to be drawing names the OPTIONS
 * rather than the decision, and it is what put «❯ 1. Yes» in front of the
 * operator as the name of a wait.
 */
function decisionText(t: TFunction, reason: ConversationReason): string {
  switch (reason.kind) {
    /* An orchestrator's open bridge ask (issue #1168) is the one wait on this
       board that was ESCALATED rather than inferred. */
    case "decision":
      return t("status.awaitingDecision");
    case "plan":
      return t("attention.decisionPlan");
    /* Never the question BODY: it is a paragraph written to be read inside the
       conversation, and it truncates into nonsense on a badge. */
    case "question":
      return reason.header || t("attention.decisionQuestion");
    /* A structured request names its tool, command and reason (#2215); the
       screen-scrape fallback has only the generic phrase. */
    case "permission":
      return reason.header ? t("attention.decisionPermissionNamed", { request: reason.header }) : t("attention.decisionPermission");
    case "delivery":
      return t("attention.decisionDelivery");
    /* The launch's own error is the decision: it names the account to sign
       back in on (#2170). */
    case "launch":
      return reason.header ? t("attention.decisionLaunchReason", { reason: reason.header }) : t("attention.decisionLaunch");
    /* The agent's own sentence, as it asked it. */
    case "ask":
      return reason.header ? t("attention.decisionAskNamed", { ask: reason.header }) : t("needs.ask");
  }
}

/**
 * The line of one needs-you row: the wait in the same fixed words, without the
 * role, which the row names with its own mark. An orchestrator's question in
 * the report log reads «Question»; its text is the row's title.
 */
export function reasonLine(t: TFunction, reason: ConversationReason): string {
  return reason.report ? t("attention.reportQuestion") : decisionText(t, reason);
}

/**
 * The decision a conversation owes the operator, plus its role when the
 * evidence names one — or null when the queue counts no wait here at all.
 *
 * A surface holding a stale target (a toast still up after its question was
 * answered elsewhere, a reason the operator dismissed) falls back to its own
 * generic wording rather than inventing a decision. `now` is epoch SECONDS and
 * defaults to the wall clock, exactly as `attentionId` does.
 */
export function decisionLine(t: TFunction, file: FileEntry, now: number = Date.now() / 1000): string | null {
  const reason = attentionReason(file, now);
  if (!reason || reason.dismissal) return null;
  const decision = decisionText(t, reason);
  const role = roleLabel(t, file);
  return role ? `${decision} · ${role}` : decision;
}

/**
 * Why a card needs the operator, as one short label (docs/design/needs-attention.md
 * §4): the desktop card's foot, the phone card's badge and a member tile's
 * title all read this one function, so the two boards name a reason the same
 * way. A conversation's reason carries its role when the evidence names one;
 * a lane's carries the stage it stopped on.
 */
export function needLabel(t: TFunction, need: NeedReason): string {
  if (need.subject === "pipeline") {
    if (need.kind === "lane-merge") return t("needs.laneMerge");
    const stage = laneStageName(t, need.pipeline, need.stageId);
    const key = need.kind === "lane-review" ? "needs.laneReview" : "needs.laneDecision";
    return stage ? t(`${key}Stage`, { stage }) : t(key);
  }
  const text = conversationNeedText(t, need.reason);
  const role = roleLabel(t, need.file);
  return role ? `${text} · ${role}` : text;
}

/** A conversation reason in the card's words: shorter than the toast's line. */
export function conversationNeedText(t: TFunction, reason: Pick<ConversationReason, "kind" | "header">): string {
  switch (reason.kind) {
    case "decision":
      return t("mobile2.board.badgeDecision");
    case "plan":
      return t("mobile2.board.badgePlan");
    case "question":
      return reason.header || t("mobile2.board.badgeQuestion");
    case "permission":
      return reason.header ? t("attention.decisionPermissionNamed", { request: reason.header }) : t("attention.decisionPermission");
    case "delivery":
      return t("needs.delivery");
    case "launch":
      return t("needs.launch");
    case "ask":
      return t("needs.ask");
  }
}

/** The stage a lane waits on, in the operator's words: the cursor's, or the
    review stage a needs_review lane stands on (#1938). */
function laneStageName(t: TFunction, pipeline: Pipeline, stageId: string | null): string {
  const stage = stageId ? pipeline.stages.find((entry) => entry.id === stageId) : null;
  return stage ? stageCardLabel(t, stage, stageLatestAttemptPlace(pipeline, stage.id)).toLocaleLowerCase() : "";
}

/** The cleared line both cards draw: who cleared it and how long ago, on the
    board's own clock (epoch seconds), «just now» under a minute. */
export function clearedLine(t: TFunction, cleared: { at: number; by: DismissedBy }, now: number): string {
  const seconds = now - cleared.at;
  const age = seconds < 60 ? t("kanban.justNow") : humanizeDuration(blockAgeSeconds(seconds));
  return t("needs.cleared", { who: clearedByText(t, cleared.by), age });
}

/** Who cleared a card, in the card's words: «you» for the operator, the
    orchestrator, the operator's own root session, else the agent's role. */
export function clearedByText(t: TFunction, by: DismissedBy): string {
  if (by.kind === "operator") return t("needs.clearedByYou");
  if (by.kind === "manager") return t("needs.clearedByOrchestrator");
  if (by.kind === "gateway") return t("needs.clearedByGateway");
  const role = by.role?.trim();
  return role ? roleNameById(t, role) : t("needs.clearedByAgent");
}
