import { PROTOTYPE_DELIVERY_MAX_ATTEMPTS } from "./deliveryPolicy";
import { nativeAssociationDecisionApproves } from "@/lib/attention/nativeAssociationForm";
import { firstLineTitle } from "@/lib/tasks/helpers";
import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeDecision, PrototypeDeliveryPhase, PrototypeDeliveryState, PrototypeReviewRound, PrototypeReviewSummary, PrototypeReviewNotice, PrototypeRoundView, PrototypeMedia, PrototypeReviewReplica } from "./types";

/** How long a decision's message may keep failing to reach the seat before it
    asks for the operator's attention. A deploy or a seat's rotation passes
    inside it unnoticed; the background delivery observes its persisted retry budget. */
export const PROTOTYPE_DELIVERY_ATTENTION_MS = 5 * 60_000;
/** The review's quiet word for a saved decision's message. */
export function prototypeDeliveryPhase(delivery: PrototypeDecision["delivery"], now: number): PrototypeDeliveryPhase {
  if (delivery.state === "sent") return "delivered";
  if (delivery.exhaustedAt || (delivery.attempts ?? 0) >= PROTOTYPE_DELIVERY_MAX_ATTEMPTS || delivery.failingSince && now - Date.parse(delivery.failingSince) >= PROTOTYPE_DELIVERY_ATTENTION_MS) return "attention";
  if (!delivery.conversationId) return "waiting-seat";
  return delivery.state === "pending" && !delivery.dispatchedAt && !delivery.operationId ? "saved" : "delivering";
}

/** Only presentation metadata crosses installation boundaries. */
export function prototypeRoundMetadata(round: PrototypeReviewRound): PrototypeRoundView {
  const { publicationKey: _key, inputDigest: _digest, critic: _critic, nativeAssociation: _association, decision, variants, ...publicRound } = round;
  void _critic; void _association;
  const media = (item: PrototypeMedia) => ({ ...item, available: false, url: null });
  return { ...publicRound, ...(_association ? { nativeAssociationState: !decision ? "pending" as const : nativeAssociationDecisionApproves(decision) ? "approved" as const : "refused" as const } : {}), variants: variants.map(v => ({ ...v,
    frames: v.frames.map(({ image, original, ...frame }) => ({ ...frame, image: media(image), ...(original ? { original: media(original) } : {}) })),
    videos: v.videos.map(video => ({ ...video, media: media(video.media) })) })),
    ...(decision ? { decision: { chosen: decision.chosen, ...(decision.originalReply !== undefined ? { originalReply: decision.originalReply } : {}),
      ...(decision.recommendedWithReservation ? { recommendedWithReservation: decision.recommendedWithReservation } : {}),
      ...(decision.rejected ? { rejected: decision.rejected } : {}), ...(decision.answers ? { answers: decision.answers } : {}), ...(decision.skipped ? { skipped: decision.skipped } : {}), comment: decision.comment, at: decision.at,
      delivery: { state: decision.delivery.state, retryable: ["failed", "uncertain", "no-orchestrator", "pending"].includes(decision.delivery.state) } } } : {}) };
}
export function prototypeReviewReplica(task: BoardTask): PrototypeReviewReplica | undefined {
  const summary = prototypeReviewSummary(task.prototypeReviews ?? []);
  return summary ? { summary, rounds: task.prototypeReviews!.map(round => {
    const { telegramPost: _localPost, telegramPolls: _localPolls, ...metadata } = prototypeRoundMetadata({ ...round, taskId: task.id, project: task.project });
    return metadata;
  }) } : task.prototypeReviewReplica;
}

/** What the summary reads of a round: a stored round and its public view both carry it. */
type SummaryRound = Pick<PrototypeReviewRound, "id" | "title" | "createdAt" | "questions"> & { variants: ReadonlyArray<{ number: number; name: string }>;
  decision?: Pick<PrototypeDecision, "chosen" | "comment" | "at" | "rejected" | "originalReply"> & { delivery: { state: PrototypeDeliveryState } } };
/** Pure selectors: at most one waiting round per task, and only the newest.
    A newer round replaces every undecided round before it, and a decision
    retires every older undecided round: the operator has answered the task.
    Derived on every read, so rounds stored before this rule need no migration. */
export function prototypeReviewSummary(rounds: readonly SummaryRound[]): PrototypeReviewSummary | undefined {
  const latest = rounds.at(-1);
  if (!latest) return undefined;
  return { latestReviewId: latest.id, waitingReviewId: latest.decision ? null : latest.id, title: latest.title,
    rounds: rounds.length, createdAt: latest.createdAt, ...(latest.questions?.length ? { asks: "questions" as const } : {}),
    ...(latest.decision ? { decision: { ...(latest.decision.rejected ? { rejected: true as const } : {}), ...(latest.questions?.length || latest.decision.originalReply !== undefined ? { answered: true as const } : {}), chosen: latest.variants.filter(v => latest.decision!.chosen.includes(v.number)).map(v => ({ number: v.number, name: v.name })),
      comment: latest.decision.comment, at: latest.decision.at, delivery: latest.decision.delivery.state } } : {}) };
}
/** A summary built elsewhere (an older installation's replica, a held poll)
    may still name a round a later decision retired: only the latest round waits. */
export function currentPrototypeSummary(summary: PrototypeReviewSummary): PrototypeReviewSummary;
export function currentPrototypeSummary(summary: PrototypeReviewSummary | undefined): PrototypeReviewSummary | undefined;
export function currentPrototypeSummary(summary: PrototypeReviewSummary | undefined): PrototypeReviewSummary | undefined {
  return summary?.waitingReviewId && summary.waitingReviewId !== summary.latestReviewId ? { ...summary, waitingReviewId: null } : summary;
}
/** Each undecided round a later decision retired, to the nearest such decided round. */
export function prototypeRoundsSuperseded(rounds: ReadonlyArray<{ id: string; decision?: unknown }>): Map<string, string> {
  const superseded = new Map<string, string>();
  let decided: string | undefined;
  for (const round of [...rounds].reverse()) {
    if (round.decision) decided = round.id;
    else if (decided) superseded.set(round.id, decided);
  }
  return superseded;
}
/** A seat's own unanswered question as a notice: no task to land on, so it
    opens in the seat's «Рішення» column (docs/design/operator-decision-forms.md §2.2). */
export function seatRoundNotice(round: Pick<PrototypeReviewRound, "id" | "project" | "title" | "createdAt" | "questions">): PrototypeReviewNotice {
  return { id: `prototype:${round.id}`, project: round.project, taskId: null, reviewId: round.id, title: round.title,
    ...(round.questions?.length ? { asks: "questions" as const } : {}), createdAt: round.createdAt,
    target: { kind: "seat-decision", project: round.project, reviewId: round.id } };
}
/** Every round waiting on the operator: one per task, then each open seat
    question the page's read carried beside the tasks. */
export function prototypeReviewNotices(tasks: readonly BoardTask[], seatOrNow: readonly PrototypeReviewNotice[] | number = [], now = Date.now()): PrototypeReviewNotice[] {
  const seat = typeof seatOrNow === "number" ? [] : seatOrNow;
  if (typeof seatOrNow === "number") now = seatOrNow;
  return [...tasks.flatMap((task): PrototypeReviewNotice[] => {
    const summary = currentPrototypeSummary(task.prototypeReview ?? prototypeReviewSummary(task.prototypeReviews ?? []) ?? task.prototypeReviewReplica?.summary);
    const reviewId = summary?.waitingReviewId;
    const undelivered = summary?.undelivered ?? (task.prototypeReviews
      ? task.prototypeReviews.filter(round => round.decision && prototypeDeliveryPhase(round.decision.delivery, now) === "attention")
        .map(round => ({ reviewId: round.id, title: round.title, at: round.decision!.at }))
      : summary?.decision?.phase === "attention" ? [{ reviewId: summary.latestReviewId, title: summary.title, at: summary.decision.at }] : []);
    const failures: PrototypeReviewNotice[] = undelivered.map(round => ({ id: `prototype-delivery:${round.reviewId}`, project: task.project,
      taskId: task.id, reviewId: round.reviewId, title: firstLineTitle(task.text), roundTitle: round.title,
      undelivered: true, createdAt: round.at, target: { kind: "prototype-review", taskId: task.id, reviewId: round.reviewId } }));
    if (!summary || !reviewId || !prototypeWaitsOnOperator(summary, task)) return failures;
    /* The notice names the task the jump lands on; the waiting round's own title, which may be older than the latest, rides second. */
    const waiting = (task.prototypeReviews ?? task.prototypeReviewReplica?.rounds ?? []).find(round => round.id === reviewId);
    const roundTitle = waiting?.title ?? (reviewId === summary.latestReviewId ? summary.title : undefined);
    return [...failures, { id: `prototype:${reviewId}`, project: task.project, taskId: task.id, reviewId, title: firstLineTitle(task.text), ...(roundTitle ? { roundTitle } : {}),
      ...(waiting?.questions?.length || summary.asks === "questions" ? { asks: "questions" as const } : {}),
      createdAt: summary.createdAt, target: { kind: "prototype-review" as const, taskId: task.id, reviewId } }];
  }), ...seat];
}

export function prototypeWaitsOnOperator(summary: PrototypeReviewSummary | undefined, task?: Pick<BoardTask, "status" | "doneAt" | "updatedAt"> | null): boolean {
  if (!summary?.waitingReviewId || summary.waitingDismissal) return false;
  if (task?.status === "done") {
    const finished = Date.parse(task.doneAt ?? task.updatedAt);
    const raised = Date.parse(summary.createdAt);
    if (Number.isFinite(finished) && Number.isFinite(raised) && raised <= finished) return false;
  }
  return true;
}
