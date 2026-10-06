import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeReviewRound, PrototypeReviewSummary, PrototypeReviewNotice, PrototypeRoundView, PrototypeMedia, PrototypeReviewReplica } from "./types";

/** Only presentation metadata crosses installation boundaries. */
export function prototypeRoundMetadata(round: PrototypeReviewRound): PrototypeRoundView {
  const { publicationKey: _key, inputDigest: _digest, decision, variants, ...publicRound } = round;
  const media = (item: PrototypeMedia) => ({ ...item, available: false, url: null });
  return { ...publicRound, variants: variants.map(v => ({ ...v,
    frames: v.frames.map(({ image, original, ...frame }) => ({ ...frame, image: media(image), ...(original ? { original: media(original) } : {}) })),
    videos: v.videos.map(video => ({ ...video, media: media(video.media) })) })),
    ...(decision ? { decision: { chosen: decision.chosen, comment: decision.comment, at: decision.at,
      delivery: { state: decision.delivery.state, retryable: ["failed", "uncertain", "no-orchestrator", "pending"].includes(decision.delivery.state) } } } : {}) };
}
export function prototypeReviewReplica(task: BoardTask): PrototypeReviewReplica | undefined {
  const summary = prototypeReviewSummary(task.prototypeReviews ?? []);
  return summary ? { summary, rounds: task.prototypeReviews!.map(round => prototypeRoundMetadata({ ...round, taskId: task.id, project: task.project })) } : task.prototypeReviewReplica;
}

/** Pure selectors: one waiting round per task, even when earlier rounds remain undecided. */
export function prototypeReviewSummary(rounds: readonly PrototypeReviewRound[]): PrototypeReviewSummary | undefined {
  const latest = rounds.at(-1);
  if (!latest) return undefined;
  const waiting = rounds.findLast(r => !r.decision);
  return { latestReviewId: latest.id, waitingReviewId: waiting?.id ?? null, title: latest.title,
    rounds: rounds.length, createdAt: (waiting ?? latest).createdAt,
    ...(latest.decision ? { decision: { chosen: latest.variants.filter(v => latest.decision!.chosen.includes(v.number)).map(v => ({ number: v.number, name: v.name })),
      comment: latest.decision.comment, at: latest.decision.at, delivery: latest.decision.delivery.state } } : {}) };
}
export function prototypeReviewNotices(tasks: readonly BoardTask[]): PrototypeReviewNotice[] {
  return tasks.flatMap(task => {
    const summary = task.prototypeReview ?? prototypeReviewSummary(task.prototypeReviews ?? []) ?? task.prototypeReviewReplica?.summary;
    return summary?.waitingReviewId ? [{ id: `prototype:${summary.waitingReviewId}`, project: task.project, taskId: task.id, reviewId: summary.waitingReviewId, title: summary.title,
      createdAt: summary.createdAt, target: { kind: "prototype-review" as const, taskId: task.id, reviewId: summary.waitingReviewId } }] : [];
  });
}
