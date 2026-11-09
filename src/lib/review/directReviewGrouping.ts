import { canonicalizeConversationId, withoutArchivedPredecessors } from "@/lib/accounts/identity";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { Flow } from "@/lib/reviewHistory/types";

/*
 * The shared grouping core of issue #325: which direct one-shot reviewers
 * belong together, keyed by durable identity. Two projections consume it —
 * the board's synthetic review-deck flows (components/flows/directReviewGroups)
 * and the server's role-title overlay (lib/session/roleTitles) — so round
 * numbering and task/subject keying can never drift between the deck a
 * reviewer renders in and the title it carries.
 *
 * Group identity, in the issue's precedence order:
 *   1. a shared board task, resolved from the reviewer's own assignment first
 *      and the reviewed conversation's assignment second;
 *   2. the alias-resolved `reviewsConversationId` review subject;
 *   3. managed flow/pipeline ownership stays with #112's machinery — any
 *      conversation carrying a container membership (or claimed by a real
 *      flow round) never enters this projection.
 */

/** Reviewer transcripts already claimed by a flow's round decks. Mirrors
    `claimedReviewerPaths` in components/flows/flowModel for server-safe use. */
export function claimedReviewerRoundPaths(flows: readonly Flow[]): Set<string> {
  const set = new Set<string>();
  for (const flow of flows) {
    for (const round of flow.rounds) {
      if (round.reviewerPath) set.add(round.reviewerPath);
    }
  }
  return set;
}

/** The board task owning a conversation: the task with the NEWEST matching
    assignment wins, so a re-assigned conversation follows its latest task.
    Callers use one immutable task snapshot for a projection. Index its
    assignments once instead of rescanning every task for each title. */
export function taskOwnerResolver(
  tasks: readonly BoardTask[],
): (conversationId: string | null, path: string | null) => BoardTask | null {
  type Match = { task: BoardTask; at: string; order: number };
  const byConversation = new Map<string, Match>();
  const byPath = new Map<string, Match>();
  const preferred = (left: Match | undefined, right: Match | undefined): Match | undefined => {
    if (!left) return right;
    if (!right) return left;
    // Evaluate equal timestamps in task order, as the original traversal did.
    const [first, second] = left.order <= right.order ? [left, right] : [right, left];
    return second.at > first.at || (second.at === first.at && second.task.updatedAt > first.task.updatedAt)
      ? second : first;
  };
  tasks.forEach((task, order) => {
    for (const assignment of task.assignments) {
      const match = { task, at: assignment.at, order };
      if (typeof assignment.conversationId === "string") {
        byConversation.set(assignment.conversationId, preferred(byConversation.get(assignment.conversationId), match)!);
      }
      if (typeof assignment.path === "string") byPath.set(assignment.path, preferred(byPath.get(assignment.path), match)!);
    }
  });
  return (conversationId, path) => {
    if (!conversationId && !path) return null;
    return preferred(byConversation.get(conversationId ?? ""), path === null ? undefined : byPath.get(path))?.task ?? null;
  };
}

export interface DirectReviewCandidate {
  file: FileEntry;
  /** Alias-canonical reviewed conversation id. */
  reviewedId: string;
}

export interface DirectReviewGroup {
  /** `task::<taskId>` or `subject::<canonical reviewed id>`. */
  key: string;
  /** The owning board task when the key is task-scoped. */
  task: BoardTask | null;
  /** Rounds in transcript age order — history first, the actionable round last. */
  members: DirectReviewCandidate[];
}

export interface DirectReviewGroupingInput {
  files: readonly FileEntry[];
  /** Real (server) flows — used only to exclude reviewers they already claim. */
  flows: readonly Flow[];
  tasks?: readonly BoardTask[];
  /** Durable registry alias map (old id → canonical id). */
  conversationAliases?: Readonly<Record<string, string>>;
}

/**
 * Groups every direct one-shot reviewer (durable `role=reviewer` +
 * `reviewsConversationId`, no flow/pipeline membership) by task or review
 * subject. Pure over the scan + tasks + alias map — restart, migration,
 * generation changes and project relocation follow the durable registry data.
 * Distinct task IDs always produce distinct groups; a delayed assignment
 * re-keys the group with no lost rounds.
 */
export function groupDirectReviewers(input: DirectReviewGroupingInput): DirectReviewGroup[] {
  const aliases = input.conversationAliases ?? {};
  const canonical = (id: string) => canonicalizeConversationId(id, aliases);
  const visible = withoutArchivedPredecessors([...input.files]);
  const claimed = claimedReviewerRoundPaths(input.flows);
  const taskFor = taskOwnerResolver(input.tasks ?? []);

  const groups = new Map<string, DirectReviewGroup>();
  for (const file of visible) {
    const lineage = file.durableLineage;
    if (!lineage || lineage.role !== "reviewer" || !lineage.reviewsConversationId) continue;
    /* Managed ownership wins (#112): container members and round-claimed paths
       stay with their flow/pipeline projection. */
    if (lineage.memberships.length || claimed.has(file.path)) continue;
    const reviewedId = canonical(lineage.reviewsConversationId);
    const reviewerId = file.conversationId ? canonical(file.conversationId) : null;
    if (reviewerId !== null && reviewerId === reviewedId) continue; // degenerate self-review edge
    const owner = taskFor(reviewerId, file.path) ?? taskFor(reviewedId, null);
    const key = owner ? `task::${owner.id}` : `subject::${reviewedId}`;
    const candidate: DirectReviewCandidate = { file, reviewedId };
    const group = groups.get(key);
    if (group) group.members.push(candidate);
    else groups.set(key, { key, task: owner, members: [candidate] });
  }

  for (const group of groups.values()) {
    /* Round order is transcript age: terminal history first, the freshest —
       the actionable round — last, exactly where the deck's front card looks. */
    group.members.sort((a, b) => a.file.mtime - b.file.mtime || (a.file.path < b.file.path ? -1 : 1));
  }
  /* Deterministic output order: stable group key. */
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
