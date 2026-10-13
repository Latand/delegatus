import { expect, test } from "bun:test";

import { attentionId, buildAttentionQueue } from "@/components/attention";
import { buildNeedsYouQueue } from "@/components/attention/attentionQueue";
import { conversationNeed, laneNeed } from "@/components/attention/needReason";
import { pipelineAsks } from "@/components/mobile/mobileBoardModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { AttentionEscalationMark } from "./routeTypes";
import { seatAgendaAsks } from "./seatAgenda";
import { stampAttentionRoutes, waitingRoundIds, type AttentionRoutingInputs } from "./routing";

/*
 * docs/design/attention-auto-resolve.md, acceptance 3 and 4: a worker's or a
 * stage's wait goes to the project's designated seat first, and leaves every
 * operator surface at once; the operator answers it when the project has no
 * seat to wake, or through the decision form the seat escalated it to, whose
 * row stands for it while it waits.
 */

const now = Date.parse("2026-10-11T12:00:00Z") / 1000;
const at = new Date((now - 600) * 1000).toISOString();

const file = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  root: "claude-projects", name, path: `/t/${name}.jsonl`, project: "project-a", title: name, kind: "session", engine: "claude", fmt: "claude",
  parent: null, mtime: now - 600, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  conversationId: `conversation_${name}`, ...extra,
}) as FileEntry;

/** A child the seat spawned: delegation depth one. */
const delegated = { kind: "spawn", role: "deployer", depth: 1, parentConversationId: "conversation_seat", reviewsConversationId: null, memberships: [] } as NonNullable<FileEntry["durableLineage"]>;
const ask = (id: string) => ({ id, messageAt: (now - 600) * 1000, gist: "Roll out to production now?", state: "open" }) as FileEntry["operatorAsk"];

const lane = (id: string, state: Pipeline["state"], extra: Partial<Pipeline> = {}): Pipeline => ({
  id, task: id, taskIds: [], project: "project-a", state, createdAt: at, stages: [{ id: "diagnose", kind: "run" }], runs: [],
  cursor: { stageId: "diagnose" }, stateDetail: null, srcConversationId: "conversation_seat", ...extra,
}) as unknown as Pipeline;

function inputs(options: { seat?: string | null; escalations?: AttentionEscalationMark[]; waiting?: ReadonlySet<string> } = {}): AttentionRoutingInputs {
  const seat = options.seat === undefined ? "conversation_seat" : options.seat;
  return {
    seatFor: () => seat,
    canonicalProject: (project) => project,
    isSeatConversation: (id) => id === "conversation_seat" || id === "conversation_old_seat",
    escalation: (key) => options.escalations?.find((entry) => entry.key === key) ?? null,
    formWaiting: (reviewId) => options.waiting?.has(reviewId) ?? false,
  };
}

test("a worker's prose ask goes to the seat and leaves every operator surface", () => {
  const worker = file("deployer", { durableLineage: delegated, operatorAsk: ask("ask-1") });
  stampAttentionRoutes([worker], [], now, inputs());
  expect(worker.attentionRoute).toEqual({ key: "reason:ask-1", owner: "seat", seat: "conversation_seat" });
  expect(attentionId(worker, now)).toBeNull();
  expect(buildAttentionQueue([worker], now)).toEqual([]);
  expect(conversationNeed(worker, now)).toBeNull();
  expect(buildNeedsYouQueue([worker], [], now, [])).toEqual([]);
});

test("with no seat to wake, the same ask stays the operator's", () => {
  const worker = file("deployer", { durableLineage: delegated, operatorAsk: ask("ask-1") });
  stampAttentionRoutes([worker], [], now, inputs({ seat: null }));
  expect(worker.attentionRoute).toBeUndefined();
  expect(attentionId(worker, now)).toBe("ask-1");
});

test("a seat's own ask and a direct operator session stay the operator's", () => {
  const seat = file("seat", { conversationId: "conversation_old_seat", durableLineage: { ...delegated, depth: 0 }, operatorAsk: ask("ask-seat") });
  const direct = file("direct", { operatorAsk: ask("ask-direct") });
  const rootLineage = file("root", { durableLineage: { ...delegated, depth: 0 }, operatorAsk: ask("ask-root") });
  const directQuestion = file("direct-question", { pendingQuestion: { kind: "question", toolUseId: "toolu_direct", askedAt: at, questions: [] } as unknown as FileEntry["pendingQuestion"] });
  stampAttentionRoutes([seat, direct, rootLineage, directQuestion], [], now, inputs());
  for (const entry of [seat, direct, rootLineage, directQuestion]) expect(entry.attentionRoute).toBeUndefined();
  expect(buildAttentionQueue([seat, direct, rootLineage, directQuestion], now).map((item) => item.id).sort()).toEqual(["ask-direct", "ask-root", "ask-seat", "toolu_direct"]);
});

test("a worker's native question or plan wakes the seat with its options and the answer path to that exact request; with no seat it is the operator's", () => {
  const pendingQuestion = { kind: "question", toolUseId: "toolu_q", askedAt: at, questions: [{ question: "Retry on the bigger runner?", header: "Runner", multiSelect: false,
    options: [{ label: "Retry", description: "", recommended: true }, { label: "Close the lane", description: "", recommended: false }] }] } as unknown as FileEntry["pendingQuestion"];
  const question = file("question", { durableLineage: delegated, pendingQuestion });
  const plan = file("plan", { durableLineage: delegated, pendingQuestion: { kind: "plan", toolUseId: "toolu_p", askedAt: at, plan: "Rebuild the index first" } as unknown as FileEntry["pendingQuestion"] });
  stampAttentionRoutes([question, plan], [], now, inputs());
  expect(question.attentionRoute).toEqual({ key: "reason:toolu_q", owner: "seat", seat: "conversation_seat" });
  expect(plan.attentionRoute).toEqual({ key: "reason:toolu_p", owner: "seat", seat: "conversation_seat" });
  expect(buildNeedsYouQueue([question, plan], [], now, [])).toEqual([]);
  expect(attentionId(question, now)).toBeNull();
  const agenda = seatAgendaAsks({ files: [question, plan], pipelines: [] }, now, "project-a");
  expect(agenda.map((entry) => entry.key)).toEqual(["reason:toolu_q", "reason:toolu_p"]);
  expect(agenda[0]!.label).toContain("«Retry on the bigger runner?» 1) Retry (recommended) 2) Close the lane");
  expect(agenda[0]!.label).toContain('conversation_action answer, requestId "toolu_q"');
  expect(agenda[1]!.label).toContain('requestId "toolu_p" and approve true or false');

  stampAttentionRoutes([question, plan], [], now, inputs({ seat: null }));
  expect(question.attentionRoute).toBeUndefined();
  expect(buildAttentionQueue([question, plan], now).map((item) => item.id).sort()).toEqual(["toolu_p", "toolu_q"]);
});

test("a stage's memory kill and permission request are the seat's", () => {
  const stage = { ...delegated, depth: 0, memberships: [{ kind: "pipeline", containerId: "lane", role: "builder", slot: "s", stageId: "build", stageOrder: 0, round: null, parentConversationId: null }] } as NonNullable<FileEntry["durableLineage"]>;
  const killed = file("killed", { durableLineage: stage, memoryKill: { at, limit: "agent", limitBytes: 4 * 2 ** 30, fatal: true } as FileEntry["memoryKill"] });
  const asking = file("asking", { durableLineage: stage, pendingPermission: { id: "perm-1", since: at, tool: "Bash", command: "rm -rf build" } as FileEntry["pendingPermission"] });
  stampAttentionRoutes([killed, asking], [], now, inputs());
  expect(killed.attentionRoute?.owner).toBe("seat");
  expect(asking.attentionRoute).toEqual({ key: "reason:/t/asking.jsonl:permission:perm-1", owner: "seat", seat: "conversation_seat" });
});

/** A task whose newest decision round is `reviewId`, waiting or decided. */
const formTask = (reviewId: string, decided = false): BoardTask => ({
  id: "task-form", project: "project-a", text: "Roll out release", status: "assigned", assignments: [], createdAt: at, updatedAt: at,
  prototypeReviews: [{ id: reviewId, title: "Roll out tonight?", createdAt: at, variants: [],
    questions: [{ id: "q1", text: "Roll out tonight?", options: [{ label: "Tonight", recommended: true }, { label: "Tomorrow" }] }],
    ...(decided ? { decision: { chosen: [], comment: "", at, delivery: { state: "sent" } } } : {}) }],
}) as unknown as BoardTask;

test("an escalated wait is the decision form's while the round waits: the form's row is the only row, and the seat's agenda drops it", () => {
  const escalation: AttentionEscalationMark = { key: "reason:ask-1", at, seat: "conversation_seat", taskId: "task-form", reviewId: "round-1" };
  const worker = file("deployer", { durableLineage: delegated, operatorAsk: ask("ask-1") });
  const tasks = [formTask("round-1")];
  stampAttentionRoutes([worker], [], now, inputs({ escalations: [escalation], waiting: waitingRoundIds(tasks) }));
  expect(worker.attentionRoute).toEqual({ key: "reason:ask-1", owner: "form", seat: "conversation_seat", form: { taskId: "task-form", reviewId: "round-1" } });
  expect(attentionId(worker, now)).toBeNull();
  expect(conversationNeed(worker, now)).toBeNull();
  expect(buildNeedsYouQueue([worker], [], now, [], null, tasks).map((entry) => entry.id)).toEqual(["prototype:round-1"]);
  expect(seatAgendaAsks({ files: [worker], pipelines: [] }, now, "project-a")).toEqual([]);

  /* The operator answered the form: the answer went to the seat, and the wait
     is the seat's again, to carry it to the asker. */
  const answered = [formTask("round-1", true)];
  stampAttentionRoutes([worker], [], now, inputs({ escalations: [escalation], waiting: waitingRoundIds(answered) }));
  expect(worker.attentionRoute).toEqual({ key: "reason:ask-1", owner: "seat", seat: "conversation_seat", returnedFrom: "round-1" });
  expect(buildNeedsYouQueue([worker], [], now, [], null, answered)).toEqual([]);
  expect(seatAgendaAsks({ files: [worker], pipelines: [] }, now, "project-a").map((entry) => entry.key)).toEqual(["reason:ask-1@returned:round-1"]);

  /* A newer ask is routed afresh, to the seat. */
  worker.operatorAsk = ask("ask-2");
  stampAttentionRoutes([worker], [], now, inputs({ escalations: [escalation], waiting: waitingRoundIds(tasks) }));
  expect(worker.attentionRoute).toEqual({ key: "reason:ask-2", owner: "seat", seat: "conversation_seat" });
});

test("a wait already escalated stays one form row when its seat goes away; one never escalated falls back to the operator", () => {
  const escalation: AttentionEscalationMark = { key: "reason:ask-1", at, seat: "conversation_seat", taskId: "task-form", reviewId: "round-a" };
  const laneEscalation: AttentionEscalationMark = { key: "lane:parked:lane-decision:none", at, seat: "conversation_seat", taskId: "task-form", reviewId: "round-a" };
  const worker = file("deployer", { durableLineage: delegated, operatorAsk: ask("ask-1") });
  const other = file("other", { durableLineage: delegated, operatorAsk: ask("ask-2") });
  const parked = lane("parked", "needs_decision");
  const tasks = [formTask("round-a")];
  for (const seat of ["conversation_seat", null]) {
    stampAttentionRoutes([worker, other], [parked], now, inputs({ seat, escalations: [escalation, laneEscalation], waiting: waitingRoundIds(tasks) }));
    expect(worker.attentionRoute?.owner).toBe("form");
    expect(parked.attentionRoute?.owner).toBe("form");
    expect(buildNeedsYouQueue([worker], [parked], now, [], null, tasks).map((entry) => entry.id)).toEqual(["prototype:round-a"]);
  }
  /* With the seat gone, the wait nobody escalated is the operator's. */
  expect(other.attentionRoute).toBeUndefined();
  expect(attentionId(other, now)).toBe("ask-2");
});

test("a wait handed back by its form carries the round it came back from, so the seat's agenda offers it afresh", () => {
  const escalation: AttentionEscalationMark = { key: "reason:ask-1", at, seat: "conversation_seat", taskId: "task-form", reviewId: "round-a" };
  const worker = file("deployer", { durableLineage: delegated, operatorAsk: ask("ask-1") });
  stampAttentionRoutes([worker], [], now, inputs({ escalations: [escalation], waiting: new Set() }));
  expect(worker.attentionRoute).toEqual({ key: "reason:ask-1", owner: "seat", seat: "conversation_seat", returnedFrom: "round-a" });
  const [returned] = seatAgendaAsks({ files: [worker], pipelines: [] }, now, "project-a");
  expect(returned!.key).toBe("reason:ask-1@returned:round-a");
  expect(returned!.label).toStartWith("[back from decision round round-a");
});

test("a lane escalated to a form leaves the operator's lane rows while the round waits", () => {
  const parked = lane("parked", "needs_decision");
  const escalation: AttentionEscalationMark = { key: "lane:parked:lane-decision:none", at, seat: "conversation_seat", taskId: "task-form", reviewId: "round-1" };
  stampAttentionRoutes([], [parked], now, inputs({ escalations: [escalation], waiting: new Set(["round-1"]) }));
  expect(parked.attentionRoute?.owner).toBe("form");
  expect(pipelineAsks(parked)).toBe(false);
  expect(laneNeed(parked)).toBeNull();
  expect(seatAgendaAsks({ files: [], pipelines: [parked] }, now, "project-a")).toEqual([]);
});

test("parked lanes, spent review budgets and stopped merges go to the seat; an automatic retry asks nobody", () => {
  const decision = lane("decision", "needs_decision");
  const review = lane("review", "needs_review");
  const merge = lane("merge", "completed", { merge: { state: "blocked", reason: "required check failed: build", updatedAt: at, blockedAt: at } as Pipeline["merge"] });
  const retry = lane("retry", "needs_decision", { runs: [{ stageId: "diagnose", attempts: [{ n: 1, state: "needs_decision", providerWait: { stageRetry: true, resumeAt: new Date((now + 600) * 1000).toISOString() } }] }] } as unknown as Partial<Pipeline>);
  stampAttentionRoutes([], [decision, review, merge, retry], now, inputs());
  expect(decision.attentionRoute).toEqual({ key: "lane:decision:lane-decision:none", owner: "seat", seat: "conversation_seat" });
  expect(review.attentionRoute?.owner).toBe("seat");
  expect(merge.attentionRoute).toEqual({ key: `lane:merge:merge:${at}`, owner: "seat", seat: "conversation_seat" });
  expect(retry.attentionRoute?.owner).toBe("system");
  for (const entry of [decision, review, merge, retry]) {
    expect(pipelineAsks(entry)).toBe(false);
    expect(laneNeed(entry)).toBeNull();
  }
  expect(buildNeedsYouQueue([], [decision, review, merge, retry], now, [])).toEqual([]);
});

test("a wait someone already cleared routes to nobody, and its card says who cleared it; one cleared before it stopped still goes to the seat", () => {
  /* docs/design/calm-task-cards-build.md §7.3: «Leave the PR open» or a
     dismissed decision answers the wait, so no seat is woken for it again. */
  const blockedAt = new Date((now - 300) * 1000).toISOString();
  const seatClear = { kind: "manager", conversationId: "conversation_seat", role: null } as const;
  const merge = lane("merge", "completed", { merge: { state: "blocked", reason: "the PR was closed", updatedAt: blockedAt, blockedAt } as Pipeline["merge"], dismissedAt: new Date((now - 60) * 1000).toISOString(), dismissedBy: seatClear });
  const decision = lane("decision", "needs_decision", { dismissedAt: new Date((now - 60) * 1000).toISOString(), dismissedBy: seatClear });
  /* Cleared before the merge stopped: the stop is new and still asks. */
  const earlier = lane("earlier", "completed", { merge: { state: "blocked", reason: "the PR was closed", updatedAt: blockedAt, blockedAt } as Pipeline["merge"], dismissedAt: new Date((now - 900) * 1000).toISOString(), dismissedBy: seatClear });
  stampAttentionRoutes([], [merge, decision, earlier], now, inputs());
  expect(merge.attentionRoute).toBeUndefined();
  expect(decision.attentionRoute).toBeUndefined();
  expect(earlier.attentionRoute).toEqual({ key: `lane:earlier:merge:${blockedAt}`, owner: "seat", seat: "conversation_seat" });
  for (const entry of [merge, decision]) {
    const found = laneNeed(entry);
    expect(found?.cleared?.by).toEqual(seatClear);
    expect(pipelineAsks(entry)).toBe(false);
  }
  expect(seatAgendaAsks({ files: [], pipelines: [merge, decision, earlier] }, now, "project-a").map((item) => item.id)).toEqual(["earlier"]);
  expect(buildNeedsYouQueue([], [merge, decision], now, [])).toEqual([]);
});

test("the operator keeps the unreviewed head of a lane they created, and every lane when no seat can be woken", () => {
  const own = lane("own", "needs_review", { srcConversationId: null });
  const decision = lane("own-decision", "needs_decision", { srcConversationId: null });
  stampAttentionRoutes([], [own, decision], now, inputs());
  expect(own.attentionRoute).toBeUndefined();
  expect(pipelineAsks(own)).toBe(true);
  expect(decision.attentionRoute?.owner).toBe("seat");

  const parked = lane("parked", "needs_decision");
  stampAttentionRoutes([], [parked], now, inputs({ seat: null }));
  expect(parked.attentionRoute).toBeUndefined();
  expect(pipelineAsks(parked)).toBe(true);
});

test("a stamp is replaced on every projection, and one drawn for an earlier movement covers nothing", () => {
  const parked = lane("parked", "needs_decision");
  stampAttentionRoutes([], [parked], now, inputs());
  expect(pipelineAsks(parked)).toBe(false);
  /* The lane moved and parked again before the next projection. */
  parked.runs = [{ stageId: "diagnose", attempts: [{ n: 2, state: "needs_decision", startedAt: at, completedAt: at }] }] as unknown as Pipeline["runs"];
  expect(pipelineAsks(parked)).toBe(true);
  stampAttentionRoutes([], [parked], now, inputs({ seat: null }));
  expect(parked.attentionRoute).toBeUndefined();
});
