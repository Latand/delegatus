import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { prototypeButtonState } from "@/components/prototypeReview/prototypeReviewStore";
import { publishPOST as gatedPublishPOST, reviewGET, reviewPOST } from "./http";
import { decidePrototype, type PrototypeDelivery, type PrototypeDeliveryPorts, type PrototypeDeliveryResult } from "./decision";
import { PROTOTYPE_DELIVERY_BACKOFF_MS, PROTOTYPE_DELIVERY_IN_FLIGHT_MS, prototypeDeliveryDelay, resetPrototypeDeliveryWorkerForTests, settlePrototypeDeliveriesForTests, sweepPrototypeDeliveries } from "./deliveryWorker";
import { PROTOTYPE_DELIVERY_ATTENTION_MS, prototypeDeliveryPhase, prototypeReviewNotices, prototypeReviewReplica } from "./model";
import { isPrototypeReplica } from "./replica";
import { withPrototypeReviewSummaries } from "./read";
import { prototypeWorld, type PrototypeWorld } from "./world";
import type { PrototypeDecision, PrototypeReviewRead } from "./types";

import { criticLane } from "./criticGate.fixture";
import * as telegramPost from "./telegramPost";
import * as telegramService from "@/lib/telegram/bot/service";
const publishPOST: typeof gatedPublishPOST = (request, world) => gatedPublishPOST(request, world ?? {
  caller: () => ({ conversationId: "conversation_publisher", project: "project-a" }),
  stage: () => ({ taskIds: [TASK], project: "project-a", source: { conversationId: "conversation_publisher", pipelineId: "prototype-lane", stageId: "publish" } }),
  pipeline: () => criticLane(), orchestrator: () => null,
});

const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const TASK = "task-delivery";
const roots: string[] = [];
function task() { return { id: TASK, project: "project-a", status: "inbox" as const, placement: "unplaced" as const, text: "Pick the layout", assignments: [], sources: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }; }
function request(body?: unknown) {
  return new NextRequest(`http://localhost/api/tasks/${TASK}/prototypes`, { headers: { host: "localhost", "sec-fetch-site": "same-origin" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
}
beforeEach(async () => { await resetPrototypeDeliveryWorkerForTests(); saveTasks([task()]); });
afterEach(async () => { await resetPrototypeDeliveryWorkerForTests(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function publish(key: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.HOME!, "prototype-delivery-")); roots.push(root);
  await fs.writeFile(path.join(root, "variant-1-390-en.png"), PNG); await fs.writeFile(path.join(root, "variant-2-390-en.png"), PNG);
  const response = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({
    taskId: TASK, clientRequestId: key, title: "Layout", dir: root, variants: [{ number: 1, name: "Compact", description: "Tight." }, { number: 2, name: "Roomy", description: "Airy." }] }) }));
  expect(response.status).toBe(200);
  return (await response.json()).reviewId as string;
}
const stored = (reviewId: string) => loadTasks()[0]!.prototypeReviews!.find(round => round.id === reviewId)!.decision!;
const shown = async (reviewId: string) => ((await (await reviewGET(request(), TASK)).json()) as PrototypeReviewRead).rounds.find(round => round.id === reviewId)!.decision!;

/** A seat that can be taken away and given back, answering as the production send path does. */
function seat(world: Partial<PrototypeWorld> = {}) {
  const state = { up: true, sends: [] as PrototypeDecision[], retries: 0, clock: Date.now(), seat: "conversation_seat" as string | null };
  const delivery: PrototypeDelivery = {
    recover: async () => null,
    send: async decision => {
      state.sends.push(structuredClone(decision));
      return state.up ? { state: "sent", operationId: `operation-${state.sends.length}` } : { state: "failed" };
    },
    retry: async () => { state.retries += 1; return { state: "sent" }; },
  };
  const ports: PrototypeDeliveryPorts = { delivery, world: { ...prototypeWorld, orchestrator: () => state.seat, ...world }, now: () => state.clock };
  return { state, ports };
}

test("a decision answers before its message reaches the seat: the save returns with the record kept while the send is still held", async () => {
  const id = await publish("held");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const world = { ...prototypeWorld, orchestrator: () => "conversation_seat" };
  const delivery: PrototypeDelivery = { recover: async () => null, send: async () => { sends += 1; await gate; return { state: "sent", operationId: "operation-1" }; }, retry: async () => { throw new Error("nothing failed"); } };
  const response = await reviewPOST(request({ reviewId: id, chosen: [2, 1], comment: "  Both, roomier.\n" }), TASK, world, delivery);
  expect(response.status).toBe(200);
  const answer = (await response.json() as PrototypeReviewRead).rounds.find(round => round.id === id)!.decision!;
  expect(answer).toMatchObject({ chosen: [1, 2], comment: "  Both, roomier.\n", delivery: { state: "pending", phase: "saved" } });
  expect(stored(id)).toMatchObject({ chosen: [1, 2], revision: 1, decidedBy: { kind: "operator" }, delivery: { conversationId: "conversation_seat", clientMessageId: `prototype-decision:${id}` } });
  for (let n = 0; sends === 0 && n < 200; n += 1) await Bun.sleep(5);
  expect(sends).toBe(1);
  expect((await shown(id)).delivery).toMatchObject({ state: "pending", phase: "delivering" });
  release();
  await settlePrototypeDeliveriesForTests();
  expect((await shown(id)).delivery).toMatchObject({ state: "sent", phase: "delivered" });
  expect(stored(id).delivery).toMatchObject({ state: "sent", operationId: "operation-1" });
  expect(sends).toBe(1);
});

test("a seat that cannot be reached: attempts back off in the background and the message lands once the seat is back", async () => {
  const id = await publish("unreachable");
  const { state, ports } = seat();
  state.up = false;
  expect((await reviewPOST(request({ reviewId: id, chosen: [1], comment: "One." }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(stored(id).delivery).toMatchObject({ state: "failed", failures: 1 });
  expect((await shown(id)).delivery.phase).toBe("delivering");
  // Nothing is due before the backoff has passed.
  await sweepPrototypeDeliveries(ports);
  expect(state.sends).toHaveLength(1);
  state.clock += PROTOTYPE_DELIVERY_BACKOFF_MS[0];
  await sweepPrototypeDeliveries(ports);
  expect(state.sends).toHaveLength(2);
  expect(stored(id).delivery.failures).toBe(2);
  state.clock += PROTOTYPE_DELIVERY_BACKOFF_MS[0];
  await sweepPrototypeDeliveries(ports);
  expect(state.sends).toHaveLength(2);
  state.up = true;
  state.clock += PROTOTYPE_DELIVERY_BACKOFF_MS[1];
  await sweepPrototypeDeliveries(ports);
  expect(state.sends).toHaveLength(3);
  expect(stored(id).delivery).toMatchObject({ state: "sent", operationId: "operation-3" });
  expect(stored(id).delivery.failures).toBeUndefined(); expect(stored(id).delivery.failingSince).toBeUndefined();
  expect(new Set(state.sends.map(decision => decision.delivery.clientMessageId))).toEqual(new Set([`prototype-decision:${id}`]));
  state.clock += 3_600_000;
  await sweepPrototypeDeliveries(ports, { force: true });
  expect(state.sends).toHaveLength(3);
});

test("a Viewer stopped right after recording a decision: the next boot's sweep delivers it once", async () => {
  const id = await publish("restart");
  const { state, ports } = seat();
  // Recorded by the stopped process, which never reached its attempt.
  expect(decidePrototype(request(), TASK, { reviewId: id, chosen: [2], comment: "Two." }, ports.world)).toBe(true);
  expect(stored(id).delivery).toMatchObject({ state: "pending", conversationId: "conversation_seat" });
  expect(stored(id).delivery.dispatchedAt).toBeUndefined();
  expect((await shown(id)).delivery.phase).toBe("saved");
  await resetPrototypeDeliveryWorkerForTests();
  await sweepPrototypeDeliveries(ports, { force: true });
  expect(state.sends).toHaveLength(1);
  expect(stored(id).delivery.state).toBe("sent");
  for (let n = 0; n < 3; n += 1) await sweepPrototypeDeliveries(ports, { force: true });
  expect(state.sends).toHaveLength(1);
});

test("a seat that rotated before the message was handed over gets it; the seat named at decision time does not", async () => {
  const id = await publish("rotated");
  const { state, ports } = seat();
  decidePrototype(request(), TASK, { reviewId: id, chosen: [1], comment: "" }, ports.world);
  state.seat = "conversation_successor";
  await sweepPrototypeDeliveries(ports, { force: true });
  expect(state.sends.map(decision => decision.delivery.conversationId)).toEqual(["conversation_successor"]);
  expect(stored(id).delivery.conversationId).toBe("conversation_successor");
});

test("the same decision again is a no-op: concurrent saves keep one record and send one message", async () => {
  const id = await publish("duplicate");
  const { state, ports } = seat();
  const save = () => reviewPOST(request({ reviewId: id, chosen: [2, 1], comment: "Both." }), TASK, ports.world, ports.delivery, ports.now);
  const answers = await Promise.all([save(), save(), save()]);
  expect(answers.map(answer => answer.status)).toEqual([200, 200, 200]);
  const at = stored(id).at;
  await settlePrototypeDeliveriesForTests();
  expect((await save()).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(state.sends).toHaveLength(1);
  expect(stored(id)).toMatchObject({ revision: 1, at, chosen: [1, 2], delivery: { state: "sent" } });
});

test("a changed decision replaces one never handed to the seat, and goes as an amendment once one was", async () => {
  const id = await publish("changed");
  const { state, ports } = seat();
  state.seat = null;
  expect((await reviewPOST(request({ reviewId: id, chosen: [1], comment: "First thought." }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(stored(id).delivery.state).toBe("no-orchestrator");
  expect((await shown(id)).delivery.phase).toBe("waiting-seat");
  expect((await reviewPOST(request({ reviewId: id, chosen: [2], comment: "Second thought." }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(stored(id)).toMatchObject({ revision: 2, chosen: [2], comment: "Second thought.", delivery: { clientMessageId: `prototype-decision:${id}:2` } });
  expect(stored(id).delivery.text).not.toContain("amended");
  state.seat = "conversation_seat";
  await sweepPrototypeDeliveries(ports, { force: true });
  expect(state.sends.map(decision => decision.comment)).toEqual(["Second thought."]);
  expect((await reviewPOST(request({ reviewId: id, chosen: [1, 2], comment: "Third thought." }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(state.sends).toHaveLength(2);
  const amendment = state.sends[1]!;
  expect(amendment.delivery.clientMessageId).toBe(`prototype-decision:${id}:3`);
  expect(amendment.delivery.text).toStartWith(`Prototype review decision (amended)\nThis replaces the decision of ${state.sends[0]!.at} on the same round.\nTask: ${TASK}`);
  expect(amendment.delivery.text).toContain("Chosen: 1 — Compact, 2 — Roomy\n\nComment:\nThird thought.\n");
  expect(stored(id)).toMatchObject({ revision: 3, delivery: { state: "sent" } });
});

test("a delivery that keeps failing asks for attention on the review, the card and the needs-you list; a retry and a landing clear it", async () => {
  const id = await publish("failing");
  const { state, ports } = seat();
  state.up = false;
  state.clock = Date.now() - PROTOTYPE_DELIVERY_ATTENTION_MS - 60_000;
  expect((await reviewPOST(request({ reviewId: id, chosen: [2], comment: "Two." }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  const since = Date.parse(stored(id).delivery.failingSince!);
  expect(since).toBe(state.clock);
  // Quiet inside the window: the review says it is on its way, the card is decided and nothing waits.
  expect(prototypeDeliveryPhase(stored(id).delivery, since + PROTOTYPE_DELIVERY_ATTENTION_MS - 1)).toBe("delivering");
  expect(prototypeReviewNotices(loadTasks(), since + PROTOTYPE_DELIVERY_ATTENTION_MS - 1)).toEqual([]);
  expect(prototypeButtonState(withPrototypeReviewSummaries(loadTasks(), new Map(), since + PROTOTYPE_DELIVERY_ATTENTION_MS - 1)[0]!.prototypeReview, new Set())).toBe("decided");
  // Past it the failure is surfaced everywhere the operator looks.
  for (const step of PROTOTYPE_DELIVERY_BACKOFF_MS.slice(0, 4)) { state.clock += step; await sweepPrototypeDeliveries(ports); }
  expect(stored(id).delivery.failures).toBe(5);
  const view = await shown(id);
  expect(view.delivery).toMatchObject({ state: "failed", phase: "attention" });
  const summary = withPrototypeReviewSummaries(loadTasks())[0]!.prototypeReview;
  expect(summary?.decision?.phase).toBe("attention");
  expect(prototypeButtonState(summary, new Set())).toBe("unsent");
  expect(prototypeReviewNotices(loadTasks())).toEqual([expect.objectContaining({ id: `prototype-delivery:${id}`, reviewId: id, undelivered: true, target: { kind: "prototype-review", taskId: TASK, reviewId: id } })]);
  // The client computes the same notice from the board's summary alone.
  expect(prototypeReviewNotices(withPrototypeReviewSummaries(loadTasks()) as never)).toHaveLength(1);
  // The operator's retry starts the wait over and sends at once.
  state.clock = Date.now();
  expect((await reviewPOST(request({ reviewId: id, retry: true }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(state.sends).toHaveLength(6);
  expect((await shown(id)).delivery.phase).toBe("delivering");
  expect(prototypeReviewNotices(loadTasks())).toEqual([]);
  state.up = true;
  state.clock += PROTOTYPE_DELIVERY_BACKOFF_MS[0];
  await sweepPrototypeDeliveries(ports);
  expect((await shown(id)).delivery).toMatchObject({ state: "sent", phase: "delivered" });
  expect(prototypeReviewNotices(loadTasks())).toEqual([]);
});

test("a message the seat admitted and holds behind its running turn is asked about, never sent again", async () => {
  const id = await publish("in-flight");
  const { state, ports } = seat();
  let answer: PrototypeDeliveryResult = { state: "pending", operationId: "operation-queued" };
  ports.delivery.send = async decision => { state.sends.push(decision); return answer; };
  let recovers = 0;
  ports.delivery.recover = async () => { recovers += 1; return answer; };
  expect((await reviewPOST(request({ reviewId: id, chosen: [1], comment: "" }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(stored(id).delivery).toMatchObject({ state: "pending", operationId: "operation-queued" });
  expect((await shown(id)).delivery.phase).toBe("delivering");
  for (let n = 0; n < 3; n += 1) { state.clock += 3_000; await sweepPrototypeDeliveries(ports); }
  expect(recovers).toBe(3);
  answer = { state: "sent", operationId: "operation-queued" };
  state.clock += 3_000;
  await sweepPrototypeDeliveries(ports);
  expect(stored(id).delivery.state).toBe("sent");
  expect(state.sends).toHaveLength(1);
});

test("a decided round's replica for linked installations carries its state only: no decider, revision, delivery bookkeeping or phase", async () => {
  const id = await publish("replica");
  const { state, ports } = seat();
  state.up = false;
  expect((await reviewPOST(request({ reviewId: id, chosen: [1], comment: "One." }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(stored(id).delivery.failingSince).toBeString();
  const replica = prototypeReviewReplica(loadTasks()[0]!)!;
  expect(isPrototypeReplica(replica, TASK, "project-a")).toBe(true);
  const wire = JSON.stringify(replica);
  for (const key of ["decidedBy", "revision", "dispatchedAt", "failures", "failingSince", "phase", "clientMessageId"]) expect(wire).not.toContain(key);
});

test("retries the runtime admits that each end failed keep their failure history: they back off and ask for attention under one identity", async () => {
  const id = await publish("admitted-failing");
  const { state, ports } = seat();
  state.clock = Date.now() - PROTOTYPE_DELIVERY_ATTENTION_MS - 3_600_000;
  ports.delivery.send = async decision => { state.sends.push(structuredClone(decision)); return { state: "pending", operationId: "operation-admitted" }; };
  let recovers = 0;
  ports.delivery.recover = async () => { recovers += 1; return { state: "failed", operationId: "operation-admitted" }; };
  ports.delivery.retry = async () => { state.retries += 1; return { state: "pending", operationId: "operation-admitted" }; };
  expect((await reviewPOST(request({ reviewId: id, chosen: [2], comment: "Two." }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(stored(id).delivery).toMatchObject({ state: "pending", operationId: "operation-admitted" });
  expect(stored(id).delivery.failures).toBeUndefined();
  const started = state.clock;
  // Every later look finds the admitted attempt failed and the runtime admits another.
  for (let n = 1; n <= 7; n += 1) {
    state.clock += n === 1 ? PROTOTYPE_DELIVERY_IN_FLIGHT_MS : PROTOTYPE_DELIVERY_BACKOFF_MS[n - 2]!;
    await sweepPrototypeDeliveries(ports);
  }
  expect(recovers).toBe(7);
  expect(state.retries).toBe(7);
  expect(state.sends).toHaveLength(1);
  const delivery = stored(id).delivery;
  expect(delivery).toMatchObject({ state: "pending", operationId: "operation-admitted", clientMessageId: `prototype-decision:${id}`, failures: 7 });
  expect(Date.parse(delivery.failingSince!)).toBe(started + PROTOTYPE_DELIVERY_IN_FLIGHT_MS);
  // The next attempt waits out the accumulated backoff, not the in-flight poll.
  expect(prototypeDeliveryDelay(delivery)).toBe(PROTOTYPE_DELIVERY_BACKOFF_MS.at(-1)!);
  state.clock += PROTOTYPE_DELIVERY_IN_FLIGHT_MS;
  await sweepPrototypeDeliveries(ports);
  expect(recovers).toBe(7);
  // Surfaced on the review, the card and the needs-you list.
  expect((await shown(id)).delivery.phase).toBe("attention");
  const summary = withPrototypeReviewSummaries(loadTasks())[0]!.prototypeReview;
  expect(prototypeButtonState(summary, new Set())).toBe("unsent");
  expect(prototypeReviewNotices(loadTasks())).toEqual([expect.objectContaining({ id: `prototype-delivery:${id}`, undelivered: true })]);
  // The operator's explicit retry clears the attention; a confirmed landing keeps it clear.
  state.clock = Date.now();
  expect((await reviewPOST(request({ reviewId: id, retry: true }), TASK, ports.world, ports.delivery, ports.now)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(prototypeReviewNotices(loadTasks())).toEqual([]);
  ports.delivery.recover = async () => ({ state: "sent", operationId: "operation-admitted" });
  await sweepPrototypeDeliveries(ports, { force: true });
  expect(stored(id).delivery).toMatchObject({ state: "sent", operationId: "operation-admitted" });
  expect(stored(id).delivery.failures).toBeUndefined(); expect(stored(id).delivery.failingSince).toBeUndefined();
  expect((await shown(id)).delivery.phase).toBe("delivered");
});


test("bounded delivery passes rotate permanently due decisions and recover after worker reset", async () => {
  const roundId = (n: number) => `pr_${n.toString(16).padStart(32, "0")}`;
  const seed = await publish("bounded-seed");
  const { ports, state } = seat();
  decidePrototype(request(), TASK, { reviewId: seed, chosen: [1], comment: "" }, ports.world);
  const template = loadTasks()[0]!;
  const round = template.prototypeReviews![0]!;
  saveTasks(Array.from({ length: 40 }, (_, n) => ({ ...template, id: `bounded-${n}`,
    prototypeReviews: [{ ...round, id: roundId(n), taskId: `bounded-${n}`,
      decision: { ...round.decision!, delivery: { ...round.decision!.delivery, clientMessageId: `bounded-${n}`, operationId: `operation-${n}` } } }] })));
  const seen: string[] = [];
  ports.delivery = { recover: async decision => { seen.push(decision.delivery.clientMessageId); return { state: "pending" }; },
    send: async () => { throw new Error("already admitted"); }, retry: async () => { throw new Error("already pending"); } };
  for (let pass = 0; pass < 6; pass++) {
    const before = seen.length;
    await sweepPrototypeDeliveries(ports, { force: true, limit: 16 });
    expect(seen.length - before).toBeLessThanOrEqual(16);
  }
  expect(new Set(seen).size).toBe(40);
  await resetPrototypeDeliveryWorkerForTests();
  seen.length = 0;
  await sweepPrototypeDeliveries(ports, { force: true, limit: 16 });
  expect(seen).toHaveLength(16);
  expect(state.sends).toHaveLength(0);
  const childSource = `
    import { sweepPrototypeDeliveries, startPrototypeDeliveryWorker, settlePrototypeDeliveriesForTests, resetPrototypeDeliveryWorkerForTests } from ${JSON.stringify(new URL("./deliveryWorker.ts", import.meta.url).pathname)};
    const counts = []; let calls = 0;
    const ports = { now: () => Date.parse("2030-01-01T00:00:00.000Z"),
      world: { orchestrator: () => "conversation_seat" },
      delivery: { recover: async decision => { calls++; return { state: "pending", operationId: decision.delivery.operationId }; },
        send: async () => { throw new Error("already admitted"); }, retry: async () => { throw new Error("already pending"); } } };
    startPrototypeDeliveryWorker(ports);
    await new Promise(resolve => setImmediate(resolve));
    await settlePrototypeDeliveriesForTests(); counts.push(calls);
    for (let n = 0; n < 2; n++) { const before = calls; await sweepPrototypeDeliveries(ports, { force: true, limit: 16 }); counts.push(calls-before); }
    await resetPrototypeDeliveryWorkerForTests();
    console.log(JSON.stringify({ counts }));
  `;
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawnSync([process.execPath, "-e", childSource], { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(new TextDecoder().decode(child.stdout)) as { counts: number[] };
    expect(result.counts).toEqual([16, 16, 16]);
  }
});

test("pending Telegram posts rotate across rounds when earlier post locks keep refusing", async () => {
  const template = task();
  const rounds = Array.from({ length: 17 }, (_, n) => {
    const id = `pr_${(n + 1).toString(16).padStart(32, "0")}`;
    return { id, taskId: TASK, project: "project-a", title: `Round ${n + 1}`, createdAt: "2026-10-01T00:00:00Z",
      publicationKey: id, inputDigest: "fixture", source: { conversationId: null }, variants: [],
      telegramPost: { key: id, state: "pending" as const, at: "2026-10-01T00:00:00Z" } };
  });
  saveTasks([{ ...template, prototypeReviews: rounds }]);
  const seen: string[] = [];
  const post = spyOn(telegramPost, "postPrototypeReviewToTelegram").mockImplementation(async round => {
    seen.push(round.id);
    throw new Error("Telegram review post is busy");
  });
  try {
    for (let pass = 0; pass < 3; pass++) {
      const before = seen.length;
      try { await sweepPrototypeDeliveries({ now: () => Date.parse("2026-10-02T00:00:00Z"), delivery: { recover: async () => null,
        send: async () => ({ state: "sent" as const }), retry: async () => ({ state: "sent" as const }) }, world: { ...prototypeWorld, orchestrator: () => null } }, { force: true, limit: 16 }); }
      catch { /* The lock refusal is the behavior under test. */ }
      expect(seen.length - before).toBeLessThanOrEqual(16);
    }
  } finally { post.mockRestore(); }
  expect(seen.length).toBeLessThanOrEqual(48);
  expect(seen).toContain(rounds[16]!.id);
});

test("poll recovery rotates across rounds whose poll locks remain owned", async () => {
  const template = task();
  const rounds = Array.from({ length: 17 }, (_, n) => {
    const id = `pr_${(n + 1).toString(16).padStart(32, "0")}`;
    return { id, taskId: TASK, project: "project-a", title: `Round ${n + 1}`, createdAt: "2026-10-01T00:00:00Z",
      publicationKey: id, inputDigest: "fixture", source: { conversationId: null }, variants: [],
      questions: [{ id: "question", text: "Choose?", options: [{ label: "Yes" }] }],
      telegramPost: { key: id, state: "sent" as const, at: "2026-10-01T00:00:00Z" },
      telegramPolls: { key: id, questions: [{ questionId: "question", state: "pending" as const }] } };
  });
  saveTasks([{ ...template, prototypeReviews: rounds }]);
  const seen: string[] = [];
  const service = spyOn(telegramService, "telegramBotService").mockReturnValue({
    hasReviewPollWork: (id: string) => { seen.push(id); return true; },
  } as unknown as ReturnType<typeof telegramService.telegramBotService>);
  try {
    for (let pass = 0; pass < 3; pass++) {
      const before = seen.length;
      await sweepPrototypeDeliveries({ now: () => Date.parse("2026-10-02T00:00:00Z"), delivery: { recover: async () => null,
        send: async () => ({ state: "sent" as const }), retry: async () => ({ state: "sent" as const }) }, world: { ...prototypeWorld, orchestrator: () => null } }, { force: true, limit: 16 });
      expect(seen.length - before).toBeLessThanOrEqual(16);
    }
  } finally { service.mockRestore(); }
  expect(seen.length).toBeLessThanOrEqual(48);
  expect(seen).toContain(rounds[16]!.id);
});
