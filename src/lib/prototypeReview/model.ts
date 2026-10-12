import { firstLineTitle } from "@/lib/tasks/helpers";
import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeDecision, PrototypeDeliveryPhase, PrototypeDeliveryState, PrototypeReviewRound, PrototypeReviewSummary, PrototypeReviewNotice, PrototypeRoundView, PrototypeMedia, PrototypeReviewReplica } from "./types";

/** How long a decision's message may keep failing to reach the seat before it
    asks for the operator's attention. A deploy or a seat's rotation passes
    inside it unnoticed; the background delivery keeps retrying either way. */
export const PROTOTYPE_DELIVERY_ATTENTION_MS = 5 * 60_000;
/** The review's quiet word for a saved decision's message. */
export function prototypeDeliveryPhase(delivery: PrototypeDecision["delivery"], now: number): PrototypeDeliveryPhase {
  if (delivery.state === "sent") return "delivered";
  if (delivery.failingSince && now - Date.parse(delivery.failingSince) >= PROTOTYPE_DELIVERY_ATTENTION_MS) return "attention";
  if (!delivery.conversationId) return "waiting-seat";
  return delivery.state === "pending" && !delivery.dispatchedAt && !delivery.operationId ? "saved" : "delivering";
}

/** Only presentation metadata crosses installation boundaries. */
export function prototypeRoundMetadata(round: PrototypeReviewRound): PrototypeRoundView {
  const { publicationKey: _key, inputDigest: _digest, decision, variants, ...publicRound } = round;
  const media = (item: PrototypeMedia) => ({ ...item, available: false, url: null });
  return { ...publicRound, variants: variants.map(v => ({ ...v,
    frames: v.frames.map(({ image, original, ...frame }) => ({ ...frame, image: media(image), ...(original ? { original: media(original) } : {}) })),
    videos: v.videos.map(video => ({ ...video, media: media(video.media) })) })),
    ...(decision ? { decision: { chosen: decision.chosen, ...(decision.answers ? { answers: decision.answers } : {}), ...(decision.skipped ? { skipped: decision.skipped } : {}), comment: decision.comment, at: decision.at,
      delivery: { state: decision.delivery.state, retryable: ["failed", "uncertain", "no-orchestrator", "pending"].includes(decision.delivery.state) } } } : {}) };
}
export function prototypeReviewReplica(task: BoardTask): PrototypeReviewReplica | undefined {
  const summary = prototypeReviewSummary(task.prototypeReviews ?? []);
  return summary ? { summary, rounds: task.prototypeReviews!.map(round => prototypeRoundMetadata({ ...round, taskId: task.id, project: task.project })) } : task.prototypeReviewReplica;
}

/** What the summary reads of a round: a stored round and its public view both carry it. */
type SummaryRound = Pick<PrototypeReviewRound, "id" | "title" | "createdAt" | "questions"> & { variants: ReadonlyArray<{ number: number; name: string }>;
  decision?: Pick<PrototypeDecision, "chosen" | "comment" | "at"> & { delivery: { state: PrototypeDeliveryState } } };
/** Pure selectors: at most one waiting round per task, and only the newest.
    A newer round replaces every undecided round before it, and a decision
    retires every older undecided round: the operator has answered the task.
    Derived on every read, so rounds stored before this rule need no migration. */
export function prototypeReviewSummary(rounds: readonly SummaryRound[]): PrototypeReviewSummary | undefined {
  const latest = rounds.at(-1);
  if (!latest) return undefined;
  return { latestReviewId: latest.id, waitingReviewId: latest.decision ? null : latest.id, title: latest.title,
    rounds: rounds.length, createdAt: latest.createdAt, ...(latest.questions?.length ? { asks: "questions" as const } : {}),
    ...(latest.decision ? { decision: { ...(latest.questions?.length ? { answered: true as const } : {}), chosen: latest.variants.filter(v => latest.decision!.chosen.includes(v.number)).map(v => ({ number: v.number, name: v.name })),
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
export function prototypeReviewNotices(tasks: readonly BoardTask[], now = Date.now()): PrototypeReviewNotice[] {
  return tasks.flatMap((task): PrototypeReviewNotice[] => {
    const summary = currentPrototypeSummary(task.prototypeReview ?? prototypeReviewSummary(task.prototypeReviews ?? []) ?? task.prototypeReviewReplica?.summary);
    const reviewId = summary?.waitingReviewId;
    /* A decided latest round whose message keeps failing waits on the operator too: the row opens the review, where the retry is. */
    if (summary?.decision && !reviewId) {
      const held = task.prototypeReviews?.at(-1)?.decision;
      const phase = held ? prototypeDeliveryPhase(held.delivery, now) : summary.decision.phase;
      if (phase !== "attention") return [];
      const latest = summary.latestReviewId;
      return [{ id: `prototype-delivery:${latest}`, project: task.project, taskId: task.id, reviewId: latest, title: firstLineTitle(task.text), roundTitle: summary.title,
        undelivered: true as const, createdAt: summary.decision.at, target: { kind: "prototype-review" as const, taskId: task.id, reviewId: latest } }];
    }
    if (!summary || !reviewId || !prototypeWaitsOnOperator(summary)) return [];
    /* The notice names the task the jump lands on; the waiting round's own title, which may be older than the latest, rides second. */
    const waiting = (task.prototypeReviews ?? task.prototypeReviewReplica?.rounds ?? []).find(round => round.id === reviewId);
    const roundTitle = waiting?.title ?? (reviewId === summary.latestReviewId ? summary.title : undefined);
    return [{ id: `prototype:${reviewId}`, project: task.project, taskId: task.id, reviewId, title: firstLineTitle(task.text), ...(roundTitle ? { roundTitle } : {}),
      ...(waiting?.questions?.length || summary.asks === "questions" ? { asks: "questions" as const } : {}),
      createdAt: summary.createdAt, target: { kind: "prototype-review" as const, taskId: task.id, reviewId } }];
  });
}

export function prototypeWaitsOnOperator(summary: PrototypeReviewSummary | undefined): boolean {
  return !!summary?.waitingReviewId && !summary.waitingDismissal;
}
