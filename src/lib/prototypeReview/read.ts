import { nativeAssociationDecisionApproves } from "@/lib/attention/nativeAssociationForm";
import { nativeAssociationCurrent } from "@/lib/attention/nativeCallerSources";
import fs from "node:fs";
import { attentionDismissalIndex, type AttentionDismissalV1 } from "@/lib/attention/dismissals";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import type { BoardTask } from "@/lib/tasks/types";
import { prototypeRoot, storedMediaPath } from "./store";
import { canonicalProject } from "@/lib/projects/aliases";
import { runsElsewhere } from "@/lib/links/linked";
import { firstLineTitle } from "@/lib/tasks/helpers";
import { loadTasks } from "@/lib/tasks/store";
import { loadSeatRounds } from "./seatRounds";
import type { OperatorDecisionView, OperatorDecisionsRead, PrototypeReviewNotice, PrototypeReviewRead, PrototypeMediaView, PrototypeReviewRound, PrototypeReviewSummary, PrototypeRoundRead, PrototypeRoundView } from "./types";
import { currentPrototypeSummary, prototypeDeliveryPhase, prototypeReviewSummary, prototypeRoundMetadata, prototypeRoundsSuperseded, seatRoundNotice } from "./model";
export { prototypeReviewSummary, prototypeReviewNotices } from "./model";
export function withPrototypeReviewSummaries<T extends BoardTask>(tasks: readonly T[], index: ReadonlyMap<string, AttentionDismissalV1> = prototypeDismissals(), now = Date.now()): Array<Omit<T, "prototypeReviews" | "prototypeReviewReplica"> & { prototypeReview?: PrototypeReviewSummary }> {
  return tasks.map(({ prototypeReviews, prototypeReviewReplica, ...task }) => {
    const summary = currentPrototypeSummary(prototypeReviewSummary(prototypeReviews ?? []) ?? prototypeReviewReplica?.summary ?? task.prototypeReview);
    const record = summary?.waitingReviewId ? index.get(`prototype:${summary.waitingReviewId}`) : undefined;
    if (!summary) return task;
    const { waitingDismissal: _held, ...current } = summary;
    /* Only this installation drives a decision's delivery, so only its own rounds say how it goes. */
    const held = prototypeReviews?.at(-1)?.decision;
    return { ...task, prototypeReview: { ...current, ...(current.decision && held ? { decision: { ...current.decision, phase: prototypeDeliveryPhase(held.delivery, now) } } : {}),
      ...(record?.kind === "prototype" && record.taskId === task.id ? { waitingDismissal: { at: record.at, by: record.by } } : {}) } };
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
  const rounds = localRoundViews(task.prototypeReviews ?? [], task.id);
  const summary = withPrototypeReviewSummaries([task])[0]!.prototypeReview;
  return { taskId: task.id, rounds: withSuperseded(rounds, task.id), summary, waitingReviewId: summary?.waitingDismissal ? null : summary?.waitingReviewId ?? null };
}

/** Rounds stored here, with the URLs their copies answer at. A seat's round
    has no task: its pictures answer by round alone, and its videos are not
    served (docs/design/operator-decision-forms.md, Deferred). */
export function localRoundViews(stored: readonly PrototypeReviewRound[], taskId: string | null): PrototypeRoundView[] {
  // The media route's own test: a regular file at its place under the resolved root.
  let realRoot: string | null = null;
  try { realRoot = fs.realpathSync(prototypeRoot()); } catch { /* No copy was ever stored here. */ }
  const held = (roundId: string, media: PrototypeMediaView) => {
    if (!realRoot) return false;
    try {
      const place = storedMediaPath(realRoot,roundId,media);
      return fs.realpathSync(place) === place && fs.lstatSync(place).isFile();
    } catch { return false; /* Copy is absent on linked installations and after retention. */ }
  };
  const now = Date.now();
  return stored.map(round => {
    const metadata = prototypeRoundMetadata(round);
    const publicRound = metadata.decision && round.decision
      ? { ...metadata, decision: { ...metadata.decision, delivery: { ...metadata.decision.delivery, phase: prototypeDeliveryPhase(round.decision.delivery, now) } } } : metadata;
    const mediaView = (media: PrototypeMediaView) => {
      const image = media.mime.startsWith("image/");
      const available = !round.mediaRemovedAt && (image || taskId !== null) && held(round.id,media);
      const url = !available ? null : image
        ? `/api/image?${taskId === null ? "" : `taskId=${encodeURIComponent(taskId)}&`}prototype=${round.id}&media=${media.id}`
        : `/api/tasks/${encodeURIComponent(taskId!)}/prototypes/${round.id}/video/${media.id}`;
      return { ...media, available, url };
    };
    return { ...publicRound, variants: publicRound.variants.map(v => ({ ...v, frames: v.frames.map(({ image,original,...frame }) => ({ ...frame, image: mediaView(image), ...(original ? { original: mediaView(original) } : {}) })),
      videos: v.videos.map(video => ({ ...video, media: mediaView(video.media) })) })) };
  });
}

/** The seat's own rounds of a project, read as a task's review is read. Every
    unanswered one waits: a seat round answers one question of its own and
    retires no other (docs/design/operator-decision-forms.md §2.2). */
export function readSeatRounds(project: string): PrototypeReviewRead {
  const rounds = localRoundViews(loadSeatRounds(project), null);
  const waiting = rounds.filter(round => !round.decision);
  return { taskId: null, rounds, waitingReviewId: waiting.at(-1)?.id ?? null };
}

/** Every open decision of a project, oldest first: each task's waiting round
    and each unanswered seat round. Rounds another installation owns are
    answered there, and a round the operator hid waits on nobody. */
export function operatorDecisions(project: string, tasks: readonly BoardTask[] = loadTasks()): OperatorDecisionsRead {
  const key = canonicalProject(project);
  const fromTasks = tasks.filter(task => canonicalProject(task.project) === key && !runsElsewhere(task)
    && prototypeReviewSummary(task.prototypeReviews ?? [])?.waitingReviewId).flatMap(task => {
    const read = readPrototypeReviews(task);
    const waiting = read.waitingReviewId ? read.rounds.find(round => round.id === read.waitingReviewId) : undefined;
    return waiting ? [{ ...waiting, taskTitle: firstLineTitle(task.text) }] : [];
  });
  // Approved live associations stay reachable for revocation in this column.
  // Only undecided rounds contribute to Waiting for you and its badge.
  const fromSeat = localRoundViews(loadSeatRounds(key).filter(round => !round.decision
    || (round.nativeAssociation && nativeAssociationDecisionApproves(round.decision) && nativeAssociationCurrent(round.nativeAssociation))), null);
  return { project: key, decisions: [...fromTasks, ...fromSeat].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
}

/** One round of a project by its id, open or answered: a seat's own or a task's. */
export function operatorDecisionRound(project: string, reviewId: string, tasks: readonly BoardTask[] = loadTasks()): OperatorDecisionView | null {
  const key = canonicalProject(project);
  const seat = loadSeatRounds(key).find(round => round.id === reviewId);
  if (seat) return localRoundViews([seat], null)[0]!;
  const task = tasks.find(t => canonicalProject(t.project) === key && t.prototypeReviews?.some(round => round.id === reviewId));
  const round = task ? readPrototypeReviews(task).rounds.find(entry => entry.id === reviewId) : undefined;
  return round && task ? { ...round, taskTitle: firstLineTitle(task.text) } : null;
}

/** The seat's open questions, as notices: one each, beside the tasks' rounds. */
export function seatDecisionNotices(project?: string): PrototypeReviewNotice[] {
  try { return loadSeatRounds(project).filter(round => !round.decision).map(seatRoundNotice); }
  catch { return []; /* The board read never fails on the seat's questions; the column says so on its own read. */ }
}

function prototypeDismissals(): ReadonlyMap<string, AttentionDismissalV1> {
  try { return attentionDismissalIndex(); } catch { return new Map(); }
}
