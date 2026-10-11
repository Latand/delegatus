import { expect, test } from "bun:test";

import { attentionId, buildAttentionQueue } from "@/components/attention";
import { buildNeedsYouQueue } from "@/components/attention/attentionQueue";
import { conversationNeed, laneNeed } from "@/components/attention/needReason";
import { pipelineAsks } from "@/components/mobile/mobileBoardModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import type { AttentionEscalationMark } from "./routeTypes";
import { stampAttentionRoutes, type AttentionRoutingInputs } from "./routing";

/*
 * docs/design/attention-auto-resolve.md, acceptance 3 and 4: a worker's or a
 * stage's wait goes to the project's designated seat first, and leaves every
 * operator surface at once; the operator gets it back when the seat escalates
 * it or when the project has no seat to wake.
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

function inputs(options: { seat?: string | null; escalations?: AttentionEscalationMark[] } = {}): AttentionRoutingInputs {
  const seat = options.seat === undefined ? "conversation_seat" : options.seat;
  return {
    seatFor: () => seat,
    canonicalProject: (project) => project,
    isSeatConversation: (id) => id === "conversation_seat" || id === "conversation_old_seat",
    escalation: (key) => options.escalations?.find((entry) => entry.key === key) ?? null,
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

test("a seat's own ask, a direct operator session and a native question stay the operator's", () => {
  const seat = file("seat", { conversationId: "conversation_old_seat", durableLineage: { ...delegated, depth: 0 }, operatorAsk: ask("ask-seat") });
  const direct = file("direct", { operatorAsk: ask("ask-direct") });
  const rootLineage = file("root", { durableLineage: { ...delegated, depth: 0 }, operatorAsk: ask("ask-root") });
  const question = file("question", { durableLineage: delegated, pendingQuestion: { kind: "question", toolUseId: "toolu_q", askedAt: at, questions: [] } as unknown as FileEntry["pendingQuestion"] });
  stampAttentionRoutes([seat, direct, rootLineage, question], [], now, inputs());
  for (const entry of [seat, direct, rootLineage, question]) expect(entry.attentionRoute).toBeUndefined();
  expect(buildAttentionQueue([seat, direct, rootLineage, question], now).map((item) => item.id).sort()).toEqual(["ask-direct", "ask-root", "ask-seat", "toolu_q"]);
});

test("a stage's memory kill and permission request are the seat's", () => {
  const stage = { ...delegated, depth: 0, memberships: [{ kind: "pipeline", containerId: "lane", role: "builder", slot: "s", stageId: "build", stageOrder: 0, round: null, parentConversationId: null }] } as NonNullable<FileEntry["durableLineage"]>;
  const killed = file("killed", { durableLineage: stage, memoryKill: { at, limit: "agent", limitBytes: 4 * 2 ** 30, fatal: true } as FileEntry["memoryKill"] });
  const asking = file("asking", { durableLineage: stage, pendingPermission: { id: "perm-1", since: at, tool: "Bash", command: "rm -rf build" } as FileEntry["pendingPermission"] });
  stampAttentionRoutes([killed, asking], [], now, inputs());
  expect(killed.attentionRoute?.owner).toBe("seat");
  expect(asking.attentionRoute).toEqual({ key: "reason:/t/asking.jsonl:permission:perm-1", owner: "seat", seat: "conversation_seat" });
});

test("a seat's escalation brings the wait back to the operator with its words; a newer ask is routed afresh", () => {
  const escalation: AttentionEscalationMark = { key: "reason:ask-1", at, question: "Roll out tonight?", options: ["Tonight", "Tomorrow"], recommended: 0, effect: null, seat: "conversation_seat" };
  const worker = file("deployer", { durableLineage: delegated, operatorAsk: ask("ask-1") });
  stampAttentionRoutes([worker], [], now, inputs({ escalations: [escalation] }));
  expect(worker.attentionRoute).toBeUndefined();
  expect(worker.attentionEscalation).toEqual(escalation);
  expect(attentionId(worker, now)).toBe("ask-1");
  expect(buildAttentionQueue([worker], now)[0]?.reason.escalation).toEqual(escalation);

  worker.operatorAsk = ask("ask-2");
  stampAttentionRoutes([worker], [], now, inputs({ escalations: [escalation] }));
  expect(worker.attentionEscalation).toBeUndefined();
  expect(worker.attentionRoute?.key).toBe("reason:ask-2");
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
