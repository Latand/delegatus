import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { startComposerPayloadRuntime, type ComposerPayloadRuntime } from "@/lib/runtime/fixtures/composerPayloadRuntime";
import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { saveTasks, loadTasks, TASKS_FILE } from "@/lib/tasks/store";
import { setConversationHostDependenciesForTests } from "@/app/api/conversation-host/dependencies";
import { publishPOST as gatedPublishPOST, reviewGET, reviewPOST } from "./http";
import { decidePrototype, prototypeDecisionText, prototypeDelivery, prototypeDeliveryResponse, type PrototypeDelivery, type PrototypeDeliveryPorts } from "./decision";
import { prototypeCopyLine, parsePrototypeAnswer } from "./telegramAnswer";
import { ownerTelegramReply } from "./telegram.fixture";
import { runPrototypeAnswer } from "@/lib/externalRelay/prototypeAnswer";
import type { ExternalRelayAnswer } from "@/lib/externalRelay/protocol";
import { prototypeReviewReplica } from "./model";
import { isPrototypeReplica } from "./replica";
import { deliverPrototypeDecision, resetPrototypeDeliveryWorkerForTests, settlePrototypeDeliveriesForTests, sweepPrototypeDeliveries } from "./deliveryWorker";
import { prototypeWorld, type PrototypeWorld } from "./world";
import { stateDir } from "@/lib/configDir";
import { questions } from "./questionnaire.fixture";
import type { PrototypeReviewRead } from "./types";

let runtime: ComposerPayloadRuntime;
let world: PrototypeWorld;
let delivery: PrototypeDelivery;
let reviewId: string;
let scans = 0;
import { criticLane } from "./criticGate.fixture";
const publishPOST: typeof gatedPublishPOST = (request, world) => gatedPublishPOST(request, {
  ...world,
  caller: () => ({ conversationId: "conversation_publisher", project: "project-a" }),
  stage: () => ({ taskIds: ["task-prototype"], project: "project-a", source: { conversationId: "conversation_publisher", pipelineId: "prototype-lane", stageId: "publish" } }),
  pipeline: () => criticLane(), orchestrator: () => null,
});

const root = path.join(process.env.TMPDIR!,"runtime");
const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const comment = "  Combine the navigation of 1 and spacing of 2.\nKeep these words exactly.  ";
function request(body?: unknown) {
  return new NextRequest("http://localhost/api/tasks/task-prototype/prototypes",{ headers: { host: "localhost", "sec-fetch-site": "same-origin" },
    ...(body === undefined ? {} : { method: "POST",body: JSON.stringify(body) }) });
}
async function read() { return await (await reviewGET(request(),"task-prototype",world)).json() as PrototypeReviewRead; }
/** The Viewer's boot sweep, or the clock's next pass: every owed decision is attempted now. */
const sweep = () => sweepPrototypeDeliveries(ports(), { force: true });
const ports = (): PrototypeDeliveryPorts => ({ delivery, world, now: Date.now });
async function until(check: () => boolean) { for (let n=0;n<500;n++) { if (check()) return; await Bun.sleep(10); } throw new Error("runtime delivery did not settle"); }
beforeAll(async () => {
  runtime = await startComposerPayloadRuntime(root);
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root,"rt.sock");
  world = { ...prototypeWorld, orchestrator: () => runtime.conversationId };
  // The existing fixture owns the fake engine's recovery. Every store, HTTP
  // handler, reservation, journal and retry leaf remains the production code.
  delivery = { ...prototypeDelivery,retry: async decision => prototypeDeliveryResponse(await runtime.handle(new Request(`http://localhost/api/runtime/operations/${decision.delivery.operationId}`,{ method: "POST" }))) };
  setConversationHostDependenciesForTests({ completedFileScan: async () => { scans++; return {
    snapshot: { files: [],projectCatalog: [],complete: true },generation: 1,targetGeneration: 1,cacheStatus: "hit",requestCount: 1,cloneDurationMs: 0,
  }; } });
  saveTasks([{ id: "task-prototype",project: "project-a",text: "Navigation layout",status: "inbox",placement: "unplaced",assignments: [],createdAt: new Date().toISOString(),updatedAt: new Date().toISOString() }]);
  const dir = path.join(process.env.HOME!,"prototype-input"); fs.mkdirSync(dir,{ recursive: true });
  fs.writeFileSync(path.join(dir,"variant-1-390-en.png"),Buffer.from([137,80,78,71,13,10,26,10]));
  fs.writeFileSync(path.join(dir,"variant-2-390-en.png"),Buffer.from([137,80,78,71,13,10,26,10]));
  const response = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews",{ method: "POST",headers: { host: "localhost" },body: JSON.stringify({ taskId: "task-prototype",clientRequestId: "integration",title: "Navigation",dir,
    variants: [{ number: 1,name: "Compact",description: "A compact navigation." },{ number: 2,name: "Roomy",description: "Wider spacing." }] }) }),world);
  expect(response.status).toBe(200); reviewId = (await response.json()).reviewId;
});
afterAll(async () => {
  await resetPrototypeDeliveryWorkerForTests();
  setConversationHostDependenciesForTests(null);
  if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  await runtime?.close();
});
test("a decision saved while the seat is unreachable answers at once, keeps its record, and lands once the seat is back: one operator message", async () => {
  const result = await reviewPOST(request({ reviewId,chosen: [1,2],comment }),"task-prototype",world,delivery);
  expect(result.status).toBe(200);
  expect((await result.json() as PrototypeReviewRead).rounds[0]!.decision).toMatchObject({ chosen: [1,2],comment,delivery: { state: "pending",phase: "saved" } });
  expect(runtime.delivered).toHaveLength(0);
  // The background delivery hands it over; the seat's host is down, so the queue fails it.
  await settlePrototypeDeliveriesForTests();
  const operationId = loadTasks()[0]!.prototypeReviews![0]!.decision!.delivery.operationId!;
  expect(operationId).toBeString();
  await until(() => runtime.journal.operationResult(operationId)?.receipt.status === "failed");
  const waiting = (await read()).rounds[0]!.decision!;
  expect(waiting.comment).toBe(comment); expect(waiting.delivery.phase).toBe("delivering"); expect(runtime.delivered).toHaveLength(0);
  await runtime.hostUp();
  await sweep();
  await until(() => runtime.delivered.length === 1);
  await sweep();
  resetLegacyDocumentStoresForTests();
  expect((await read()).rounds[0]!.decision!.delivery).toMatchObject({ state: "sent",phase: "delivered" });
  const repeats = await Promise.all([...Array.from({ length: 3 },() => reviewPOST(request({ reviewId,chosen: [2,1],comment }),"task-prototype",{ ...world,orchestrator: () => "conversation_new_seat" },delivery)),
    ...Array.from({ length: 3 },() => reviewPOST(request({ reviewId,retry: true }),"task-prototype",{ ...world,orchestrator: () => "conversation_new_seat" },delivery))]);
  expect(repeats.every(response => response.status === 200)).toBe(true);
  await settlePrototypeDeliveriesForTests(); await sweep();
  expect(runtime.delivered).toHaveLength(1);
  expect(runtime.delivered[0]!.text).toContain("1 — Compact, 2 — Roomy"); expect(runtime.delivered[0]!.text).toContain(`Comment:\n${comment}\n\n`);
  const decision = loadTasks()[0]!.prototypeReviews![0]!.decision!;
  expect(decision.delivery.conversationId).toBe(runtime.conversationId);
  expect(decision.revision).toBe(1);
  expect(Object.values(runtime.registry.readOnlySnapshot().heldDeliveries).some(owner => owner.command.origin?.kind === "operator")).toBe(true);
  expect(scans).toBeGreaterThan(0);
});
test("a lost acknowledgement is recovered from the original receipt after reload, with no second send", async () => {
  // A fresh round uses the same production send path, then loses its response.
  const previous = loadTasks()[0]!.prototypeReviews![0]!;
  const input = { taskId: "task-prototype",clientRequestId: "lost-ack",title: "Navigation again",dir: path.join(process.env.HOME!,"prototype-input"),
    variants: previous.variants.map(v => ({ number: v.number,name: v.name,description: v.description })) };
  const published = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews",{ method: "POST",headers: { host: "localhost" },body: JSON.stringify(input) }),world);
  const id = (await published.json()).reviewId;
  let sends = 0;
  const losingAck = { ...delivery,send: async (...args: Parameters<typeof prototypeDelivery.send>) => { sends++; await prototypeDelivery.send(...args); throw new Error("acknowledgement lost"); } };
  expect((await reviewPOST(request({ reviewId: id,chosen: [1],comment }),"task-prototype",world,losingAck)).status).toBe(200);
  await until(() => runtime.delivered.length === 2);
  await settlePrototypeDeliveriesForTests();
  expect(loadTasks()[0]!.prototypeReviews![1]!.decision!.delivery.state).toBe("uncertain");
  resetLegacyDocumentStoresForTests();
  await resetPrototypeDeliveryWorkerForTests();
  await sweepPrototypeDeliveries({ delivery: losingAck,world,now: Date.now },{ force: true });
  expect((await reviewPOST(request({ reviewId: id,retry: true }),"task-prototype",world,losingAck)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(sends).toBe(1); expect(runtime.delivered).toHaveLength(2);
  expect((await read()).rounds[1]!.decision!.delivery.state).toBe("sent");
});
test("a Viewer stopped while its background delivery handed the message over: the decision stands, reads send nothing, and the next boot delivers it once", async () => {
  const previous = loadTasks()[0]!.prototypeReviews![0]!;
  const input = { taskId: "task-prototype",clientRequestId: "stopped",title: "Navigation, third",dir: path.join(process.env.HOME!,"prototype-input"),
    variants: previous.variants.map(v => ({ number: v.number,name: v.name,description: v.description })) };
  const published = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews",{ method: "POST",headers: { host: "localhost" },body: JSON.stringify(input) }),world);
  const id = (await published.json()).reviewId as string;
  const before = runtime.delivered.length;
  const child = Bun.spawn({ cmd: [process.execPath,path.join(import.meta.dir,"decisionStopChild.ts")],cwd: process.cwd(),stdout: "ignore",stderr: "inherit",
    env: { ...process.env,PROTOTYPE_STOP_TASKS_STATE: path.dirname(TASKS_FILE),PROTOTYPE_STOP_STATE: stateDir(),PROTOTYPE_STOP_TASK: "task-prototype",PROTOTYPE_STOP_REVIEW: id,PROTOTYPE_STOP_SEAT: runtime.conversationId,PROTOTYPE_STOP_COMMENT: comment } });
  expect(await child.exited).toBe(0);
  resetLegacyDocumentStoresForTests();
  const stored = () => loadTasks()[0]!.prototypeReviews!.find(round => round.id === id)!.decision!;
  expect(stored()).toMatchObject({ chosen: [1,2],comment,delivery: { state: "pending" } });
  expect(stored().delivery.dispatchedAt).toBeString();
  expect(stored().delivery.operationId).toBeUndefined();
  // Reloads read the truth and send nothing.
  for (let n = 0; n < 3; n += 1) {
    const shown = (await read()).rounds.find(round => round.id === id)!.decision!;
    expect(shown.comment).toBe(comment); expect(shown.delivery).toEqual({ state: "pending",retryable: true,phase: "delivering" });
  }
  expect(runtime.delivered).toHaveLength(before);
  // The next Viewer's boot sweep: the admission ledger proves nothing went, so it goes now, once.
  await resetPrototypeDeliveryWorkerForTests();
  await sweep();
  await until(() => runtime.delivered.length === before + 1);
  for (let n = 0; n < 3; n += 1) await sweep();
  resetLegacyDocumentStoresForTests();
  for (let n = 0; n < 2; n += 1) expect((await read()).rounds.find(round => round.id === id)!.decision!.delivery.state).toBe("sent");
  expect(runtime.delivered).toHaveLength(before + 1);
  expect(runtime.delivered.at(-1)!.text).toBe(stored().delivery.text);
  expect(runtime.delivered.at(-1)!.text).toContain(`Chosen: 1 — Compact, 2 — Roomy\n\nComment:\n${comment}\n\n`);
});


test("questionnaire answers use the production runtime delivery and persist across reload", async () => {
  const published = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ clientRequestId: "runtime-questions", taskId: "task-prototype", title: "Before work", questions }) }), world);
  expect(published.status).toBe(200);
  const id = (await published.json()).reviewId;
  const before = runtime.delivered.length;
  const answer = { reviewId: id, chosen: [], answers: questions.map(q => ({ questionId: q.id, options: [0] })), comment };
  expect((await reviewPOST(request(answer), "task-prototype", world, delivery)).status).toBe(200);
  await until(() => runtime.delivered.length === before + 1);
  await settlePrototypeDeliveriesForTests();
  resetLegacyDocumentStoresForTests();
  const readBack = (await read()).rounds.find(r => r.id === id)!;
  expect(readBack.decision?.answers).toEqual(answer.answers);
  expect(runtime.delivered.at(-1)!.text).toContain("Existing review (recommended)");
  expect(runtime.delivered.at(-1)!.text).toContain(`Comment:\n${comment}\n\n`);
  expect((await reviewPOST(request(answer), "task-prototype", world, delivery)).status).toBe(200);
  await settlePrototypeDeliveriesForTests();
  expect(runtime.delivered).toHaveLength(before + 1);
});

test("in-process owner decisions use the web text and client key through the production runtime", async () => {
  const published = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({
    clientRequestId: "relay-questions", taskId: "task-prototype", title: "Owner review", questions }) }), world);
  expect(published.status).toBe(200);
  const id = (await published.json()).reviewId;
  const task = loadTasks()[0]!;
  const round = task.prototypeReviews!.find(r => r.id === id)!;
  const match = parsePrototypeAnswer(round, `${prototypeCopyLine(round)}\nKeep this layout.`);
  if (!match.input) throw new Error("fixture answer did not parse");
  const before = runtime.delivered.length;
  let authorizations = 0;
  const context = { kind: "operator-in-process" as const, authorize: () => { authorizations++; } };
  if (decidePrototype(context, task.id, match.input, world)) deliverPrototypeDecision(task.id, id, ports());
  await settlePrototypeDeliveriesForTests();
  await until(() => runtime.delivered.length === before + 1);
  const decision = loadTasks()[0]!.prototypeReviews!.find(r => r.id === id)!.decision!;
  expect(decision.delivery.clientMessageId).toBe(`prototype-decision:${id}`);
  expect(decision.delivery.text).toBe(prototypeDecisionText(task, round, decision));
  expect(runtime.delivered.at(-1)!.text).toBe(decision.delivery.text);
  expect(authorizations).toBeGreaterThan(1);
  const operation = runtime.journal.operationResult(decision.delivery.operationId!)!;
  expect(operation.receipt.status).toBe("delivered");
  if (decidePrototype(context, task.id, match.input, world)) deliverPrototypeDecision(task.id, id, ports());
  await settlePrototypeDeliveriesForTests();
  expect(runtime.delivered).toHaveLength(before + 1);
});

test("the exact owner reservation is saved, acknowledged and delivered to the asking seat", async () => {
  const published = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({
    clientRequestId: "owner-reservation", taskId: "task-prototype", title: "Власний гайд: де живе, які відео першими", questions }) }), world);
  expect(published.status).toBe(200);
  const publishedId = (await published.json()).reviewId;
  const tasks = loadTasks();
  const round = tasks[0]!.prototypeReviews!.find(r => r.id === publishedId)!;
  round.id = "pr_20fbd832000000000000000000000000";
  saveTasks(tasks);
  const before = runtime.delivered.length;
  const result = await runPrototypeAnswer(parsePrototypeAnswer(round, ownerTelegramReply), "owner-message", () => {}, { world, delivery }).done;
  expect(result.status).toBe("done");
  expect((result.answer as ExternalRelayAnswer).text).toContain("рекомендовані з застереженням");
  const reservation = ", але по тому що показувати в кадрі- є питання. нам ж треба реальний інтерфейс телеги";
  expect((result.answer as ExternalRelayAnswer).text).toContain(reservation);
  await settlePrototypeDeliveriesForTests();
  await until(() => runtime.delivered.length === before + 1);
  resetLegacyDocumentStoresForTests();
  const task = loadTasks()[0]!;
  const decision = task.prototypeReviews!.find(r => r.id === round.id)!.decision!;
  expect(decision.originalReply).toBe(ownerTelegramReply);
  expect(decision.comment).toBe(reservation);
  expect(decision.recommendedWithReservation).toBe(true);
  expect(decision.skipped).toBeUndefined();
  expect(decision.answers).toEqual(questions.map(q => ({ questionId: q.id, options: [0] })));
  expect(decision.delivery.conversationId).toBe(runtime.conversationId);
  expect(runtime.delivered.at(-1)!.text).toContain("recommended with reservation; resolve the owner's open point below.");
  expect(runtime.delivered.at(-1)!.text).toContain(reservation);
  const replica = prototypeReviewReplica(task)!;
  expect(isPrototypeReplica(replica, task.id, task.project)).toBe(true);
  expect(replica.rounds.at(-1)!.decision!.originalReply).toBe(ownerTelegramReply);
  expect((await read()).rounds.find(r => r.id === round.id)!.decision!.recommendedWithReservation).toBe(true);
});

test.each(["custom", "numbered-reservation", "long"])("owner %s replies survive decision normalization, reload and production delivery", async kind => {
  const published = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({
    clientRequestId: `owner-${kind}`, taskId: "task-prototype", title: "Owner words", questions }) }), world);
  expect(published.status).toBe(200);
  const id = (await published.json()).reviewId;
  const round = loadTasks()[0]!.prototypeReviews!.find(r => r.id === id)!;
  const copy = prototypeCopyLine(round);
  const words = kind === "custom" ? copy.replace("Відповіді рекомендовані", "1: Власне місце.\n2: Власні поверхні.\n3: Власний час.")
    : kind === "numbered-reservation" ? `${copy}, але 2: Беремо реальний інтерфейс телеги.`
    : `${copy}, ${"я".repeat(20_000 - copy.length - 2)}`;
  const match = parsePrototypeAnswer(round, words);
  expect(match).toHaveProperty("input");
  const before = runtime.delivered.length;
  const result = await runPrototypeAnswer(match, "owner-message", () => {}, { world, delivery }).done;
  expect((result.answer as ExternalRelayAnswer).text).toContain("✅ Записав рішення");
  expect((result.answer as ExternalRelayAnswer).text).toContain(kind === "custom" ? "власні відповіді" : "рекомендовані з застереженням");
  await settlePrototypeDeliveriesForTests();
  await until(() => runtime.delivered.length === before + 1);
  resetLegacyDocumentStoresForTests();
  const task = loadTasks()[0]!;
  const saved = task.prototypeReviews!.find(r => r.id === id)!.decision!;
  expect(saved.originalReply).toBe(words);
  expect(saved.answers).toEqual(match.input!.answers);
  expect(isPrototypeReplica(prototypeReviewReplica(task), task.id, task.project)).toBe(true);
  expect(runtime.delivered.at(-1)!.text).toBe(saved.delivery.text);
  if (kind === "numbered-reservation") {
    expect(saved.answers![1]).toEqual({ questionId: "scope", options: [0], customText: "2: Беремо реальний інтерфейс телеги." });
    expect(runtime.delivered.at(-1)!.text).toContain("Owner's custom note:\n2: Беремо реальний інтерфейс телеги.");
  }
  if (kind === "long") {
    expect(words.length).toBe(20_000);
    expect(Buffer.byteLength(saved.delivery.text)).toBeLessThanOrEqual(32_000);
    expect(saved.delivery.text).toContain("Read read_prototype_review");
    expect(saved.delivery.text).not.toContain("\uFFFD");
  }
});
