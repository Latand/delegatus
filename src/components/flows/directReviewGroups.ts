import type { Flow as ArchivedReview } from "@/lib/reviewHistory/types";
import type { DirectReviewGroup } from "./reviewGroup";
import type { ReviewGroup as Flow } from "@/components/flows/reviewGroup";
import type { Round } from "@/lib/flows/types";
import { groupDirectReviewers } from "@/lib/review/directReviewGrouping";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { conversationFileIndex, withoutArchivedPredecessors } from "@/lib/accounts/identity";

import { projectKey } from "@/components/projectModel";
import { collapseContext, collapseExempt, conversationSettled, workerCollapseIdleMs } from "@/components/scheme/workerCollapse";

import { isActiveFlow } from "./flowModel";

/** Independent reviewers share a read-only deck. Membership and ordering come
 * from durable task/subject identity, including aliases and transcript generations.
 * The prefix remains stable for existing disclosure preferences and board keys. */
export const DIRECT_REVIEW_FLOW_PREFIX = "direct-review::";

export function isDirectReviewFlow(flow: Pick<Flow, "id">): boolean {
  return flow.id.startsWith(DIRECT_REVIEW_FLOW_PREFIX);
}

/**
 * Split direct review groups into the ones that still carry an unfinished
 * latest round (they place a deck + loop beside the reviewed conversation)
 * and terminal HISTORY groups — every round ended with a verdict or an aged
 * failure. Since #289 + #325 a terminal group is still a board citizen: it
 * places its deck (rendered collapsed to the verdict chip by default)
 * whenever its reviewed anchor is on the board for its own reasons, and
 * otherwise parks as a compact per-group worker stack (the review-history
 * stack) without ever forcing the quiet anchor back onto the board. Both
 * halves keep claiming their reviewers, so a folded round never resurfaces
 * as a standalone card.
 */
export function splitDirectReviewGroups(groups: readonly Flow[]): { active: Flow[]; history: Flow[] } {
  const active: Flow[] = [];
  const history: Flow[] = [];
  for (const group of groups) (group.state === "reviewing" ? active : history).push(group);
  return { active, history };
}

export interface DirectReviewGroupsInput {
  files: readonly FileEntry[];
  /** Real (server) flows — used only to exclude reviewers they already claim. */
  flows: readonly Flow[];
  tasks?: readonly BoardTask[];
  /** Durable registry alias map (old id → canonical id). */
  conversationAliases?: Readonly<Record<string, string>>;
  /** Wall clock for the failed-round freshness horizon; defaults to Date.now(). */
  nowMs?: number;
  /** Freshness horizon override (tests); null disables age-only settlement. */
  idleMs?: number | null;
  /** Inputs consumed by the board's shared expansion predicate. */
  pipelines?: Parameters<typeof collapseContext>[0]["pipelines"];
  pinnedPaths?: ReadonlySet<string>;
  protectedPaths?: ReadonlySet<string>;
  activeDeliveryConversationIds?: ReadonlySet<string>;
  /** Durable "last opened" stamps, so a held finished outcome reads the same
      here as it does on the board (#1244). */
  seenAt?: ReadonlyMap<string, number>;
}

const EMPTY_PATHS: ReadonlySet<string> = new Set();

export function directReviewFlows(input: DirectReviewGroupsInput): DirectReviewGroup[] {
  const groups = groupDirectReviewers({ ...input, flows: input.flows.filter((group): group is ArchivedReview =>
    group.template === "implement-review-loop" && typeof group.baseRef === "string" && group.mode !== undefined && group.baseMode !== undefined
    && group.reviewerMode !== undefined && group.roundLimit !== undefined) });
  if (!groups.length) return [];
  const visible = withoutArchivedPredecessors([...input.files]);
  const nowMs = input.nowMs ?? Date.now();
  const idleMs = input.idleMs === undefined ? workerCollapseIdleMs() : input.idleMs;
  const expansionContext = collapseContext({
    files: visible,
    flows: input.flows,
    pipelines: input.pipelines,
    pinnedPaths: input.pinnedPaths ?? EMPTY_PATHS,
    protectedPaths: input.protectedPaths,
    activeDeliveryConversationIds: input.activeDeliveryConversationIds,
    seenAt: input.seenAt,
  });

  /* Both per-group lookups below are answered from one pass over their inputs:
     the projection runs for every group on every board update, and scanning the
     whole file corpus and flows list per group is quadratic in a project with
     hundreds of each (#1546). `conversationFileIndex` resolves a conversation
     to its current generation by the same first-match, archived-and-placeholder
     ranking `currentConversationFile` applies. */
  const byConversation = conversationFileIndex(visible).currentByConversation;
  const activeImplementerPaths = new Set<string>();
  for (const flow of input.flows) if (isActiveFlow(flow)) activeImplementerPaths.add(flow.implementerPath);

  const out: DirectReviewGroup[] = [];
  for (const { key, members } of groups) {
    const latest = members[members.length - 1]!;
    /* The deck anchors beside the reviewed conversation of the newest round,
       at its CURRENT generation. No anchor in the scan → nothing to attach the
       deck to; the reviewers keep today's worker-stack behavior. */
    const anchor = byConversation.get(latest.reviewedId) ?? null;
    if (!anchor) continue;
    /* Existing flow ownership wins (#112): one node hosts one deck, and an
       active managed loop on the reviewed conversation must keep its deck and
       controls. The direct reviewers then keep today's worker-stack behavior. */
    if (activeImplementerPaths.has(anchor.path)) continue;
    const rounds = members.map<Round>((member, index) => {
      const { file } = member;
      const outcome = file.review ?? null;
      /* Direct reviewers share the board's exemptions — live work, delivery,
         input, pin — so protected reviewers are never called failed. What the
         board no longer decides for them is the effect of silence: since #1244
         a quiet unfinished card STAYS on the board, while a reviewer silent
         past this projection's own freshness horizon has stopped without
         reviewing, and the round record has to say so. */
      const quietPastHorizon = idleMs !== null && nowMs - file.mtime * 1000 >= idleMs;
      const failed = !outcome
        && !collapseExempt(file, expansionContext)
        && (conversationSettled(file, expansionContext) || quietPastHorizon);
      return {
        n: index + 1,
        reviewerPath: file.path,
        reviewerConversationId: file.conversationId ?? null,
        findingsPath: null,
        triggeredBy: "button",
        readyNote: null,
        verdict: outcome?.verdict ?? null,
        findingsCount: outcome?.findingsCount ?? null,
        startedAt: new Date(file.mtime * 1000).toISOString(),
        reviewedAt: outcome?.observedAt ?? null,
        terminalAt: outcome?.observedAt ?? null,
        relayedAt: null,
        error: failed ? "no verdict" : null,
      };
    });
    const last = rounds[rounds.length - 1]!;
    const reviewerRole = {
      engine: (latest.file.engine === "codex" ? "codex" : "claude") as "claude" | "codex",
      model: latest.file.model,
      effort: latest.file.effort ?? null,
    };
    out.push({
      id: DIRECT_REVIEW_FLOW_PREFIX + key,
      kind: "direct-review",
      project: projectKey(anchor),
      cwd: anchor.cwd ?? "",
      implementerPath: anchor.path,
      implementerConversationId: anchor.conversationId ?? null,
      roles: {
        implementer: { engine: (anchor.engine === "codex" ? "codex" : "claude") as "claude" | "codex", model: anchor.model, effort: anchor.effort ?? null },
        reviewer: reviewerRole,
      },
      /* An unfinished latest round is visible. Verdict, terminal evidence,
         or W-idle settlement parks the group as compact history. */
      state: last.verdict === null && last.error === null ? "reviewing" : "done_comment",
      stateDetail: null,
      rounds,
      createdAt: rounds[0]!.startedAt,
      closedAt: null,
    });
  }
  /* Deterministic output order: stable group key. */
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
