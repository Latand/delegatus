import { laneRouteNow, laneWaitCleared } from "@/lib/attention/routeTypes";
import type { PullRequestState } from "@/lib/forge/workLinks";
import { indexMergeSuccessors, mergeSuccessor } from "@/lib/pipelines/mergeSuccessor";
import { pausedByOperator, pauseReminderDue } from "@/lib/pipelines/pauseReminder";
import type { Pipeline } from "@/lib/pipelines/types";
import { deriveTaskSteps } from "./steps";
import { currentPrototypeSummary, prototypeReviewSummary, prototypeRoundsSuperseded, prototypeWaitsOnOperator } from "@/lib/prototypeReview/model";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { resolveHoldFormRef, taskFormIds } from "./hold";
import type { BoardTask } from "./types";

type SeatRule = "lane-stop" | "lane-dismissed" | "pause-ready" | "wait-cleared" | "unowned" | "form-answered";

export type WaitingRoute =
  | { owner: "operator"; rule: "form" | "operator-hold" | "operator-written" }
  | { owner: "seat"; rule: SeatRule; why: string; action: string; key: string } & (
    { carriedBy: "task" } | { carriedBy: "lane"; laneId: string })
  | { owner: "agents"; rule: "running" | "dated" | "dependency" | "lane"; action: string };

type WaitingTask = Pick<BoardTask, "id" | "project" | "status" | "hold" | "steps" | "prototypeReview" | "prototypeReviews" | "prototypeReviewReplica" | "doneAt" | "updatedAt">;

export type HoldPullRequestState = (taskId: string, ref: string) => PullRequestState | undefined;

/** A published decision round as the routing pass reads it: where it lives and
    whether it still waits. An answered or retired round names the round that
    carries the answer. */
export type PublishedRound = { project: string } & ({ open: true } | { open: false; answeredBy: string });
export type PublishedRoundLookup = ((reviewId: string) => PublishedRound | undefined) & {
  formIds?: (project: string, prefix: string) => Iterable<string>;
};

/** Every round of one task, from its stored history or the summary it carries. */
function taskRounds(task: Pick<BoardTask, "prototypeReview" | "prototypeReviews" | "prototypeReviewReplica" | "status" | "doneAt" | "updatedAt">): Map<string, { open: true } | { open: false; answeredBy: string }> {
  const history = task.prototypeReviews ?? task.prototypeReviewReplica?.rounds ?? [];
  const summary = currentPrototypeSummary(task.prototypeReview ?? prototypeReviewSummary(task.prototypeReviews ?? []) ?? task.prototypeReviewReplica?.summary);
  const rounds = new Map<string, { open: true } | { open: false; answeredBy: string }>();
  for (const [id, answeredBy] of prototypeRoundsSuperseded(history)) rounds.set(id, { open: false, answeredBy });
  for (const round of history) if (round.decision) rounds.set(round.id, { open: false, answeredBy: round.id });
  if (summary?.decision && !rounds.has(summary.latestReviewId)) rounds.set(summary.latestReviewId, { open: false, answeredBy: summary.latestReviewId });
  if (summary?.waitingReviewId && prototypeWaitsOnOperator(summary, task)) rounds.set(summary.waitingReviewId, { open: true });
  return rounds;
}

interface ReadyPauses {
  quota?: ReadonlySet<string>;
  deploy?: ReadonlySet<string>;
}

/** Index the same snapshot once for the whole project's routing pass. */
export function waitingRouteIndex(
  tasks: readonly (Pick<BoardTask, "id" | "status" | "assignments" | "hold"> & Partial<WaitingTask>)[],
  pipelines: readonly Pipeline[],
  liveAssignments: ReadonlySet<string> = new Set(),
  readyPauses: ReadyPauses = {},
  pullRequestState?: HoldPullRequestState,
  seatRound?: PublishedRoundLookup,
) {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  // Index every task's rounds once, and only when an operator hold names one.
  const roundOwners = new Map<string, PublishedRound>();
  const formIdsByProject = new Map<string, Set<string>>();
  let roundsIndexed = false;
  function indexRounds() {
    if (roundsIndexed) return;
    roundsIndexed = true;
    for (const task of tasks) {
      if ((!task.prototypeReview && !task.prototypeReviews?.length && !task.prototypeReviewReplica) || !task.project) continue;
      for (const [id, state] of taskRounds(task as WaitingTask)) roundOwners.set(id, { project: task.project, ...state });
      const project = canonicalOrchestratorProject(task.project);
      let ids = formIdsByProject.get(project);
      if (!ids) formIdsByProject.set(project, ids = new Set());
      for (const id of taskFormIds(task)) ids.add(id);
    }
  }
  const publishedRound = (reviewId: string) => {
    indexRounds();
    return roundOwners.get(reviewId) ?? seatRound?.(reviewId);
  };
  const resolveFormRef = (ref: string, project: string) => resolveHoldFormRef(ref, function* (prefix) {
    indexRounds();
    const key = canonicalOrchestratorProject(project);
    yield* formIdsByProject.get(key) ?? [];
    yield* seatRound?.formIds?.(key, prefix) ?? [];
  });
  const lanesById = new Map<string, Pipeline>();
  const lanesByTask = new Map<string, Set<Pipeline>>();
  const successors = indexMergeSuccessors(pipelines);
  for (const lane of pipelines) {
    const owner = mergeSuccessor(lane, successors) ?? lane;
    lanesById.set(lane.id, owner);
    for (const taskId of lane.taskIds ?? []) {
      let linked = lanesByTask.get(taskId);
      if (!linked) lanesByTask.set(taskId, linked = new Set());
      linked.add(owner);
    }
  }
  // Cache only the prerequisite chains reached by this routing pass.
  const cyclic = new Map<string, boolean>();
  function hasCircularPrerequisite(id: string): boolean {
    const path = new Set<string>();
    let current = id;
    while (!cyclic.has(current) && !path.has(current)) {
      const task = tasksById.get(current);
      const hold = task?.hold;
      if (task?.status === "done" || hold?.kind !== "task" || !hold.ref) {
        cyclic.set(current, false);
        break;
      }
      path.add(current);
      current = hold.ref;
    }
    const result = cyclic.get(current) ?? true;
    for (const visited of path) cyclic.set(visited, result);
    return result;
  }
  return { tasksById, lanesById, lanesByTask, liveAssignments, readyPauses, pullRequestState, publishedRound, resolveFormRef, hasCircularPrerequisite };
}

function laneOpen(lane: Pipeline): boolean {
  // Engine completion stamps closedAt before merge settlement. A blocked merge
  // remains actionable even when the stage lifecycle is already closed.
  if (lane.hiddenAt || lane.state === "closed" || laneWaitCleared(lane)) return false;
  if (lane.state !== "completed") return true;
  return !!lane.merge && lane.merge.state !== "merged" && lane.merge.state !== "cancelled";
}

const laneActive = (lane: Pipeline) => laneOpen(lane) &&
  (lane.state === "running" || lane.state === "provisioning" ||
    lane.state === "completed" && lane.merge?.state !== "blocked");

// A compact, synchronous digest for the delivered-ask ledger. The input is
// structured routing evidence and deliberately excludes titles and hold notes.
function waitDigest(value: unknown): string {
  const data = JSON.stringify(value);
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  for (let index = 0; index < data.length; index++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(data.charCodeAt(index))) * prime);
  }
  return hash.toString(16);
}

/** Who can take the next step on an open held or Waiting task. Clock in ms. */
export function waitingRoute(task: WaitingTask, input: ReturnType<typeof waitingRouteIndex>, now: number, liveMember = false): WaitingRoute | null {
  const { hold } = task;
  if (task.status === "done" || (!hold && task.status !== "blocked")) return null;

  const lanes = [...(input.lanesByTask.get(task.id) ?? [])];
  const form = currentPrototypeSummary(task.prototypeReview ?? prototypeReviewSummary(task.prototypeReviews ?? []) ?? task.prototypeReviewReplica?.summary);
  const open = lanes.filter(laneOpen);
  const routed = open.map(lane => ({ lane, route: laneRouteNow(lane) }));
  const decision = form?.decision ? { id: form.latestReviewId, at: form.decision.at } : null;
  const seat = (rule: SeatRule, why: string, action: string, lane?: Pipeline): WaitingRoute => {
    const state = lanes.map(lane => [lane.id, lane.state, lane.closedAt, lane.dismissedAt,
      lane.merge?.state, laneRouteNow(lane)?.key, laneRouteNow(lane)?.returnedFrom,
      lane.pausedAt, lane.pause?.resumeCondition] as const).sort((a, b) => a[0].localeCompare(b[0]));
    const key = `task:${task.id}:${rule}:${waitDigest([hold?.kind, hold?.since, hold?.ref, hold?.until, state,
      decision])}`;
    return { owner: "seat", rule, why, action, key, ...(lane ? { carriedBy: "lane", laneId: lane.id } : { carriedBy: "task" }) };
  };
  const cleared = () => seat("wait-cleared", "its recorded prerequisite cleared", "Start or continue the work, then clear the hold.");

  if (prototypeWaitsOnOperator(form, task) || routed.some(({ route }) => route?.owner === "form")) return { owner: "operator", rule: "form" };
  if (hold?.kind === "operator") {
    const answered = (reviewId: string) => seat("form-answered", "the operator answered the task’s decision form",
      `Read round ${reviewId} with read_prototype_review and carry out the answer. Clear the hold or set a new one naming the operator’s next action.`);
    if (decision && !hold.ref && Date.parse(decision.at) > Date.parse(hold.since)) return answered(decision.id);
    if (hold.ref) {
      const ref = hold.ref;
      const resolved = input.resolveFormRef(ref, task.project);
      if (resolved?.kind === "ambiguous") return seat("unowned", "its operator hold has an ambiguous form ID prefix",
        "Check the intended form and record its full ID.");
      if (resolved?.kind === "unavailable") return seat("unowned", "its operator hold form ID could not be resolved",
        "Check the intended form and record its full ID.");
      const formId = resolved?.value ?? ref;
      const ownRound = taskRounds(task).get(formId);
      if (ownRound && !ownRound.open) return answered(ownRound.answeredBy);
      if (formId === form?.latestReviewId) return cleared();
      const published = input.publishedRound(formId);
      if (published && canonicalOrchestratorProject(published.project) === canonicalOrchestratorProject(task.project)) {
        return published.open ? { owner: "operator", rule: "operator-hold" } : answered(published.answeredBy);
      }
      const step = task.steps?.find(step => step.id === formId);
      if (step) {
        // The card's own lanes decide a linked step, as on the board.
        const derived = deriveTaskSteps([step], lanes, now).steps[0];
        return derived?.effectiveState === "open" ? { owner: "operator", rule: "operator-hold" } : cleared();
      }
      if (resolved?.kind === "none") return seat("unowned", "its operator hold has an unknown form ID prefix",
        "Check the intended form and record its full ID, or resume the task.");
      return seat("unowned", "its operator hold no longer points to a published form or open step",
        "Verify the wait now. Resume it or publish a new decision form or name an open step for the operator action.");
    }
    if (!hold.note.trim()) return seat("unowned", "its operator hold names no action", "Review the wait and either move it back to work or name the operator action or publish an outstanding decision form.");
    return { owner: "operator", rule: "operator-hold" };
  }
  if (open.some(laneActive) || liveMember) return { owner: "agents", rule: "running", action: "Let the current work continue." };
  const stopped = routed.find(({ route }) => route?.owner === "seat");
  if (stopped) return seat("lane-stop", "its lane waits on the seat", "Follow the lane’s wake item and move the task out of Waiting.", stopped.lane);
  const paused = open.filter(lane => lane.state === "paused");
  const due = paused.find(lane => !pausedByOperator(lane) && (input.readyPauses.deploy?.has(lane.id)
    || pauseReminderDue(lane.pause, lane.pausedAt ?? lane.createdAt, now, input.readyPauses.quota?.has(lane.id))));
  if (due) return seat("pause-ready", "its lane’s pause needs review", "Review the pause and use pipeline_action resume when ready.", due);
  const until = Date.parse(hold?.until ?? "");
  const ref = hold?.kind === "task" || hold?.kind === "external" ? hold.ref : undefined;
  const dependency = ref && ref !== task.id ? input.tasksById.get(ref) : undefined;
  const dependencyLane = ref && !dependency ? input.lanesById.get(ref) : undefined;
  // A stored entity id whose record vanished is different from free-form
  // dependency text that never identified a record.
  const gone = hold?.kind === "task" && ref && ref !== task.id && !dependency && !dependencyLane
    && /^(?:[a-f0-9]{8}|[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(ref);
  const pr = hold?.kind === "pr" && hold.ref ? input.pullRequestState?.(task.id, hold.ref) : undefined;
  if (until <= now || dependency?.status === "done" || dependencyLane && !laneOpen(dependencyLane) || gone
    || pr === "merged" || pr === "closed") return cleared();
  // A lane's own pause is kept; it never hides a prerequisite that already cleared.
  if (paused.some(lane => lane.pause?.resumeCondition?.kind === "date" && Date.parse(lane.pause.resumeCondition.at) > now)) {
    return { owner: "agents", rule: "dated", action: "Wait for the lane’s resume date." };
  }
  if (until > now) return { owner: "agents", rule: "dated", action: "Keep the recorded postponement or reset time." };
  const dependencyHasOwner = !!dependency && (dependency.assignments.some(a => a.state === "spawning" && !a.conversationId
    || input.liveAssignments.has(a.conversationId ?? "") || input.liveAssignments.has(a.path ?? ""))
    || [...(input.lanesByTask.get(dependency.id) ?? [])].some(laneActive))
    || !!dependencyLane && laneActive(dependencyLane);
  if (dependencyHasOwner || hold?.kind === "task" && dependency && !input.hasCircularPrerequisite(dependency.id)
    || pr === "open" || pr === "draft"
    || open.length && (hold?.kind === "pr" || hold?.kind === "issue")) {
    return { owner: "agents", rule: "dependency", action: "Keep the hold while its prerequisite is open." };
  }
  // Dismissal settles a lane wait. A recorded task prerequisite can still carry the task.
  if (!open.length && lanes.some(laneWaitCleared)) {
    return seat("lane-dismissed", "its lane wait was dismissed", "Start the next step or close the task with a note.");
  }
  if (hold?.kind === "postponed") return { owner: "agents", rule: "dated", action: "Keep the recorded postponement or reset time." };
  if (lanes.length && !open.length && lanes.some(lane => lane.merge?.state === "merged")) {
    return seat("unowned", "its lanes settled and work merged", "Check acceptance on the running build with deployment_status. Close the task or name what remains.");
  }
  if (paused.length || routed.some(({ route }) => route?.owner === "system")) {
    return { owner: "agents", rule: "lane", action: "Keep the hold while the lane’s pause or retry is pending." };
  }
  return seat("unowned", "no live owner carries this wait",
    "Verify the wait now. Resume it or give the hold a ref or until. If only the operator can act, publish a decision form on this task and set an operator hold.");
}
