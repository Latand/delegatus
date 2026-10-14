import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { GET as imageGET } from "@/app/api/image/route";
import { decisionsGET, decisionsPOST as decisionsRoutePOST, publishPOST, reviewReadPOST, reviewScopePOST } from "./http";
import { resetPrototypeDeliveryWorkerForTests, settlePrototypeDeliveriesForTests, sweepPrototypeDeliveries } from "./deliveryWorker";
import { decidePrototype, prototypeDecisionText } from "./decision";
import { seatDecisionNotices } from "./read";
import { prototypeReviewNotices } from "./model";
import { publishPrototype, roundDirectory } from "./store";
import { clearSeatRoundsForTests, loadSeatRounds } from "./seatRounds";
import { prototypeWorld, type PrototypeWorld } from "./world";
import type { OperatorDecisionsRead, PrototypeDecision, PrototypeReviewRead, PrototypeReviewRound, PublishPrototypeInput } from "./types";
import { questions } from "./questionnaire.fixture";
import { criticLane } from "./criticGate.fixture";
import { matchPrototypeAnswer, prototypeCopyLine } from "./telegramAnswer";
import { runPrototypeAnswer } from "@/lib/externalRelay/prototypeAnswer";
import type { ExternalRelayAnswer } from "@/lib/externalRelay/protocol";

/* docs/design/operator-decision-forms.md §2.1–§2.2: the project's seat asks
   without a task, through the same store, route and message. */

const roots: string[] = [];
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
function task() { return { id: "task-prototype", project: "project-a", status: "inbox" as const, placement: "unplaced" as const, text: "Review layout", assignments: [], sources: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }; }
beforeEach(async () => { await resetPrototypeDeliveryWorkerForTests(); saveTasks([task()]); clearSeatRoundsForTests(); });
afterEach(async () => { await resetPrototypeDeliveryWorkerForTests(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function request(url: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, { headers: { host: "localhost", "sec-fetch-site": "same-origin" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
}
const seat: PrototypeWorld = { ...prototypeWorld, caller: () => ({ conversationId: "conversation_seat", project: "project-a" }), stage: () => null, orchestrator: () => "conversation_seat" };
const operator: PrototypeWorld = { ...prototypeWorld, orchestrator: () => "conversation_seat" };
const one = [{ id: "deploy", text: "Deploy now?", options: [{ label: "Now", recommended: true }, { label: "Tonight" }] }];
function recorder() {
  const sent: string[] = [];
  return { sent, delivery: { recover: async () => null, send: async (decision: PrototypeDecision) => { sent.push(decision.delivery.text); return { state: "sent" as const }; }, retry: async () => ({ state: "sent" as const }) } };
}
async function decisionsPOST(...args: Parameters<typeof decisionsRoutePOST>) {
  const response = await decisionsRoutePOST(...args);
  await settlePrototypeDeliveriesForTests();
  return response;
}
async function publishAs(world: PrototypeWorld, input: PublishPrototypeInput) {
  return publishPOST(request("/api/prototype-reviews", input), world);
}
async function decisions(project = "project-a", review?: string) {
  return (await (await decisionsGET(request("/api/projects/decisions"), project, operator, review ?? null)).json()) as OperatorDecisionsRead;
}

test("a project's seat asks without a task, and the round lives in its own collection", async () => {
  const response = await publishAs(seat, { clientRequestId: "seat-deploy", title: "Deploy now?", questions: one });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ taskId: null, project: "project-a", title: "Deploy now?", questions: 1, variants: 0 });
  expect(loadTasks()[0]!.prototypeReviews).toBeUndefined();
  const [round] = loadSeatRounds("project-a");
  expect(round).toMatchObject({ id: body.reviewId, taskId: null, project: "project-a", source: { conversationId: "conversation_seat" } });
  /* The same clientRequestId replays the publication. */
  expect((await (await publishAs(seat, { clientRequestId: "seat-deploy", title: "Deploy now?", questions: one })).json()).reviewId).toBe(body.reviewId);
  expect(loadSeatRounds()).toHaveLength(1);
});

test("a Telegram owner reservation answers the asking seat's taskless round", async () => {
  expect((await publishAs(seat, { clientRequestId: "seat-telegram", title: "Deploy now?", questions: one })).status).toBe(200);
  const [round] = loadSeatRounds();
  const words = `${prototypeCopyLine(round!)}, але 1: Спочатку покажіть результат.`;
  const match = matchPrototypeAnswer(words)!;
  expect(match.input?.recommendedWithReservation).toBe(true);
  const { sent, delivery } = recorder();
  const result = await runPrototypeAnswer(match, "owner-message", () => {}, { world: operator, delivery }).done;
  expect((result.answer as ExternalRelayAnswer).text).toContain("рекомендовані з застереженням");
  await settlePrototypeDeliveriesForTests();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("recommended with reservation");
  expect(sent[0]).toContain("Owner's custom note:\n1: Спочатку покажіть результат.");
  const saved = loadSeatRounds()[0]!.decision!;
  expect(saved.originalReply).toBe(words);
  expect(saved.delivery.conversationId).toBe("conversation_seat");
  expect(matchPrototypeAnswer(words)).toBeNull();
  expect(matchPrototypeAnswer(words, loadTasks(), round!.id)?.input?.originalReply).toBe(words);
});

test("only the project's designated seat may ask without a task, and only with questions", async () => {
  const notSeat = { ...seat, orchestrator: () => "conversation_other" };
  const refused = await publishAs(notSeat, { clientRequestId: "worker", title: "Deploy now?", questions: one });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain("only a project's orchestrator may ask without one");
  const operatorCall = await publishAs(operator, { clientRequestId: "operator", title: "Deploy now?", questions: one });
  expect(operatorCall.status).toBe(400);
  const root = await fs.mkdtemp(path.join(process.env.HOME!, "seat-source-")); roots.push(root);
  await fs.writeFile(path.join(root, "v1.png"), PNG);
  const variantsOnly = await publishAs(seat, { clientRequestId: "variants", title: "Layout", variants: [{ number: 1, name: "Compact", description: "Tight.", frames: [{ path: path.join(root, "v1.png"), caption: "" }] }] });
  expect(variantsOnly.status).toBe(400);
  expect((await variantsOnly.json()).error).toContain("give it 1–7 questions");
  expect(loadSeatRounds()).toHaveLength(0);
});

test("task forms need 3–7 questions, including a pipeline's inherited task", async () => {
  const pipeline: PrototypeWorld = { ...seat, stage: () => ({ pipelineId: "pipeline-form", stageId: "build", project: "project-a", taskIds: ["task-prototype"], source: { conversationId: "conversation_seat" } }) };
  for (const [world, taskId] of [[operator, "task-prototype"], [pipeline, undefined]] as const) {
    for (const count of [1, 2]) {
      const response = await publishAs(world, { clientRequestId: `short-${taskId ?? "pipeline"}-${count}`, ...(taskId ? { taskId } : {}), title: "Before work", questions: questions.slice(0, count) });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("a task form needs 3–7 questions");
      expect(loadTasks()[0]!.prototypeReviews).toBeUndefined();
      expect(loadSeatRounds()).toHaveLength(0);
    }
  }
  for (const count of [3, 7]) {
    const input = { clientRequestId: `bounded-${count}`, title: "Before work", questions: Array.from({ length: count }, (_, i) => ({ ...one[0]!, id: `question-${i}` })) };
    expect((await publishAs(operator, { ...input, taskId: "task-prototype" })).status).toBe(200);
    expect((await publishAs(seat, { ...input, clientRequestId: `seat-${count}` })).status).toBe(200);
  }
});

test("the column lists the seat's questions and the tasks' waiting rounds; an answer reaches the seat as an operator decision", async () => {
  const seatId = (await (await publishAs(seat, { clientRequestId: "seat-q", title: "Which account tonight?", questions })).json()).reviewId as string;
  const taskId = (await (await publishAs(operator, { clientRequestId: "task-q", taskId: "task-prototype", title: "Before work", questions })).json()).reviewId as string;
  const open = await decisions();
  expect(open.decisions.map(d => [d.id, d.taskId, d.taskTitle ?? null]).sort()).toEqual([[seatId, null, null], [taskId, "task-prototype", "Review layout"]].sort());
  expect(prototypeReviewNotices(loadTasks(), seatDecisionNotices("project-a")).map(n => n.target)).toEqual([
    { kind: "prototype-review", taskId: "task-prototype", reviewId: taskId },
    { kind: "seat-decision", project: "project-a", reviewId: seatId },
  ]);
  const { sent, delivery } = recorder();
  const answers = [{ questionId: "place", options: [1] }, { questionId: "scope", options: [0, 1] }, { questionId: "timing", options: [0] }];
  const answered = await decisionsPOST(request("/api/projects/decisions", { project: "project-a", reviewId: seatId, chosen: [], comment: "", answers }), operator, delivery);
  expect(answered.status).toBe(200);
  const after = await answered.json() as OperatorDecisionsRead;
  expect(after.decisions.map(d => d.id)).toEqual([taskId]);
  const round = loadSeatRounds("project-a")[0]!;
  expect(sent).toEqual([`Operator decision\nAsked: Which account tonight?, ${round.createdAt.slice(11, 16)} UTC\nRound: Which account tonight?\n\nAnswers:\n1. Where should this live?\n   b) New window\n2. Which surfaces? (several allowed)\n   a) Desktop (recommended)\n   b) Phone\n3. When should work start?\n   a) After answering (recommended)\n\nComment:\n\n\nEnd of prototype review decision.`]);
  expect(round.decision).toMatchObject({ delivery: { state: "sent", conversationId: "conversation_seat", clientMessageId: `prototype-decision:${seatId}` } });
  expect(seatDecisionNotices("project-a")).toEqual([]);
  /* The feed's record of the answered question, read by its id. */
  expect((await decisions("project-a", seatId)).round).toMatchObject({ id: seatId, taskId: null, decision: { answers, delivery: { state: "sent" } } });
  /* The task's round answers through the same route, with its own unchanged message. */
  const taskAnswer = await decisionsPOST(request("/api/projects/decisions", { project: "project-a", reviewId: taskId, chosen: [], comment: "", skip: true }), operator, delivery);
  expect(taskAnswer.status).toBe(200);
  expect(sent[1]).toStartWith("Prototype review decision\nTask: task-prototype — Review layout\nRound: Before work\n");
  expect((await decisions()).decisions).toEqual([]);
});

test("a round of another project is not answered through this one", async () => {
  const seatId = (await (await publishAs(seat, { clientRequestId: "seat-q", title: "Deploy now?", questions: one })).json()).reviewId as string;
  const { sent, delivery } = recorder();
  const foreign = await decisionsPOST(request("/api/projects/decisions", { project: "project-b", reviewId: seatId, chosen: [], comment: "", answers: [{ questionId: "deploy", options: [0] }] }), operator, delivery);
  expect(foreign.status).toBe(404);
  const agent = await decisionsGET(request("/api/projects/decisions"), "project-a", { ...seat, caller: () => ({ conversationId: "conversation_b", project: "project-b" }) });
  expect(agent.status).toBe(403);
  expect(sent).toEqual([]);
});

test("the seat reads its own questions and the receipt scope names them", async () => {
  const seatId = (await (await publishAs(seat, { clientRequestId: "seat-q", title: "Deploy now?", questions: one })).json()).reviewId as string;
  const read = await (await reviewReadPOST(request("/api/prototype-reviews/read", {}), seat)).json() as PrototypeReviewRead;
  expect(read).toMatchObject({ taskId: null, waitingReviewId: seatId });
  expect(read.rounds.map(r => r.id)).toEqual([seatId]);
  expect(await (await reviewScopePOST(request("/api/prototype-reviews/scope", { mode: "publish" }), seat)).json()).toEqual({ conversationId: "conversation_seat", taskId: null });
});

test("an existing seat round's pictures are served without a task and survive another publication's cleanup", async () => {
  const root = await fs.mkdtemp(path.join(process.env.HOME!, "seat-source-")); roots.push(root);
  await fs.writeFile(path.join(root, "v1.png"), PNG);
  const input = { clientRequestId: "seat-frames", title: "Which layout?", questions: one,
    variants: [{ number: 1, name: "Compact", description: "Tight.", frames: [{ path: path.join(root, "v1.png"), caption: "" }] }] };
  // Existing media remains readable; new variants still need the lane's critic evidence.
  const refused = await publishAs(seat, input);
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toContain("visual-critic");
  const id = (await publishPrototype(input, null, { conversationId: "conversation_seat" }, "project-a")).id;
  /* A task publication sweeps orphan copies under the same lock. */
  await publishAs(operator, { clientRequestId: "task-q", taskId: "task-prototype", title: "Before work", questions });
  await fs.access(roundDirectory(id));
  const view = (await decisions()).decisions.find(d => d.id === id)!;
  const url = view.variants[0]!.frames[0]!.image.url!;
  expect(url).toBe(`/api/image?prototype=${id}&media=${view.variants[0]!.frames[0]!.image.id}`);
  const image = await imageGET(request(url));
  expect(image.status).toBe(200);
  expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
});

test("a task-bound decision message stays byte for byte", () => {
  const round = { title: "Before work", taskId: "task-review", variants: [], questions: one } as unknown as PrototypeReviewRound;
  const text = prototypeDecisionText({ id: "task-review", text: "Review layout\nDetails" }, round, { chosen: [], answers: [{ questionId: "deploy", options: [0] }], comment: "Go" });
  expect(text).toBe("Prototype review decision\nTask: task-review — Review layout\nRound: Before work\n\nAnswers:\n1. Deploy now?\n   a) Now (recommended)\n\nComment:\nGo\n\nEnd of prototype review decision.");
});

test("the decision column rejects task variants with required corrections and delivers rejection to the seat", async () => {
  const root = await fs.mkdtemp(path.join(process.env.HOME!, "form-source-")); roots.push(root);
  await fs.writeFile(path.join(root, "v1.png"), PNG);
  const publisher: PrototypeWorld = { ...seat, pipeline: () => criticLane(), stage: () => ({ taskIds: ["task-prototype"], project: "project-a",
    source: { conversationId: "conversation_seat", pipelineId: "prototype-lane", stageId: "publish", attempt: 1 } }) };
  const published = await publishAs(publisher, { clientRequestId: "form-variants", title: "Layout", questions,
    variants: [{ number: 1, name: "Compact", description: "Tight.", frames: [{ path: path.join(root, "v1.png"), caption: "Controls" }] }] });
  expect(published.status).toBe(200);
  const reviewId = (await published.json()).reviewId as string;
  expect(loadTasks()[0]!.prototypeReviews![0]!.critic?.outcome).toBe("passed");
  const answers = questions.map(q => ({ questionId: q.id, options: [0] }));
  const { sent, delivery } = recorder();
  const body = { project: "project-a", reviewId, reject: true, chosen: [], answers, comment: "  Simplify all variants.  " };
  for (const invalid of [{ ...body, comment: " " }, { ...body, chosen: [1] }]) {
    expect((await decisionsPOST(request("/api/projects/decisions", invalid), operator, delivery)).status).toBe(400);
    expect((await decisions()).decisions.map(d => d.id)).toEqual([reviewId]);
  }
  expect(sent).toEqual([]);
  expect((await decisionsPOST(request("/api/projects/decisions", body), operator, delivery)).status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Rejected: none of the variants fits.");
  expect(sent[0]).toContain("Corrections:\n  Simplify all variants.  ");
  expect(sent[0]).not.toContain("Chosen:");
  expect((await decisions()).decisions).toEqual([]);
  expect((await decisions("project-a", reviewId)).round?.decision).toMatchObject({ rejected: true, chosen: [], answers, delivery: { state: "sent" } });
});

test("an answered seat question's record takes the receipt's word on every read, and no read sends again", async () => {
  const seatId = (await (await publishAs(seat, { clientRequestId: "seat-q", title: "Deploy now?", questions: one })).json()).reviewId as string;
  let sends = 0;
  let recovers = 0;
  let receipt: { state: "pending" | "sent" | "failed" | "uncertain"; operationId: string } = { state: "pending", operationId: "operation-1" };
  const delivery = {
    recover: async () => { recovers++; return receipt; },
    send: async () => { sends++; return { state: "pending" as const, operationId: "operation-1" }; },
    retry: async () => { throw new Error("a read never retries"); },
  };
  const answers = [{ questionId: "deploy", options: [1] }];
  expect((await decisionsPOST(request("/api/projects/decisions", { project: "project-a", reviewId: seatId, chosen: [], comment: "", answers }), operator, delivery)).status).toBe(200);
  expect(loadSeatRounds("project-a")[0]!.decision!.delivery).toMatchObject({ state: "pending", operationId: "operation-1" });
  const record = async () => (await (await decisionsGET(request("/api/projects/decisions"), "project-a", operator, seatId, delivery)).json() as OperatorDecisionsRead).round!.decision!.delivery;
  const seatRead = async () => (await (await reviewReadPOST(request("/api/prototype-reviews/read", {}), seat, delivery)).json() as PrototypeReviewRead).rounds[0]!.decision!.delivery;
  for (const state of ["uncertain", "failed", "sent"] as const) {
    receipt = { state, operationId: "operation-1" };
    expect(await record()).toMatchObject({ state, retryable: state !== "sent" });
    expect(await seatRead()).toMatchObject({ state, retryable: state !== "sent" });
  }
  const afterSent = recovers;
  expect(await record()).toMatchObject({ state: "sent", retryable: false });
  expect(recovers).toBe(afterSent);
  expect(sends).toBe(1);
});

test("a seat question whose answer did not reach the seat is sent again from its record, once, with the saved message", async () => {
  const seatId = (await (await publishAs(seat, { clientRequestId: "seat-q", title: "Deploy now?", questions: one })).json()).reviewId as string;
  const sent: string[] = [];
  let fail = true;
  const delivery = {
    recover: async () => null,
    send: async (decision: PrototypeDecision) => {
      if (fail) throw new Error("the host went away");
      sent.push(decision.delivery.text);
      return { state: "sent" as const, operationId: "operation-2" };
    },
    retry: async () => { throw new Error("nothing was admitted to retry"); },
  };
  const answers = [{ questionId: "deploy", options: [1] }];
  await decisionsPOST(request("/api/projects/decisions", { project: "project-a", reviewId: seatId, chosen: [], comment: "Later", answers }), operator, delivery);
  const saved = loadSeatRounds("project-a")[0]!.decision!;
  expect(saved.delivery.state).toBe("uncertain");
  fail = false;
  for (let press = 0; press < 2; press++) {
    expect((await decisionsPOST(request("/api/projects/decisions", { project: "project-a", reviewId: seatId, retry: true }), operator, delivery)).status).toBe(200);
  }
  expect(sent).toEqual([saved.delivery.text]);
  expect(loadSeatRounds("project-a")[0]!.decision).toMatchObject({ comment: "Later", answers, delivery: { state: "sent", operationId: "operation-2" } });
});

test("an answer saved while the project had no seat is sent from its record once a seat stands", async () => {
  const seatId = (await (await publishAs(seat, { clientRequestId: "seat-q", title: "Deploy now?", questions: one })).json()).reviewId as string;
  const { sent, delivery } = recorder();
  const vacant: PrototypeWorld = { ...prototypeWorld, orchestrator: () => null };
  await decisionsPOST(request("/api/projects/decisions", { project: "project-a", reviewId: seatId, chosen: [], comment: "", answers: [{ questionId: "deploy", options: [0] }] }), vacant, delivery);
  expect((await (await decisionsGET(request("/api/projects/decisions"), "project-a", vacant, seatId, delivery)).json() as OperatorDecisionsRead).round!.decision!.delivery).toMatchObject({ state: "no-orchestrator", retryable: true });
  expect(sent).toEqual([]);
  await decisionsPOST(request("/api/projects/decisions", { project: "project-a", reviewId: seatId, retry: true }), operator, delivery);
  expect(sent).toHaveLength(1);
  expect(loadSeatRounds("project-a")[0]!.decision!.delivery).toMatchObject({ state: "sent", conversationId: "conversation_seat" });
});


test("the decision column accepts task and seat answers while background sends are held", async () => {
  const seatId = (await (await publishAs(seat, { clientRequestId: "seat-held", title: "Deploy now?", questions })).json()).reviewId as string;
  const taskId = (await (await publishAs(operator, { clientRequestId: "task-held", taskId: "task-prototype", title: "Deploy now?", questions })).json()).reviewId as string;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const delivery = { recover: async () => null, send: async (decision: PrototypeDecision) => {
    sent.push(decision.delivery.text); await gate; return { state: "sent" as const };
  }, retry: async () => { throw new Error("nothing failed"); } };
  try {
    for (const reviewId of [seatId, taskId]) {
      const response = await decisionsRoutePOST(request("/api/projects/decisions", { project: "project-a", reviewId, chosen: [], comment: "", answers: questions.map(q => ({ questionId: q.id, options: [0] })) }), operator, delivery);
      expect(response.status).toBe(200);
      expect((await response.json() as OperatorDecisionsRead).decisions.some(round => round.id === reviewId)).toBe(false);
    }
    expect(loadSeatRounds()[0]!.decision!.delivery.state).toBe("pending");
    expect(loadTasks()[0]!.prototypeReviews![0]!.decision!.delivery.state).toBe("pending");
    for (let n = 0; sent.length < 2 && n < 200; n++) await Bun.sleep(5);
    expect(sent).toHaveLength(2);
  } finally { release(); await settlePrototypeDeliveriesForTests(); }
  expect(loadSeatRounds()[0]!.decision!.delivery.state).toBe("sent");
  expect(loadTasks()[0]!.prototypeReviews![0]!.decision!.delivery.state).toBe("sent");
});

test("a restart sweeps a taskless answer and follows its uncertain receipt to delivery once", async () => {
  const id = (await (await publishAs(seat, { clientRequestId: "seat-restart", title: "Deploy now?", questions: one })).json()).reviewId as string;
  expect(decidePrototype(request("/api/projects/decisions"), null, { reviewId: id, chosen: [], comment: "", answers: [{ questionId: "deploy", options: [0] }] }, operator)).toBe(true);
  await resetPrototypeDeliveryWorkerForTests();
  let sends = 0;
  let state: "uncertain" | "sent" = "uncertain";
  const ports = { world: operator, now: Date.now, delivery: { recover: async () => ({ state, operationId: "operation-sweep" }),
    send: async () => { sends++; return { state: "uncertain" as const, operationId: "operation-sweep" }; }, retry: async () => { throw new Error("nothing failed"); } } };
  await sweepPrototypeDeliveries(ports, { force: true });
  expect(loadSeatRounds()[0]!.decision!.delivery.state).toBe("uncertain");
  state = "sent";
  await resetPrototypeDeliveryWorkerForTests();
  await sweepPrototypeDeliveries(ports, { force: true });
  expect(loadSeatRounds()[0]!.decision!.delivery.state).toBe("sent");
  await sweepPrototypeDeliveries(ports, { force: true });
  expect(sends).toBe(1);
});


test("a held receipt refresh cannot settle a newer amendment", async () => {
  const id = (await (await publishAs(seat, { clientRequestId: "seat-amend", title: "Deploy now?", questions: one })).json()).reviewId as string;
  const answers = [{ questionId: "deploy", options: [0] }];
  const initial = { recover: async () => null, send: async () => ({ state: "pending" as const }), retry: async () => ({ state: "sent" as const }) };
  await decisionsPOST(request("/api/projects/decisions", { project: "project-a", reviewId: id, chosen: [], comment: "First", answers }), operator, initial);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const delivery = { recover: async () => { entered(); await gate; return { state: "sent" as const }; },
    send: async (decision: PrototypeDecision) => { sent.push(decision.delivery.text); return { state: "sent" as const }; }, retry: initial.retry };
  const read = decisionsGET(request("/api/projects/decisions"), "project-a", operator, id, delivery);
  try {
    await started;
    const response = await decisionsRoutePOST(request("/api/projects/decisions", { project: "project-a", reviewId: id, chosen: [], comment: "Second", answers }), operator, delivery);
    expect(response.status).toBe(200);
    expect(loadSeatRounds()[0]!.decision!.delivery.state).toBe("pending");
  } finally { release(); await read; await settlePrototypeDeliveriesForTests(); }
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Operator decision (amended)");
  expect(sent[0]).toContain("Second");
  expect(loadSeatRounds()[0]!.decision).toMatchObject({ comment: "Second", revision: 2, delivery: { state: "sent" } });
});
