import fs from "node:fs";
import path from "node:path";
import type { BoardTask } from "@/lib/tasks/types";
import { mediaFilename, roundDirectory } from "./store";
import type { PrototypeReviewRead, PrototypeMediaView, PrototypeReviewSummary } from "./types";
import { prototypeReviewSummary, prototypeRoundMetadata } from "./model";
export { prototypeReviewSummary, prototypeReviewNotices } from "./model";
export function withPrototypeReviewSummaries<T extends BoardTask>(tasks: readonly T[]): Array<Omit<T, "prototypeReviews" | "prototypeReviewReplica"> & { prototypeReview?: PrototypeReviewSummary }> {
  return tasks.map(({ prototypeReviews, prototypeReviewReplica, ...task }) => ({ ...task,
    prototypeReview: prototypeReviewSummary(prototypeReviews ?? []) ?? prototypeReviewReplica?.summary ?? task.prototypeReview }));
}
export function readPrototypeReviews(task: BoardTask): PrototypeReviewRead {
  if (!task.prototypeReviews?.length && task.prototypeReviewReplica) return { taskId: task.id,
    rounds: task.prototypeReviewReplica.rounds, summary: task.prototypeReviewReplica.summary,
    ...(task.prototypeReviewReplica.historyTruncated ? { historyTruncated: true } : {}),
    waitingReviewId: task.prototypeReviewReplica.summary.waitingReviewId, unavailable: "another-installation" };
  const rounds = (task.prototypeReviews ?? []).map(round => {
    const publicRound = prototypeRoundMetadata(round);
    const mediaView = (media: PrototypeMediaView) => {
      let available = false;
      try { available = !round.mediaRemovedAt && fs.lstatSync(path.join(roundDirectory(round.id),mediaFilename(media))).isFile(); } catch { /* Copy is absent on linked installations and after retention. */ }
      const url = !available ? null : media.mime.startsWith("image/")
        ? `/api/image?taskId=${encodeURIComponent(task.id)}&prototype=${round.id}&media=${media.id}`
        : `/api/tasks/${encodeURIComponent(task.id)}/prototypes/${round.id}/video/${media.id}`;
      return { ...media, available, url };
    };
    return { ...publicRound, variants: publicRound.variants.map(v => ({ ...v, frames: v.frames.map(({ image,original,...frame }) => ({ ...frame, image: mediaView(image), ...(original ? { original: mediaView(original) } : {}) })),
      videos: v.videos.map(video => ({ ...video, media: mediaView(video.media) })) })) };
  });
  return { taskId: task.id, rounds, summary: prototypeReviewSummary(task.prototypeReviews ?? []), waitingReviewId: rounds.findLast(r => !r.decision)?.id ?? null };
}
