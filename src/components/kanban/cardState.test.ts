import { expect, test } from "bun:test";

import { laneNeed } from "@/components/attention/needReason";
import { laneRouteKey, type AttentionRouteMark } from "@/lib/attention/routeTypes";
import { translate, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { TaskMotion } from "@/lib/tasks/motion";
import type { BoardTask } from "@/lib/tasks/types";

import { cardAnswers, cardState, cardStateText, formAnswerTarget, laneState } from "./cardState";
import type { KanbanCard } from "./kanbanModel";

/*
 * docs/design/calm-task-cards-build.md §5: one owner per lane and per card,
 * from the route the server stamps and the need the client reads, and the
 * state line's one sentence in the operator's words.
 */

const NOW = Date.parse("2026-10-12T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const en: TFunction = ((key: string, params?: Record<string, unknown>) => translate("en", key as never, params as never)) as TFunction;
const uk: TFunction = ((key: string, params?: Record<string, unknown>) => translate("uk", key as never, params as never)) as TFunction;
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

const lane = (id: string, state: Pipeline["state"], extra: Partial<Pipeline> = {}): Pipeline => ({
  id, task: `Lane ${id}`, taskIds: ["t1"], project: "project-a", state, createdAt: iso(120), closedAt: null, stateDetail: null,
  stages: [{ id: "build", kind: "run", next: null, onFail: null }], cursor: { stageId: "build" }, srcConversationId: "conversation_seat",
  runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", startedAt: iso(40), completedAt: iso(30), error: "committing the passed stage: fatal: index.lock exists" }] }],
  ...extra,
}) as unknown as Pipeline;

const routed = (pipeline: Pipeline, owner: AttentionRouteMark["owner"], extra: Partial<AttentionRouteMark> = {}): Pipeline => {
  pipeline.attentionRoute = { key: laneRouteKey(pipeline, pipeline.state === "completed" ? "lane-merge" : "lane-decision"), owner, ...(owner === "seat" ? { seat: "conversation_seat" } : {}), ...extra };
  return pipeline;
};

const motion = (key: TaskMotion["key"]): TaskMotion => ({ key, reason: null, since: null, holdStillSet: false, due: false });

function card(pipelines: Pipeline[], extra: Partial<KanbanCard> = {}): KanbanCard {
  const reasons = pipelines.flatMap((pipeline) => {
    const found = laneNeed(pipeline);
    return found && !found.cleared ? [found.need] : [];
  });
  return {
    needsYou: reasons.length > 0, reasons, members: [], task: { id: "t1" } as BoardTask, motion: motion("stopped"),
    pipelines: pipelines.map((pipeline) => ({ pipeline })),
    ...extra,
  } as unknown as KanbanCard;
}

test("a stop routed to the seat is the orchestrator's, in plain words, and offers no «Answer»", () => {
  const state = cardState(card([routed(lane("commit", "needs_decision"), "seat")]), NOW / 1000)!;
  expect(state.owner).toBe("seat");
  expect(state.subject.kind).toBe("lane");
  expect(cardStateText(en, state, clock)).toBe("The orchestrator is on it: the build commit failed");
  expect(cardStateText(uk, state, clock)).toBe("Оркестратор розбирається: коміт «build» не вдався");
  expect(cardAnswers(state)).toBe(false);
});

test("a stop no seat can take is the operator's, with «Answer»", () => {
  const state = cardState(card([lane("commit", "needs_decision")]), NOW / 1000)!;
  expect(state.owner).toBe("you");
  expect(cardStateText(en, state, clock)).toBe("Needs your answer: the build commit failed");
  expect(cardAnswers(state)).toBe(true);
});

test("a wait the seat escalated to a decision form is the operator's, and names the form", () => {
  const pipeline = routed(lane("form", "needs_decision"), "form", { form: { taskId: "t1", reviewId: "r1" } });
  const task = { id: "t1", prototypeReview: { latestReviewId: "r1", waitingReviewId: "r1", title: "Keep the panel or drop it?", rounds: 1, createdAt: iso(10) } } as unknown as BoardTask;
  const state = cardState(card([pipeline], { task }), NOW / 1000)!;
  expect(state.owner).toBe("you");
  expect(state.subject).toEqual({ kind: "form", taskId: "t1", reviewId: "r1", title: "Keep the panel or drop it?" });
  expect(cardStateText(uk, state, clock)).toBe("Потрібна ваша відповідь: Keep the panel or drop it?");
  expect(cardAnswers(state)).toBe(true);
});

test("a wait escalated to the seat's own taskless decision form stays the operator's and opens the seat decision", () => {
  const pipeline = routed(lane("form", "needs_decision"), "form", { form: { taskId: null, reviewId: "seat-r1" } });
  const state = cardState(card([pipeline], { needsYou: true, reasons: [] }), NOW / 1000)!;
  expect(state.owner).toBe("you");
  expect(state.subject).toEqual({ kind: "form", taskId: null, reviewId: "seat-r1", title: null });
  expect(cardAnswers(state)).toBe(true);
  const subject = state.subject as Extract<typeof state.subject, { kind: "form" }>;
  expect(formAnswerTarget(subject, "project-a")).toEqual({ kind: "seat-decision", project: "project-a", reviewId: "seat-r1", from: "card" });
  expect(formAnswerTarget({ ...subject, taskId: "t1", reviewId: "r1" }, "project-a")).toEqual({ kind: "prototype-review", taskId: "t1", reviewId: "r1", from: "card" });
});

test("an automatic retry waits with its time; a cleared stop says who cleared it", () => {
  const resumeAt = new Date(NOW + 45 * 60_000).toISOString();
  const retry = routed(lane("retry", "needs_decision", {
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "needs_decision", startedAt: iso(20), providerWait: { stageRetry: { controlGeneration: null, detail: "quota" }, resumeAt } }] }],
  } as unknown as Partial<Pipeline>), "system");
  const waiting = cardState(card([retry]), NOW / 1000)!;
  expect(waiting.owner).toBe("waiting");
  expect(cardStateText(en, waiting, clock)).toBe(`Waiting for the account limit · retry at ${clock(Date.parse(resumeAt))}`);

  const blockedAt = iso(50);
  const cleared = lane("closed-pr", "completed", {
    cursor: null,
    merge: { state: "blocked", reason: "the PR was closed", blockedAt, updatedAt: blockedAt, prNumber: 41, updates: [] } as unknown as Pipeline["merge"],
    dismissedAt: iso(20), dismissedBy: { kind: "manager", conversationId: "conversation_seat", role: null },
  });
  const state = cardState(card([cleared]), NOW / 1000)!;
  expect(state.owner).toBe("waiting");
  expect(cardStateText(en, state, clock)).toBe("Stopped · cleared (orchestrator)");
  expect(cardStateText(uk, state, clock)).toBe("Зупинилось · знято (оркестратор)");
});

test("a seat-routed merge names its PR and reason; the most urgent lane leads the card", () => {
  const blockedAt = iso(15);
  const merge = routed(lane("merge", "completed", {
    cursor: null, merge: { state: "blocked", reason: "conflict with the base branch", blockedAt, updatedAt: blockedAt, prNumber: 77, updates: [] } as unknown as Pipeline["merge"],
  }), "seat");
  const refresh = lane("refresh", "running", { runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", startedAt: iso(5) }] }] } as unknown as Partial<Pipeline>);
  const state = cardState(card([refresh, merge], { motion: motion("working") }), NOW / 1000)!;
  expect(state.owner).toBe("seat");
  expect(cardStateText(en, state, clock)).toBe("The orchestrator is on it: PR #77 merge stopped: conflict with the base branch");
  expect(state.lanes.map((entry) => entry.owner)).toEqual(["working", "seat"]);
});

test("work in flight says the card's motion; a merged lane says its PR; a card that has not started draws nothing", () => {
  const running = lane("run", "running", { runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", startedAt: iso(5) }] }] } as unknown as Partial<Pipeline>);
  const working = cardState(card([running], { motion: motion("working") }), NOW / 1000)!;
  expect(working.owner).toBe("working");
  expect(working.subject.kind).toBe("motion");
  expect(cardStateText(en, working, clock)).toBeNull();

  const merged = lane("done", "completed", { cursor: null, merge: { state: "merged", by: "auto-merge", mergedAt: iso(3), prNumber: 12, updates: [] } as unknown as Pipeline["merge"] });
  const done = cardState(card([merged], { motion: motion("done") }), NOW / 1000)!;
  expect(done.owner).toBe("done");
  expect(cardStateText(en, done, clock)).toBe("PR #12 merged");

  expect(cardState(card([], { motion: motion("not-started") }), NOW / 1000)).toBeNull();
});

test("a lane's owner follows §5.1's table", () => {
  expect(laneState(lane("paused", "paused")).owner).toBe("waiting");
  expect(laneState(lane("prov", "provisioning")).owner).toBe("working");
  expect(laneState(lane("disk", "provisioning", { stateDetail: "waiting for disk space: 2 GB free" })).owner).toBe("waiting");
  expect(laneState(lane("closed", "closed", { closedAt: iso(1) })).owner).toBe("done");
  const checks = lane("checks", "completed", { cursor: null, merge: { state: "waiting-checks", requestedAt: iso(9), prNumber: 5, updates: [] } as unknown as Pipeline["merge"] });
  expect(laneState(checks).owner).toBe("waiting");
  expect(laneState(lane("open", "needs_decision")).owner).toBe("you");
});
