import fs from "node:fs";
import { attentionDismissalIndex, type AttentionDismissalV1 } from "@/lib/attention/dismissals";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import type { BoardTask } from "@/lib/tasks/types";
import { prototypeRoot, storedMediaPath } from "./store";
import type { PrototypeReviewRead, PrototypeMediaView, PrototypeReviewSummary, PrototypeRoundRead, PrototypeRoundView } from "./types";
import { currentPrototypeSummary, prototypeReviewSummary, prototypeRoundMetadata, prototypeRoundsSuperseded } from "./model";
export { prototypeReviewSummary, prototypeReviewNotices } from "./model";
export function withPrototypeReviewSummaries<T extends BoardTask>(tasks: readonly T[], index: ReadonlyMap<string, AttentionDismissalV1> = prototypeDismissals()): Array<Omit<T, "prototypeReviews" | "prototypeReviewReplica"> & { prototypeReview?: PrototypeReviewSummary }> {
  return tasks.map(({ prototypeReviews, prototypeReviewReplica, ...task }) => {
    const summary = currentPrototypeSummary(prototypeReviewSummary(prototypeReviews ?? []) ?? prototypeReviewReplica?.summary ?? task.prototypeReview);
    const record = summary?.waitingReviewId ? index.get(`prototype:${summary.waitingReviewId}`) : undefined;
    if (!summary) return task;
    const { waitingDismissal: _held, ...current } = summary;
    return { ...task, prototypeReview: { ...current, ...(record?.kind === "prototype" && record.taskId === task.id ? { waitingDismissal: { at: record.at, by: record.by } } : {}) } };
  });
}
/** What a caller that names itself with a capability gets on a shared board
    read: the task, and nothing of its review. The board has no project fence,
    so an agent reads a review only through the project-scoped review tool. */
export function withoutPrototypeReviews<T extends BoardTask>(tasks: readonly T[]): Array<Omit<T, "prototypeReviews" | "prototypeReviewReplica" | "prototypeReview">> {
  return tasks.map(held => {
    const task = { ...held };
    delete task.prototypeReviews; delete task.prototypeReviewReplica; delete task.prototypeReview;
    return task;
  });
}
/** The one shape a task takes in an HTTP answer, whichever route answers:
    the review's summary for the operator's interface, and nothing of the
    review for a caller that presents a capability. A route that hands back a
    task after a write passes it through here, so no acknowledgement carries
    the rounds, the comment or the message sent to the orchestrator. */
export function taskForResponse<T extends BoardTask>(request: { headers: Headers }, task: T): BoardTask {
  return request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) ? withoutPrototypeReviews([task])[0]! : withPrototypeReviewSummaries([task])[0]!;
}
/** A round a later decision retired names that decision's round; it stays in
    the history and can still be decided, but nothing waits on it. */
function withSuperseded(rounds: PrototypeRoundView[], taskId: string): PrototypeRoundRead[] {
  const superseded = prototypeRoundsSuperseded(rounds);
  const index = prototypeDismissals();
  return rounds.map(round => {
    const record = index.get(`prototype:${round.id}`);
    return { ...round, ...(superseded.has(round.id) ? { supersededBy: superseded.get(round.id)! } : {}),
      ...(record?.taskId === taskId ? { hidden: { at: record.at, by: record.by } } : {}) };
  });
}
export function readPrototypeReviews(task: BoardTask): PrototypeReviewRead {
  if (!task.prototypeReviews?.length && task.prototypeReviewReplica) {
    const summary = withPrototypeReviewSummaries([task])[0]!.prototypeReview!;
    return { taskId: task.id, rounds: withSuperseded(task.prototypeReviewReplica.rounds, task.id), summary,
      ...(task.prototypeReviewReplica.historyTruncated ? { historyTruncated: true } : {}),
      waitingReviewId: summary.waitingDismissal ? null : summary.waitingReviewId, unavailable: "another-installation" };
  }
  // The media route's own test: a regular file at its place under the resolved root.
  let realRoot: string | null = null;
  try { realRoot = fs.realpathSync(prototypeRoot()); } catch { /* No copy was ever stored here. */ }
  const stored = (roundId: string, media: PrototypeMediaView) => {
    if (!realRoot) return false;
    try {
      const place = storedMediaPath(realRoot,roundId,media);
      return fs.realpathSync(place) === place && fs.lstatSync(place).isFile();
    } catch { return false; /* Copy is absent on linked installations and after retention. */ }
  };
  const rounds = (task.prototypeReviews ?? []).map(round => {
    const publicRound = prototypeRoundMetadata(round);
    const mediaView = (media: PrototypeMediaView) => {
      const available = !round.mediaRemovedAt && stored(round.id,media);
      const url = !available ? null : media.mime.startsWith("image/")
        ? `/api/image?taskId=${encodeURIComponent(task.id)}&prototype=${round.id}&media=${media.id}`
        : `/api/tasks/${encodeURIComponent(task.id)}/prototypes/${round.id}/video/${media.id}`;
      return { ...media, available, url };
    };
    return { ...publicRound, variants: publicRound.variants.map(v => ({ ...v, frames: v.frames.map(({ image,original,...frame }) => ({ ...frame, image: mediaView(image), ...(original ? { original: mediaView(original) } : {}) })),
      videos: v.videos.map(video => ({ ...video, media: mediaView(video.media) })) })) };
  });
  const summary = withPrototypeReviewSummaries([task])[0]!.prototypeReview;
  return { taskId: task.id, rounds: withSuperseded(rounds, task.id), summary, waitingReviewId: summary?.waitingDismissal ? null : summary?.waitingReviewId ?? null };
}

function prototypeDismissals(): ReadonlyMap<string, AttentionDismissalV1> {
  try { return attentionDismissalIndex(); } catch { return new Map(); }
}
