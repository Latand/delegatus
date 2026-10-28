import { isDirectGroup } from "@/components/flows/reviewGroup";
export { useEffectiveFlows } from "./useEffectiveFlows";

import { getLocale, type Locale, type TFunction, translate } from "@/lib/i18n";
import type { ReviewGroup as Flow } from "@/components/flows/reviewGroup";
import type { FlowRoleKey, FlowState, ReviewVerdict, Round } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import { conversationFileIndex, currentMemberPath, withoutArchivedPredecessors } from "@/lib/accounts/identity";

import { resolveTranscriptClaims, transcriptClaimResolver } from "@/components/transcriptClaims";

/** Compatibility event accepted from cached clients during archive refresh. */
export const FLOWS_CHANGED_EVENT = "llv:flows-changed";

/**
 * Canonicalizes a flow's member paths — the implementer anchor and each round's
 * raw reviewer path — to the transcripts currently hosting those conversations
 * (issues #325/#353). The deck, halo, folding, links and worker-stack grammars
 * all key off these raw paths; after an account migration rotates a member onto
 * a new transcript they stop matching, the deck never places, and reviewers
 * resurface as detached standalone cards. Identity-stable: untouched flows (the
 * common case) return the same references.
 */
export function resolveFlowMemberPaths(flows: Flow[], files: readonly FileEntry[]): Flow[] {
  const index = conversationFileIndex(files);
  let changedAny = false;
  const out = flows.map((flow) => {
    const implementerPath = currentMemberPath(flow.implementerPath, flow.implementerConversationId, files, index) ?? flow.implementerPath;
    let roundsChanged = false;
    const rounds = flow.rounds.map((round) => {
      /* Only rewrite a recorded path — a round whose reviewer hasn't attached
         yet keeps its null (the "once known" contract). */
      const reviewerPath = round.reviewerPath ? currentMemberPath(round.reviewerPath, round.reviewerConversationId, files, index) : round.reviewerPath;
      if (reviewerPath === round.reviewerPath) return round;
      roundsChanged = true;
      return { ...round, reviewerPath };
    });
    if (implementerPath === flow.implementerPath && !roundsChanged) return flow;
    changedAny = true;
    return { ...flow, implementerPath, ...(roundsChanged ? { rounds } : {}) };
  });
  return changedAny ? out : flows;
}

/** Flows that still occupy their implementer's node on the scheme. */
export function isActiveFlow(flow: Flow): boolean {
  return flow.state !== "closed" || flow.restored === true;
}

export function flowByImplementer(flows: Flow[]): Map<string, Flow> {
  const map = new Map<string, Flow>();
  for (const flow of flows) {
    if (!isActiveFlow(flow)) continue;
    /* One active flow per implementer; the newest wins if the server ever
       sends stale duplicates. */
    const prev = map.get(flow.implementerPath);
    if (!prev || flow.createdAt > prev.createdAt) map.set(flow.implementerPath, flow);
  }
  return map;
}

/**
 * Reviewer transcripts claimed by a round deck: they render inside the deck
 * and must never appear as standalone scheme nodes or switchboard noise.
 */
export function claimedReviewerPaths(flows: Flow[], files: readonly FileEntry[] = []): Set<string> {
  const set = new Set<string>();
  for (const flow of flows) {
    for (const round of flow.rounds) {
      for (const { path } of reviewerBindingTargetsForRound(flow, round, files)) set.add(path);
    }
  }
  return set;
}

/** Membership buckets preserve file order and every same-round retry. Keys
 * are nested instead of concatenated so arbitrary durable ids cannot collide. */
const reviewerStore = globalThis as typeof globalThis & { __llvReviewerIndexes?: WeakMap<readonly FileEntry[], Map<string, Map<number, FileEntry[]>>> };
const reviewerIndexes = reviewerStore.__llvReviewerIndexes ??= new WeakMap();
function reviewerMembers(flow: Flow, round: Round, files: readonly FileEntry[]): readonly FileEntry[] {
  let index = reviewerIndexes.get(files);
  if (!index) {
    index = new Map();
    for (const file of conversationFileIndex(files).visible) {
      const seen = new Set<string>();
      for (const membership of file.durableLineage?.memberships ?? []) {
        if (membership.kind !== "flow" || membership.role !== "reviewer" || membership.round == null) continue;
        const key = JSON.stringify([membership.containerId, membership.round]);
        if (seen.has(key)) continue;
        seen.add(key);
        let rounds = index.get(membership.containerId);
        if (!rounds) index.set(membership.containerId, rounds = new Map());
        const members = rounds.get(membership.round);
        if (members) members.push(file); else rounds.set(membership.round, [file]);
      }
    }
    reviewerIndexes.set(files, index);
  }
  return index.get(flow.id)?.get(round.n) ?? EMPTY_REVIEWERS;
}
const EMPTY_REVIEWERS: readonly FileEntry[] = [];

/** Resolve the current transcript generation for a durable review round. */
export function reviewerFileForRound(flow: Flow, round: Round, files: readonly FileEntry[]): FileEntry | null {
  const index = conversationFileIndex(files);
  const members = reviewerMembers(flow, round, files);
  if (round.reviewerBindingId) {
    const currentSlot = `reviewer:${round.n}:${round.reviewerBindingId}`;
    const byBinding = members.find((file) => file.durableLineage?.memberships.some((membership) =>
      membership.kind === "flow" && membership.containerId === flow.id
      && membership.role === "reviewer" && membership.round === round.n && membership.slot === currentSlot));
    if (byBinding) return byBinding.conversationId ? (index.currentByConversation.get(byBinding.conversationId) ?? byBinding) : byBinding;
  }
  if (round.reviewerConversationId) {
    const byConversation = index.currentByConversation.get(round.reviewerConversationId);
    if (byConversation) return byConversation;
  }
  if (members.length) return members[0]!;
  const byPath = round.reviewerPath ? (index.byPath.get(round.reviewerPath) ?? null) : null;
  return byPath?.conversationId ? (index.currentByConversation.get(byPath.conversationId) ?? byPath) : byPath;
}

/** Resolve every durable reviewer binding for one logical round, current last. */
export function reviewerFilesForRound(flow: Flow, round: Round, files: readonly FileEntry[]): FileEntry[] {
  const current = reviewerFileForRound(flow, round, files);
  const history = reviewerMembers(flow, round, files).filter((file) => file !== current);
  return current ? [...history, current] : history;
}

export type ReviewerBindingTarget = {
  path: string;
  conversationId: string | null;
};

/**
 * Every navigable transcript bound to one logical review round. Durable
 * membership slots survive same-round retries, while conversation identity
 * folds archived generations into their current path. The active binding is
 * always last so compact history keeps a stable chronological tail.
 */
export function reviewerBindingTargetsForRound(
  flow: Flow,
  round: Round,
  files: readonly FileEntry[] = [],
): ReviewerBindingTarget[] {
  const resolved = reviewerFilesForRound(flow, round, files);
  const targets = resolved.map((file) => ({ path: file.path, conversationId: file.conversationId ?? null }));
  const seen = new Set(targets.map((target) => target.path));
  if (!round.reviewerPath || seen.has(round.reviewerPath)) return targets;

  const pathFile = conversationFileIndex(files).byPath.get(round.reviewerPath) ?? null;
  const current = reviewerFileForRound(flow, round, files);
  const currentReplacedPath = Boolean(
    current
    && current.path !== round.reviewerPath
    && current.conversationId
    && (
      current.conversationId === round.reviewerConversationId
      || current.conversationId === pathFile?.conversationId
    ),
  );
  if (currentReplacedPath) return targets;

  targets.push({
    path: round.reviewerPath,
    conversationId: round.reviewerConversationId ?? pathFile?.conversationId ?? null,
  });
  return targets;
}

/**
 * Descendants spawned by folded reviewer sessions should remain expanded on
 * the scheme. The reviewer card itself lives in the round deck; its children
 * still carry real conversation structure below the implementer.
 */
export function claimedReviewerDescendantPaths(files: FileEntry[], flows: Flow[]): Set<string> {
  const claimed = claimedReviewerPaths(flows, files);
  for (const file of files) {
    if (file.durableLineage?.role === "reviewer" || file.durableLineage?.memberships.some((membership) => membership.kind === "flow" && membership.role === "reviewer")) {
      claimed.add(file.path);
    }
  }
  const children = new Map<string, FileEntry[]>();
  for (const file of files) {
    if (!file.parent) continue;
    const list = children.get(file.parent);
    if (list) list.push(file);
    else children.set(file.parent, [file]);
  }
  const out = new Set<string>();
  const stack = [...claimed];
  const seen = new Set(stack);
  while (stack.length) {
    const parent = stack.pop()!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.path)) continue;
      seen.add(child.path);
      out.add(child.path);
      stack.push(child.path);
    }
  }
  return out;
}

/**
 * Reviewer sessions are folded into the flow strip (see claimedReviewerPaths),
 * so they are dropped from the board. But a reviewer often spawns its own
 * subtasks; with the reviewer gone from the file set those children lose their
 * on-board parent and `rootOf` promotes each to a detached top-level node. Drop
 * the reviewer itself and re-home its direct children onto the flow's
 * implementer — a node that stays visible — so the subtasks render as connected
 * children of the flow instead of floating loose.
 *
 * Explicitly-opened and authorship-protected reviewers that have no round deck
 * are recovered separately by `protectedReviewerNodes` and materialized as
 * standalone nodes (issue #112), so folding here stays unconditional.
 *
 * `protectedPaths` is the exception the pipeline lane needs (issue #560): a
 * pipeline review stage's CURRENT reviewer round is not a standalone flow
 * reviewer to be folded into a round deck — it is that stage's live conversation
 * window and must stay a real card inside the pipeline group. The second loop
 * below folds by durable `reviewer` membership regardless of whether the flow is
 * in `flows` (a pipeline flow is intentionally removed from the layout catalog
 * by `compactPipelineLayoutFlows`), so without this guard the current reviewer
 * is dropped before `pipelineFullPanePaths` can protect it and the stage slot
 * collapses to a prompt placeholder (task f6c1a774 / Fix #604). Protected
 * reviewers are never anchors either, so their own children keep their real
 * parent.
 *
 * Recorded round paths are resolved onto the projected spelling before every
 * comparison (#943 follow-up): a flow that ran before its account home was cut
 * over to the shared transcript store holds the old spelling, which matches no
 * projected file, so its rounds would each hold a free node. `protectedPaths`
 * comes from the same durable records, so it is resolved too — resolving only
 * the round would newly fold a live pipeline stage reviewer off the board.
 */
export function foldClaimedReviewers(
  files: FileEntry[],
  flows: Flow[],
  protectedPaths: ReadonlySet<string> = EMPTY_PROTECTED,
): FileEntry[] {
  const resolveClaim = transcriptClaimResolver(files);
  const protectedClaims = resolveTranscriptClaims(protectedPaths, resolveClaim);
  const anchorByReviewer = new Map<string, string>();
  for (const flow of flows) {
    const implementerPath = resolveClaim(flow.implementerPath);
    for (const round of flow.rounds) {
      const reviewerPath = round.reviewerPath ? resolveClaim(round.reviewerPath) : null;
      if (reviewerPath && !protectedClaims.has(reviewerPath)) anchorByReviewer.set(reviewerPath, implementerPath);
    }
  }
  const pathByConversationId = new Map(withoutArchivedPredecessors(files).flatMap((file) =>
    file.conversationId ? [[file.conversationId, file.path] as const] : []));
  for (const file of files) {
    if (protectedClaims.has(file.path)) continue;
    const membership = file.durableLineage?.memberships.find((candidate) => candidate.kind === "flow" && candidate.role === "reviewer");
    if (!membership) continue;
    const flow = flows.find((candidate) => candidate.id === membership.containerId);
    const reviewedPath = file.durableLineage?.reviewsConversationId
      ? pathByConversationId.get(file.durableLineage.reviewsConversationId)
      : undefined;
    const anchor = reviewedPath ?? file.parent ?? (flow ? resolveClaim(flow.implementerPath) : undefined);
    if (anchor) anchorByReviewer.set(file.path, anchor);
  }
  if (!anchorByReviewer.size) return files;
  const out: FileEntry[] = [];
  for (const file of files) {
    if (anchorByReviewer.has(file.path)) continue; // the reviewer stays folded in the flow strip
    const anchor = file.parent ? anchorByReviewer.get(file.parent) : undefined;
    out.push(anchor ? { ...file, parent: anchor } : file);
  }
  return out;
}

const EMPTY_PROTECTED: ReadonlySet<string> = new Set();

/** Cached creation affordances remain disabled after flow retirement. */
export function canStartFlow(file: FileEntry, activeByImplementer: ReadonlyMap<string, Flow>): boolean {
  void file;
  void activeByImplementer;
  return false;
}

/** Localized lifecycle-state label; keys live under flowState.* in the dicts. */
export function stateLabel(t: TFunction, state: FlowState): string {
  return t(`flowState.${state}`);
}

export function flowPresentation(t: TFunction, flow: Flow, _locale: Locale) {
  return {
    label: isDirectGroup(flow) ? stateLabel(t, flow.state) : t(flow.state === "paused" || flow.rounds.some(round => round.relayPendingSettlement || round.relayRetryRequiresIdempotency) ? "reviewHistory.unresolved" : "reviewHistory.retired"),
    detail: flow.stateDetail,
    attention: false,
    pending: null,
  };
}

/** The loop side working right now — drives the role tags on the scheme. */
export function activeLoopRole(flow: Flow): FlowRoleKey | null {
  if (!isDirectGroup(flow) || flow.block) return null;
  if (flow.state === "spawning" || flow.state === "reviewing") return "reviewer";
  if (flow.state === "waiting_ready" || flow.state === "relaying" || flow.state === "fixing") return "implementer";
  return null;
}

/** The cycle leg traffic is on: forward = implementer → reviewer. */
export function activeLoopLeg(flow: Flow): "forward" | "back" | null {
  if (!isDirectGroup(flow) || flow.block) return null;
  if (flow.state === "spawn_pending" || flow.state === "spawning" || flow.state === "reviewing") return "forward";
  if (flow.state === "relay_pending" || flow.state === "relaying" || flow.state === "fixing") return "back";
  if (flow.state === "waiting_ready") return flow.rounds.length ? "back" : null;
  return null;
}

export const VERDICT_GLYPHS: Record<ReviewVerdict, string> = {
  APPROVE: "✓",
  REQUEST_CHANGES: "✖",
  COMMENT: "◆",
};

/** Text/background pair per verdict, in the dashboard's token palette. */
export function verdictTone(verdict: ReviewVerdict | null): { color: string; soft: string } {
  if (verdict === "APPROVE") return { color: "var(--color-success)", soft: "var(--color-success-soft)" };
  if (verdict === "REQUEST_CHANGES") return { color: "var(--color-danger)", soft: "var(--color-danger-soft)" };
  if (verdict === "COMMENT") return { color: "var(--color-warning)", soft: "var(--color-warning-soft)" };
  return { color: "var(--color-muted)", soft: "var(--color-sunken)" };
}

/** Cached callers get a local retirement refusal without attempting a write. */
export async function patchFlow(_id: string, _body: unknown): Promise<string> {
  return translate(getLocale(), "reviewHistory.retired");
}
