import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { GET as imageGET } from "@/app/api/image/route";
import { decisionsGET, decisionsPOST, publishPOST, reviewReadPOST, reviewScopePOST } from "./http";
import { prototypeDecisionText } from "./decision";
import { seatDecisionNotices } from "./read";
import { prototypeReviewNotices } from "./model";
import { roundDirectory } from "./store";
import { clearSeatRoundsForTests, loadSeatRounds } from "./seatRounds";
import { prototypeWorld, type PrototypeWorld } from "./world";
import type { OperatorDecisionsRead, PrototypeDecision, PrototypeReviewRead, PrototypeReviewRound, PublishPrototypeInput } from "./types";
import { questions } from "./questionnaire.fixture";

/* docs/design/operator-decision-forms.md §2.1–§2.2: the project's seat asks
   without a task, through the same store, route and message. */

const roots: string[] = [];
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
function task() { return { id: "task-prototype", project: "project-a", status: "inbox" as const, placement: "unplaced" as const, text: "Review layout", assignments: [], sources: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }; }
beforeEach(() => { saveTasks([task()]); clearSeatRoundsForTests(); });
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function request(url: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, { headers: { host: "localhost", "sec-fetch-site": "same-origin" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
}
const seat: PrototypeWorld = { caller: () => ({ conversationId: "conversation_seat", project: "project-a" }), stage: () => null, orchestrator: () => "conversation_seat" };
const operator: PrototypeWorld = { ...prototypeWorld, orchestrator: () => "conversation_seat" };
const one = [{ id: "deploy", text: "Deploy now?", options: [{ label: "Now", recommended: true }, { label: "Tonight" }] }];
function recorder() {
  const sent: string[] = [];
  return { sent, delivery: { recover: async () => null, send: async (_request: NextRequest, decision: PrototypeDecision) => { sent.push(decision.delivery.text); return { state: "sent" as const }; }, retry: async () => ({ state: "sent" as const }) } };
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

test("one question is a round, with or without a task", async () => {
  const response = await publishAs(operator, { clientRequestId: "one", taskId: "task-prototype", title: "Deploy now?", questions: one });
  expect(response.status).toBe(200);
  expect(loadTasks()[0]!.prototypeReviews![0]!.questions).toHaveLength(1);
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

test("a seat round's pictures are served without a task and survive another publication's cleanup", async () => {
  const root = await fs.mkdtemp(path.join(process.env.HOME!, "seat-source-")); roots.push(root);
  await fs.writeFile(path.join(root, "v1.png"), PNG);
  const id = (await (await publishAs(seat, { clientRequestId: "seat-frames", title: "Which layout?", questions: one,
    variants: [{ number: 1, name: "Compact", description: "Tight.", frames: [{ path: path.join(root, "v1.png"), caption: "" }] }] })).json()).reviewId as string;
  /* A task publication sweeps orphan copies under the same lock. */
  await publishAs(operator, { clientRequestId: "task-q", taskId: "task-prototype", title: "Before work", questions: one });
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
