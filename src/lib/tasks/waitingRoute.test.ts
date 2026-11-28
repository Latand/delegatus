import { expect, test } from "bun:test";
import { laneNeedKind, laneRouteKey } from "@/lib/attention/routeTypes";
import { seatAgendaAsks } from "@/lib/attention/seatAgenda";
import { buildPipeline } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import type { PrototypeReviewSummary } from "@/lib/prototypeReview/types";
import { patchTask } from "./commands";
import { TASK_HOLD_KINDS, type BoardTask, type TaskHold, type TaskHoldKind } from "./types";
import { waitingRoute, waitingRouteIndex, type HoldPullRequestState, type PublishedRound } from "./waitingRoute";
import { prototypeReviewSummary } from "@/lib/prototypeReview/model";

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

const classify = (row: BoardTask, lanes: Pipeline[] = [], dependencies: BoardTask[] = [], live = false, liveAssignments: ReadonlySet<string> = new Set()) =>
  waitingRoute(row, waitingRouteIndex([row, ...dependencies], lanes, liveAssignments), NOW, live);

test.each([...TASK_HOLD_KINDS])("routes %s across lane states", kind => {
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
    [routed(lane(row.id, "completed", { closedAt: at(-1), merge: merge("blocked") }), "seat"), { owner: "seat", rule: "lane-stop", carriedBy: "lane" }],
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
  const owningLane = lane(dependency.id, "running");
  expect(classify(held, [owningLane], [dependency])).toMatchObject({ owner: "agents", rule: "dependency" });
  expect(classify(held, [{ ...owningLane, state: "closed" }], [dependency])).toMatchObject({ owner: "agents", rule: "dependency" });
  const assigned = { ...dependency, assignments: [{
    state: "delivered" as const, path: null, conversationId: "conversation_live", panePid: null, error: null, at: at(0),
  }] };
  expect(classify(held, [], [assigned])).toMatchObject({ owner: "agents", rule: "dependency" });
  expect(classify(held, [], [assigned], false, new Set(["conversation_live"]))).toMatchObject({ owner: "agents", rule: "dependency" });
  expect(classify(held, [], [{ ...dependency, status: "inbox" }])).toMatchObject({ owner: "agents", rule: "dependency" });
  expect(classify(task("self", "task", { ref: "self" }))).toMatchObject({ owner: "seat", rule: "unowned", carriedBy: "task" });
  const cycleA = task("cycle-a", "task", { ref: "cycle-b" });
  const cycleB = task("cycle-b", "task", { ref: "cycle-a" });
  const cycleIndex = waitingRouteIndex([cycleA, cycleB], []);
  for (const row of [cycleA, cycleB]) {
    expect(waitingRoute(row, cycleIndex, NOW)).toMatchObject({ owner: "seat", rule: "unowned", carriedBy: "task" });
  }
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
  expect(classify(task("operator-written", "resource", { by: "operator" }))).toMatchObject({ owner: "seat", rule: "unowned", carriedBy: "task" });
  expect(classify(task("elapsed-operator-limit", "limit", { by: "operator", until: at(-1) }))).toMatchObject({ owner: "seat", rule: "wait-cleared" });
  expect(classify(task("old-status", null))).toMatchObject({ owner: "seat", rule: "unowned" });
  expect(classify({ ...row, status: "done" })).toBeNull();
  expect(classify({ ...task("open", null), status: "assigned" })).toBeNull();
  const revised = patchTask([answered], answered.id, { hold: { kind: "operator", note: "Supply a different setting" } }, at(0), { actor: "agent" });
  if (!revised.ok) throw new Error(revised.error);
  expect(classify(revised.task)).toEqual({ owner: "operator", rule: "operator-hold" });
});

const roundRows = (...rows: Array<[string, boolean]>) => rows.map(([id, decided], index) => ({ id, title: id, createdAt: at(-10 + index), variants: [],
  ...(decided ? { decision: { chosen: [], comment: "Proceed", at: at(-5 + index), delivery: { state: "sent" } } } : {}) })) as never;

test("operator holds route through published seat forms by their stored state", () => {
  const row = task("seat-form-hold", "operator", { ref: "seat-round", note: "Choose the release option" });
  const dismissed = lane(row.id, "needs_decision", { dismissedAt: at(-1) });
  const routeWith = (round: PublishedRound | undefined) =>
    waitingRoute(row, waitingRouteIndex([row], [dismissed], new Set(), {}, undefined, id => id === "seat-round" ? round : undefined), NOW);
  expect(routeWith({ project, open: true })).toEqual({ owner: "operator", rule: "operator-hold" });
  expect(routeWith({ project, open: false, answeredBy: "seat-round" })).toMatchObject({ owner: "seat", rule: "form-answered", carriedBy: "task", action: expect.stringContaining("seat-round") });
  expect(routeWith({ project: "another-project", open: true })).toMatchObject({ owner: "seat", rule: "unowned" });
  expect(routeWith(undefined)).toMatchObject({ owner: "seat", rule: "unowned" });
});

test("a pending form on another task of the same project carries the hold; an absent or foreign round does not", () => {
  const holder = task("round-holder", "operator", { ref: "round-elsewhere", note: "Choose the option" });
  const owner = { ...task("round-owner", null), status: "assigned" as const, prototypeReview: { latestReviewId: "round-elsewhere", waitingReviewId: "round-elsewhere",
    createdAt: at(-3), title: "Choose", rounds: 1 } };
  const dismissed = lane(holder.id, "needs_decision", { dismissedAt: at(-1) });
  const route = (rows: BoardTask[]) => waitingRoute(holder, waitingRouteIndex(rows, [dismissed]), NOW);
  expect(route([holder, owner])).toEqual({ owner: "operator", rule: "operator-hold" });
  expect(route([holder])).toMatchObject({ owner: "seat", rule: "unowned" });
  expect(route([holder, { ...owner, project: "another-project" }])).toMatchObject({ owner: "seat", rule: "unowned" });
  const answered = { ...owner, prototypeReview: { ...owner.prototypeReview, waitingReviewId: null, decision: { chosen: [], comment: "", at: at(-1), delivery: "sent" as const } } };
  expect(route([holder, answered])).toMatchObject({ owner: "seat", rule: "form-answered", action: expect.stringContaining("round-elsewhere") });
});

test("a retired round returns the seat to the round that carries the answer, and an answered round to itself", () => {
  const route = (ref: string, history: ReturnType<typeof roundRows>) => {
    const row = { ...task("retired-round-hold", "operator", { ref }), prototypeReviews: history } as BoardTask;
    row.prototypeReview = prototypeReviewSummary(history);
    return waitingRoute(row, waitingRouteIndex([row], [lane(row.id, "needs_decision", { dismissedAt: at(-1) })]), NOW);
  };
  const superseded = roundRows(["round-a", false], ["round-b", true]);
  expect(route("round-a", superseded)).toMatchObject({ owner: "seat", rule: "form-answered", action: expect.stringContaining("round-b") });
  expect(route("round-a", superseded)).toMatchObject({ action: expect.not.stringContaining("round-a") });
  expect(route("round-b", superseded)).toMatchObject({ rule: "form-answered", action: expect.stringContaining("round-b") });
  const bothAnswered = roundRows(["round-a", true], ["round-b", true]);
  expect(route("round-a", bothAnswered)).toMatchObject({ rule: "form-answered", action: expect.stringContaining("round-a") });
  expect(route("round-b", bothAnswered)).toMatchObject({ rule: "form-answered", action: expect.stringContaining("round-b") });
});

test("a seat round answered through the real store points to the saved answer after delivery", async () => {
  const { clearSeatRoundsForTests, insertSeatRound, mutateSeatRound } = await import("@/lib/prototypeReview/seatRounds");
  const { seatRoundLookup } = await import("./holdEvidence");
  const id = `pr_${"f".repeat(32)}`;
  const row = task("seat-round-hold", "operator", { ref: id, note: "Choose the release option" });
  const dismissed = lane(row.id, "needs_decision", { dismissedAt: at(-1) });
  const notice = { id: `prototype:${id}`, project, taskId: null, reviewId: id, title: "Choose", createdAt: at(-3),
    target: { kind: "seat-decision", project, reviewId: id } } as const;
  clearSeatRoundsForTests();
  try {
    insertSeatRound({ id, taskId: null, project, title: "Choose", createdAt: at(-3), publicationKey: "seat-hold", inputDigest: "fixture", source: { conversationId: null }, variants: [] });
    const route = (notices: readonly (typeof notice)[]) => waitingRoute(row, waitingRouteIndex([row], [dismissed], new Set(), {}, undefined, seatRoundLookup(notices)), NOW);
    expect(route([notice])).toEqual({ owner: "operator", rule: "operator-hold" });
    expect(route([])).toMatchObject({ owner: "seat", rule: "unowned" });
    mutateSeatRound(id, round => { round.decision = { chosen: [], comment: "Proceed", at: at(-1), delivery: { state: "pending", clientMessageId: "a", conversationId: null, text: "" } } as never; });
    mutateSeatRound(id, round => { round.decision!.delivery = { ...round.decision!.delivery, state: "sent" } as never; });
    // A delivered answer leaves no notice behind; the store still holds it.
    expect(route([])).toMatchObject({ owner: "seat", rule: "form-answered", action: expect.stringContaining(id) });
  } finally { clearSeatRoundsForTests(); }
});

const formId = (prefix: string, suffix: string) => `pr_${prefix}${suffix.repeat(24)}`;

test("seven cards referencing two open seat forms by short id stay off the seat agenda", async () => {
  const { clearSeatRoundsForTests, insertSeatRound, mutateSeatRound } = await import("@/lib/prototypeReview/seatRounds");
  const { seatDecisionNotices } = await import("@/lib/prototypeReview/read");
  const { seatRoundLookup } = await import("./holdEvidence");
  const ids = [formId("10203040", "a"), formId("50607080", "b")];
  clearSeatRoundsForTests();
  try {
    for (const id of ids) {
      insertSeatRound({ id, taskId: null, project, title: "Choose", createdAt: at(-3), publicationKey: id,
        inputDigest: "fixture", source: { conversationId: null }, variants: [] });
    }
    const tasks = Array.from({ length: 7 }, (_, i) => task(`waiting-${i}`, "operator", { ref: ids[i % 2]!.slice(0, 11) }));
    const pipelines = tasks.map(row => lane(row.id, "needs_decision", { dismissedAt: at(-1) }));
    const seatRound = seatRoundLookup(seatDecisionNotices(project));
    const index = waitingRouteIndex(tasks, pipelines, new Set(), {}, undefined, seatRound);
    const routes = (rows: BoardTask[]) => rows.map(row => waitingRoute(row, index, NOW));
    const fullRefs = tasks.map((row, i) => ({ ...row, hold: { ...row.hold!, ref: ids[i % 2]! } }));
    expect(routes(fullRefs)).toEqual(tasks.map(() => ({ owner: "operator", rule: "operator-hold" })));
    expect(routes(tasks)).toEqual(routes(fullRefs));
    expect(seatAgendaAsks({ files: [], tasks, pipelines, seatRound }, NOW / 1000, project)).toEqual([]);

    const answered = ids[0]!;
    mutateSeatRound(answered, round => { round.decision = { chosen: [], comment: "Proceed", at: at(-1), revision: 1,
      delivery: { state: "sent", clientMessageId: "fixture-answer", conversationId: null, text: "" } }; });
    const refreshed = waitingRouteIndex(tasks, pipelines, new Set(), {}, undefined, seatRoundLookup(seatDecisionNotices(project)));
    expect(waitingRoute(tasks[0]!, refreshed, NOW)).toMatchObject({
      owner: "seat", rule: "form-answered", action: expect.stringContaining(answered),
    });
  } finally { clearSeatRoundsForTests(); }
});

test("short form refs stay within the project and report ambiguous and unknown ids", async () => {
  const { clearSeatRoundsForTests, insertSeatRound } = await import("@/lib/prototypeReview/seatRounds");
  const { seatDecisionNotices } = await import("@/lib/prototypeReview/read");
  const { seatRoundLookup } = await import("./holdEvidence");
  const id = formId("12345678", "a");
  const sharedPrefix = id.slice(0, 11);
  const held = task("prefix-hold", "operator", { ref: sharedPrefix });
  const owner = { ...task("form-owner", null), status: "assigned" as const,
    prototypeReview: { ...form(), latestReviewId: id, waitingReviewId: id } };
  const seatId = formId("12345678", "b");
  clearSeatRoundsForTests();
  try {
    insertSeatRound({ id: seatId, taskId: null, project, title: "Choose", createdAt: at(-3), publicationKey: seatId,
      inputDigest: "fixture", source: { conversationId: null }, variants: [] });
    const route = (row: BoardTask, carrier: BoardTask) =>
      waitingRoute(row, waitingRouteIndex([row, carrier], [], new Set(), {}, undefined, seatRoundLookup(seatDecisionNotices(project))), NOW);
    expect(route(held, owner)).toMatchObject({ owner: "seat", rule: "unowned", why: expect.stringContaining("ambiguous") });
    expect(route(held, { ...owner, project: "other-project" })).toEqual({ owner: "operator", rule: "operator-hold" });
    expect(route({ ...held, hold: { ...held.hold!, ref: id.slice(0, 12) } }, owner)).toEqual({ owner: "operator", rule: "operator-hold" });
    expect(route({ ...held, hold: { ...held.hold!, ref: "pr_90807060" } }, owner))
      .toMatchObject({ owner: "seat", rule: "unowned", why: expect.stringContaining("unknown") });
  } finally { clearSeatRoundsForTests(); }
});

test("an operator hold on an open step follows only the card's own lanes", () => {
  const row = task("linked-step-hold", "operator", { ref: "step-lane" });
  row.steps = [{ id: "step-lane", text: "Finish linked work", state: "open", ref: "step-lane" }];
  const dismissed = lane(row.id, "needs_decision", { dismissedAt: at(-1) });
  const route = (...others: Pipeline[]) => waitingRoute(row, waitingRouteIndex([row], [dismissed, ...others]), NOW);
  expect(route()).toMatchObject({ owner: "operator", rule: "operator-hold" });
  const unrelated = { ...lane("elsewhere", "completed"), id: "step-lane" };
  expect(route(unrelated)).toMatchObject({ owner: "operator", rule: "operator-hold" });
  const linked = { ...lane(row.id, "completed"), id: "step-lane" };
  expect(route(linked)).toMatchObject({ owner: "seat", rule: "wait-cleared" });
});

test("a lane pause keeps its date and never hides a prerequisite that already cleared", () => {
  const dismissed = (id: string) => lane(id, "needs_decision", { dismissedAt: at(-1) });
  const operatorPause = (id: string) => ({ ...lane(id, "paused", { pause: { reason: "Operator pause", resumeCondition: { kind: "date", at: at(5) } } }), id: `pause-${id}` });
  const cases: Array<[string, Partial<TaskHold>, BoardTask[], HoldPullRequestState | undefined, string]> = [
    ["merged PR", { kind: "pr", ref: "41" }, [], () => "merged", "wait-cleared"],
    ["closed task", { kind: "task", ref: "aabbccdd" }, [{ ...task("aabbccdd", null), status: "done" }], undefined, "wait-cleared"],
    ["expired date", { kind: "postponed", until: at(-1) }, [], undefined, "wait-cleared"],
  ];
  for (const [name, hold, others, pullRequestState, rule] of cases) {
    const row = task(`pause-${rule}-${name}`.replace(/ /g, "-"), hold.kind as TaskHoldKind, hold);
    const index = (...lanes: Pipeline[]) => waitingRouteIndex([row, ...others], lanes, new Set(), {}, pullRequestState);
    expect(waitingRoute(row, index(dismissed(row.id), operatorPause(row.id)), NOW), name).toMatchObject({ owner: "seat", rule });
    expect(waitingRoute(row, index(operatorPause(row.id)), NOW), name).toMatchObject({ owner: "seat", rule });
  }
  // Open prerequisites leave the pause in charge.
  const open = task("pause-open", "pr", { ref: "41" });
  expect(waitingRoute(open, waitingRouteIndex([open], [dismissed(open.id), operatorPause(open.id)], new Set(), {}, () => "open"), NOW)).toMatchObject({ owner: "agents", rule: "dated" });
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

test("the Waiting sample leaves waits with an exact open task prerequisite off the seat agenda", () => {
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
