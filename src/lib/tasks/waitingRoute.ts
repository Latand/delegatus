import { laneRouteNow, laneWaitCleared } from "@/lib/attention/routeTypes";
import { indexMergeSuccessors, mergeSuccessor } from "@/lib/pipelines/mergeSuccessor";
import { pausedByOperator, pauseReminderDue } from "@/lib/pipelines/pauseReminder";
import type { Pipeline } from "@/lib/pipelines/types";
import { currentPrototypeSummary, prototypeReviewSummary, prototypeWaitsOnOperator } from "@/lib/prototypeReview/model";
import type { BoardTask } from "./types";

type SeatRule = "lane-stop" | "lane-dismissed" | "pause-ready" | "wait-cleared" | "unowned" | "form-answered";

export type WaitingRoute =
  | { owner: "operator"; rule: "form" | "operator-hold" | "operator-written" }
  | { owner: "seat"; rule: SeatRule; why: string; action: string; key: string } & (
    { carriedBy: "task" } | { carriedBy: "lane"; laneId: string })
  | { owner: "agents"; rule: "running" | "dated" | "dependency" | "lane"; action: string };

type WaitingTask = Pick<BoardTask, "id" | "status" | "hold" | "prototypeReview" | "prototypeReviews" | "prototypeReviewReplica" | "doneAt" | "updatedAt">;

/** Index the same snapshot once for the whole project's routing pass. */
export function waitingRouteIndex(tasks: readonly Pick<BoardTask, "id" | "status" | "assignments">[], pipelines: readonly Pipeline[]) {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
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
  return { tasksById, lanesById, lanesByTask };
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

  if (prototypeWaitsOnOperator(form, task) || routed.some(({ route }) => route?.owner === "form")) return { owner: "operator", rule: "form" };
  if (hold?.kind === "operator") {
    if (decision && Date.parse(decision.at) > Date.parse(hold.since)) {
      return seat("form-answered", "the operator answered the task’s decision form",
        `Read round ${decision.id} with read_prototype_review and carry out the answer. Clear the hold or set a new one naming the operator’s next action.`);
    }
    if (!hold.note.trim()) return seat("unowned", "its operator hold names no action", "Review the wait and either move it back to work or name the operator action or publish an outstanding decision form.");
    return { owner: "operator", rule: "operator-hold" };
  }
  if (open.some(laneActive) || liveMember) return { owner: "agents", rule: "running", action: "Let the current work continue." };
  const stopped = routed.find(({ route }) => route?.owner === "seat");
  if (stopped) return seat("lane-stop", "its lane waits on the seat", "Follow the lane’s wake item and move the task out of Waiting.", stopped.lane);
  const paused = open.filter(lane => lane.state === "paused");
  const due = paused.find(lane => !pausedByOperator(lane) && pauseReminderDue(lane.pause, lane.pausedAt ?? lane.createdAt, now));
  if (due) return seat("pause-ready", "its lane’s pause needs review", "Review the pause and use pipeline_action resume when ready.", due);
  if (paused.some(lane => lane.pause?.resumeCondition?.kind === "date" && Date.parse(lane.pause.resumeCondition.at) > now)) {
    return { owner: "agents", rule: "dated", action: "Wait for the lane’s resume date." };
  }
  if (!open.length && lanes.some(laneWaitCleared)) {
    return seat("lane-dismissed", "its lane wait was dismissed", "Start the next step or close the task with a note.");
  }

  const until = Date.parse(hold?.until ?? "");
  const ref = hold?.kind === "task" || hold?.kind === "external" ? hold.ref : undefined;
  const dependency = ref && ref !== task.id ? input.tasksById.get(ref) : undefined;
  const dependencyLane = ref && !dependency ? input.lanesById.get(ref) : undefined;
  // A stored entity id whose record vanished is different from free-form
  // dependency text that never identified a record.
  const gone = hold?.kind === "task" && ref && ref !== task.id && !dependency && !dependencyLane
    && /^(?:[a-f0-9]{8}|[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(ref);
  if (until <= now || dependency?.status === "done" || dependencyLane && !laneOpen(dependencyLane) || gone) {
    return seat("wait-cleared", "its recorded prerequisite cleared", "Start or continue the work, then clear the hold.");
  }
  if (until > now || hold?.kind === "postponed") return { owner: "agents", rule: "dated", action: "Keep the recorded postponement or reset time." };
  const dependencyHasOwner = !!dependency && (dependency.assignments.some(a => a.state === "delivered" || a.state === "spawning" || a.state === "handoff")
    || dependency.status === "blocked" && [...(input.lanesByTask.get(dependency.id) ?? [])].some(laneActive))
    || !!dependencyLane && laneActive(dependencyLane);
  if (dependencyHasOwner || open.length && (hold?.kind === "pr" || hold?.kind === "issue")) {
    return { owner: "agents", rule: "dependency", action: "Keep the hold while its prerequisite is open." };
  }
  if (paused.length || routed.some(({ route }) => route?.owner === "system")) {
    return { owner: "agents", rule: "lane", action: "Keep the hold while the lane’s pause or retry is pending." };
  }
  if (lanes.length && !open.length && lanes.some(lane => lane.merge?.state === "merged")) {
    return seat("unowned", "its lanes settled and work merged", "Check acceptance on the running build with deployment_status. Close the task or name what remains.");
  }
  return seat("unowned", "no live owner carries this wait",
    "Verify the wait now. Resume it or give the hold a ref or until. If only the operator can act, publish a decision form on this task and set an operator hold.");
}
