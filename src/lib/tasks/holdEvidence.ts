import { forgeCacheView } from "@/lib/forge/cache";
import { taskRepositoryOrCarrier } from "@/lib/forge/resolve";
import { normalizeWorkLinkInput } from "@/lib/forge/workLinks";
import type { Pipeline } from "@/lib/pipelines/types";
import { findSeatRound } from "@/lib/prototypeReview/seatRounds";
import type { PrototypeReviewNotice } from "@/lib/prototypeReview/types";
import type { BoardTask } from "./types";
import type { HoldPullRequestState, PublishedRoundLookup } from "./waitingRoute";

/*
 * The checkable prerequisites a hold can name, read the same way by the seat
 * tick and the scheduled maintainer: the forge cache for a PR, and the seat's
 * round store for a decision form the seat itself published.
 */

/** A PR hold's state in the forge cache. A bare number resolves against the
    repository the board resolves for the task, as the forge sweep demands it. */
export function holdPullRequestState(
  tasks: readonly Pick<BoardTask, "id" | "project">[],
  pipelines: readonly Pipeline[],
  knownRepository: (taskId: string) => string | null | undefined = () => undefined,
): HoldPullRequestState {
  let byId: Map<string, Pick<BoardTask, "id" | "project">> | undefined;
  let carriers: Map<string, Pipeline[]> | undefined;
  let cache: ReturnType<typeof forgeCacheView> | undefined;
  return (taskId, ref) => {
    const task = (byId ??= new Map(tasks.map(row => [row.id, row]))).get(taskId);
    if (!task) return undefined;
    if (!carriers) {
      carriers = new Map();
      for (const pipeline of pipelines) for (const id of pipeline.taskIds ?? []) carriers.set(id, [...carriers.get(id) ?? [], pipeline]);
    }
    const repository = knownRepository(taskId) ?? taskRepositoryOrCarrier(task, carriers.get(taskId) ?? []);
    const link = normalizeWorkLinkInput(ref, { repository });
    if (!link.ok || link.link.kind === "issue") return undefined;
    return (cache ??= forgeCacheView()).repository(link.link.repository)?.pr(link.link.number)?.state;
  };
}

/** The seat's own rounds by id. The store says whether a round was answered,
    whatever became of its delivery; the notices say which unanswered rounds
    still wait on the operator (a dismissed one waits on nobody). */
export function seatRoundLookup(notices: readonly PrototypeReviewNotice[] = []): PublishedRoundLookup {
  return reviewId => {
    const notice = notices.find(candidate => candidate.reviewId === reviewId);
    let stored: ReturnType<typeof findSeatRound>;
    try { stored = findSeatRound(reviewId); } catch { stored = undefined; }
    if (stored) {
      if (stored.decision) return { project: stored.project, open: false, answeredBy: reviewId };
      return notice && !notice.undelivered ? { project: stored.project, open: true } : undefined;
    }
    if (!notice) return undefined;
    return notice.undelivered ? { project: notice.project, open: false, answeredBy: reviewId } : { project: notice.project, open: true };
  };
}
