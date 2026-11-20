import { expect, test } from "bun:test";
import { laneNeedKind, laneRouteKey } from "@/lib/attention/routeTypes";
import { buildPipeline } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import type { PrototypeReviewSummary } from "@/lib/prototypeReview/types";
import { patchTask } from "./commands";
import { TASK_HOLD_KINDS, type BoardTask, type TaskHold, type TaskHoldKind } from "./types";
import { waitingRoute, waitingRouteIndex } from "./waitingRoute";

const NOW = Date.parse("2026-11-20T06:47:00Z");
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const project = "fixture-waiting";

function task(id: string, kind: TaskHoldKind | null, extra?: Partial<TaskHold>): BoardTask {
  return { id, project, text: "Verify fixture work", status: "blocked", placement: "unplaced",
    createdAt: at(-48), updatedAt: at(-48), assignments: [],
    ...(kind ? { hold: { kind, since: at(-48), note: "Wait for fixture", by: "agent", ...extra } } : {}) };
}

function lane(taskId: string, state: Pipeline["state"], extra: Partial<Pipeline> = {}): Pipeline {
  return { ...buildPipeline({ id: `lane-${taskId}`, task: "Work", taskIds: [taskId], project, repoDir: "/fixture/repo",
    stages: [], srcPath: null, srcConversationId: "fixture-seat", now: at(-72) }), state, ...extra };
}

function routed(lane: Pipeline, owner: "seat" | "form" | "system"): Pipeline {
  return { ...lane, attentionRoute: { key: laneRouteKey(lane, laneNeedKind(lane)!), owner,
    ...(owner === "form" ? { form: { taskId: lane.taskIds[0], reviewId: "fixture-round" } } : {}) } };
}

function form(decidedAt?: string): PrototypeReviewSummary {
  return { latestReviewId: "fixture-round", waitingReviewId: decidedAt ? null : "fixture-round", createdAt: at(-72),
    title: "Choose the next step", rounds: 1,
    ...(decidedAt ? { decision: { chosen: [], comment: "", at: decidedAt, delivery: "sent" } } : {}) };
}

const merge = (state: "blocked" | "merged" | "checking") => ({
  state, updatedAt: at(-1), reason: state === "blocked" ? "reviewed checks failed" : undefined,
}) as Pipeline["merge"];

const classify = (row: BoardTask, lanes: Pipeline[] = [], dependencies: BoardTask[] = [], live = false) =>
  waitingRoute(row, waitingRouteIndex([row, ...dependencies], lanes), NOW, live);

test.each(TASK_HOLD_KINDS)("routes %s across lane states", kind => {
  const row = task("waiting", kind);
  const base = kind === "operator" ? { owner: "operator", rule: "operator-hold" } :
    kind === "postponed" ? { owner: "agents", rule: "dated" } :
    { owner: "seat", rule: "unowned", carriedBy: "task" };
  expect(classify(row)).toMatchObject(base);
  const withOpenLane = ["issue", "pr"].includes(kind) ? { owner: "agents", rule: "dependency" } : base;
  const cases: [Pipeline, object][] = [
    [lane(row.id, "running"), { owner: "agents", rule: "running" }],
    [lane(row.id, "provisioning"), { owner: "agents", rule: "running" }],
    [lane(row.id, "draft"), withOpenLane],
    [routed(lane(row.id, "needs_decision"), "seat"), { owner: "seat", rule: "lane-stop", carriedBy: "lane" }],
    [routed(lane(row.id, "needs_review"), "seat"), { owner: "seat", rule: "lane-stop", carriedBy: "lane" }],
    [routed(lane(row.id, "completed", { merge: merge("blocked") }), "seat"), { owner: "seat", rule: "lane-stop", carriedBy: "lane" }],
    [routed(lane(row.id, "needs_decision"), "form"), { owner: "operator", rule: "form" }],
    [routed(lane(row.id, "needs_decision"), "system"), ["issue", "pr"].includes(kind) ? { owner: "agents", rule: "dependency" } :
      kind === "postponed" ? base : { owner: "agents", rule: "lane" }],
    [lane(row.id, "needs_decision", { dismissedAt: at(-1) }), { owner: "seat", rule: "lane-dismissed", carriedBy: "task" }],
    [lane(row.id, "paused", { pause: { reason: "Fixture pause", resumeCondition: { kind: "date", at: at(1) } } }), { owner: "agents", rule: "dated" }],
    [lane(row.id, "paused", { pause: { reason: "Fixture pause", resumeCondition: { kind: "date", at: at(-1) } } }), { owner: "seat", rule: "pause-ready", carriedBy: "lane" }],
    [lane(row.id, "paused", { pausedAt: at(-24) }), { owner: "seat", rule: "pause-ready", carriedBy: "lane" }],
    [lane(row.id, "paused", { pausedAt: at(-1) }), ["issue", "pr"].includes(kind) ? { owner: "agents", rule: "dependency" } :
      kind === "postponed" ? base : { owner: "agents", rule: "lane" }],
    [lane(row.id, "completed", { merge: merge("merged") }), kind === "postponed" ? base :
      { owner: "seat", rule: "unowned", carriedBy: "task", action: expect.stringContaining("deployment_status") }],
    [lane(row.id, "completed", { merge: merge("checking") }), { owner: "agents", rule: "running" }],
    [lane(row.id, "completed"), base],
    [lane(row.id, "closed", { closedAt: at(-2) }), base],
  ];
  for (const [pipeline, expected] of cases) {
    const owner = pipeline.attentionRoute?.owner === "form" || kind !== "operator" ? expected : base;
    expect(classify(row, [pipeline])).toMatchObject(owner);
  }
  expect(classify(row, [], [], true)).toMatchObject(kind === "operator" ? base : { owner: "agents", rule: "running" });
});

test("structured dates and refs tell a cleared wait from an open prerequisite", () => {
  const dependency = { ...task("aabbccdd", null), status: "assigned" as const };
  const held = task("ref", "task", { ref: dependency.id });
  const finished = { owner: "seat", rule: "wait-cleared", carriedBy: "task" };
  expect(classify(held, [], [dependency])).toMatchObject({ owner: "agents", rule: "dependency" });
  expect(classify(held, [], [{ ...dependency, status: "done" }])).toMatchObject(finished);
  expect(classify(held)).toMatchObject(finished);
  expect(classify(task("ref", "task", { ref: "unknown prerequisite" }))).toMatchObject({ owner: "seat", rule: "unowned" });
  const referencedLane = lane("other-task", "running");
  const onLane = task("ref", "task", { ref: referencedLane.id });
  expect(classify(onLane, [referencedLane])).toMatchObject({ owner: "agents", rule: "dependency" });
  expect(classify(onLane, [{ ...referencedLane, state: "completed" }])).toMatchObject(finished);
  for (const kind of ["limit", "postponed"] as const) {
    expect(classify(task(kind, kind, { until: at(1) }))).toMatchObject({ owner: "agents", rule: "dated" });
    expect(classify(task(kind, kind, { until: at(-1) }))).toMatchObject(finished);
  }
});

test("operator forms and provenance take priority, and an answered form goes back once", () => {
  const row = task("form", "operator");
  const running = lane(row.id, "running");
  expect(classify({ ...row, prototypeReview: form() }, [running])).toEqual({ owner: "operator", rule: "form" });
  expect(classify({ ...row, prototypeReview: form(at(-60)) }, [running])).toEqual({ owner: "operator", rule: "operator-hold" });
  const answered = { ...row, prototypeReview: form(at(-1)) };
  expect(classify(answered, [running])).toMatchObject({ owner: "seat", rule: "form-answered", carriedBy: "task", action: expect.stringContaining("fixture-round") });
  expect(classify(task("operator-written", "resource", { by: "operator" }), [running])).toEqual({ owner: "operator", rule: "operator-written" });
  expect(classify(task("old-status", null))).toMatchObject({ owner: "seat", rule: "unowned" });
  expect(classify({ ...row, status: "done" })).toBeNull();
  expect(classify({ ...task("open", null), status: "assigned" })).toBeNull();
  const revised = patchTask([answered], answered.id, { hold: { kind: "operator", note: "Supply a different setting" } }, at(0), { actor: "agent" });
  if (!revised.ok) throw new Error(revised.error);
  expect(classify(revised.task)).toEqual({ owner: "operator", rule: "operator-hold" });
});

test("changed routing evidence earns a new key while edits to the title or hold note preserve it", () => {
  const row = task("evidence", "task", { ref: "old prerequisite" });
  const changed = (hold: Partial<TaskHold>) => ({ ...row, hold: { ...row.hold!, ...hold } });
  const key = (route: ReturnType<typeof classify>) => route?.owner === "seat" ? route.key : null;
  expect(key(classify(row))).toMatch(/^task:evidence:unowned:/);
  expect(key(classify({ ...changed({ note: "New wording" }), text: "Rename the card" }))).toBe(key(classify(row)));
  expect(key(classify(changed({ ref: "different prerequisite" })))).not.toBe(key(classify(row)));
  expect(key(classify(changed({ since: at(-1) })))).not.toBe(key(classify(row)));
  expect(key(classify(row, [lane(row.id, "closed")]))).not.toBe(key(classify(row)));
  const answered = { ...task("form", "operator"), prototypeReview: form(at(-1)) };
  expect(key(classify({ ...answered, prototypeReview: { ...answered.prototypeReview, latestReviewId: "other-round" } }))).not.toBe(key(classify(answered)));
});

test("dry run over 111 synthetic Waiting cards reproduces the design counts", () => {
  const dependency = { ...task("open-dependency", null), status: "assigned" as const };
  const closed = { ...task("closed-dependency", null), status: "done" as const };
  const rows: BoardTask[] = [];
  const lanes: Pipeline[] = [];
  const live = new Set<string>();
  function add(kind: TaskHoldKind, count: number, configure: (row: BoardTask, i: number) => void = () => {}) {
    for (let i = 0; i < count; i++) {
      const row = task(`sample-${rows.length}`, kind);
      rows.push(row);
      configure(row, i);
    }
  }
  const operatorLanes = ["running", "running", "running", "needs_decision", "needs_decision", "needs_decision",
    "paused", "paused", "paused", "paused", "completed"] as const;
  add("operator", 11, (row, i) => { lanes.push(lane(row.id, operatorLanes[i]!)); });
  add("operator", 6, (row, i) => {
    row.prototypeReview = form(at(-1));
    if (i < 4) lanes.push(lane(row.id, "completed"));
  });
  for (const [kind, count] of [["task", 6], ["external", 15], ["resource", 4], ["pr", 2], ["worker", 2], ["unstated", 1]] as const) {
    add(kind, count, row => { lanes.push(routed(lane(row.id, "needs_decision"), "seat")); });
  }
  add("task", 1, row => { lanes.push(lane(row.id, "completed", { merge: merge("blocked"), dismissedAt: at(0) })); });
  for (const kind of ["task", "external"] as const) {
    add(kind, 2, row => { lanes.push(lane(row.id, "paused", { pausedAt: at(-36) })); });
  }
  add("external", 2, row => {
    row.hold!.ref = closed.id;
    lanes.push(lane(row.id, "completed"));
  });
  add("postponed", 1, row => {
    row.hold!.until = at(-1);
    lanes.push(lane(row.id, "completed"));
  });
  add("task", 2);
  add("external", 20, (row, i) => {
    if (i < 13) lanes.push(lane(row.id, "completed", i < 11 ? { merge: merge("merged") } : {}));
  });
  add("resource", 4, (row, i) => { if (i < 2) lanes.push(lane(row.id, "completed")); });
  add("pr", 1, row => { lanes.push(lane(row.id, "completed")); });
  add("external", 2, (row, i) => {
    lanes.push(lane(row.id, i === 0 ? "running" : "needs_decision"));
    if (i === 1) live.add(row.id);
  });
  add("postponed", 6, (row, i) => {
    if (i % 2 === 0) row.hold!.until = at(12);
    if (i < 3) lanes.push(lane(row.id, "completed"));
  });
  add("task", 21, (row, i) => {
    row.hold!.ref = dependency.id;
    if (i < 13) lanes.push(lane(row.id, "completed"));
  });

  expect(rows).toHaveLength(111);
  expect(lanes.filter(lane => lane.state === "running")).toHaveLength(4);
  expect(lanes.filter(lane => lane.state === "needs_decision")).toHaveLength(34);
  expect(lanes.filter(lane => lane.state === "paused")).toHaveLength(8);
  expect(lanes.filter(lane => lane.state === "completed")).toHaveLength(41);
  expect(rows.length - lanes.length).toBe(24);
  const index = waitingRouteIndex([...rows, dependency, closed], lanes);
  const outcomes = { operator: 0, answered: 0, task: 0, lane: 0, agents: 0 };
  const rules = new Map<string, number>();
  let acceptance = 0;
  for (const row of rows) {
    const route = waitingRoute(row, index, NOW, live.has(row.id))!;
    rules.set(route.rule, (rules.get(route.rule) ?? 0) + 1);
    if (route.owner !== "seat") outcomes[route.owner]++;
    else if (route.rule === "form-answered") outcomes.answered++;
    else outcomes[route.carriedBy]++;
    if (route.owner === "seat" && route.action.includes("deployment_status")) acceptance++;
  }
  expect(outcomes).toEqual({ operator: 11, answered: 6, task: 31, lane: 34, agents: 29 });
  expect(Object.fromEntries(rules)).toEqual({ "operator-hold": 11, "form-answered": 6, "lane-stop": 30, "lane-dismissed": 1,
    "pause-ready": 4, "wait-cleared": 3, unowned: 27, running: 2, dated: 6, dependency: 21 });
  expect(acceptance).toBe(11);
});
