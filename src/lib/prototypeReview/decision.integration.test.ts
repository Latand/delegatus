import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { startComposerPayloadRuntime, type ComposerPayloadRuntime } from "@/lib/runtime/fixtures/composerPayloadRuntime";
import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { setConversationHostDependenciesForTests } from "@/app/api/conversation-host/dependencies";
import { publishPOST, reviewGET, reviewPOST } from "./http";
import { prototypeDelivery, prototypeDeliveryResponse, type PrototypeDelivery } from "./decision";
import { prototypeWorld, type PrototypeWorld } from "./world";
import type { PrototypeReviewRead } from "./types";

let runtime: ComposerPayloadRuntime;
let world: PrototypeWorld;
let delivery: PrototypeDelivery;
let reviewId: string;
let scans = 0;
const root = path.join(process.env.TMPDIR!,"runtime");
const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const comment = "  Combine the navigation of 1 and spacing of 2.\nKeep these words exactly.  ";
function request(body?: unknown) {
  return new NextRequest("http://localhost/api/tasks/task-prototype/prototypes",{ headers: { host: "localhost", "sec-fetch-site": "same-origin" },
    ...(body === undefined ? {} : { method: "POST",body: JSON.stringify(body) }) });
}
async function read() { return await (await reviewGET(request(),"task-prototype",world,delivery)).json() as PrototypeReviewRead; }
async function until(check: () => boolean) { for (let n=0;n<500;n++) { if (check()) return; await Bun.sleep(10); } throw new Error("runtime delivery did not settle"); }
beforeAll(async () => {
  runtime = await startComposerPayloadRuntime(root);
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root,"rt.sock");
  world = { ...prototypeWorld, orchestrator: () => runtime.conversationId };
  // The existing fixture owns the fake engine's recovery. Every store, HTTP
  // handler, reservation, journal and retry leaf remains the production code.
  delivery = { ...prototypeDelivery,retry: async (_request,decision) => prototypeDeliveryResponse(await runtime.handle(new Request(`http://localhost/api/runtime/operations/${decision.delivery.operationId}`,{ method: "POST" }))) };
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
  setConversationHostDependenciesForTests(null);
  if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  await runtime?.close();
});
test("decision survives a failed production send, retry and reload; the runtime accepts one operator message", async () => {
  const result = await reviewPOST(request({ reviewId,chosen: [1,2],comment }),"task-prototype",world,delivery);
  expect(result.status).toBe(200);
  const operationId = loadTasks()[0]!.prototypeReviews![0]!.decision!.delivery.operationId!;
  await until(() => runtime.journal.operationResult(operationId)?.receipt.status === "failed");
  const failed = (await read()).rounds[0]!.decision!;
  expect(failed.comment).toBe(comment); expect(failed.delivery.state).toBe("failed"); expect(runtime.delivered).toHaveLength(0);
  await runtime.hostUp();
  const retry = await reviewPOST(request({ reviewId,retry: true }),"task-prototype",world,delivery);
  expect(retry.status).toBe(200);
  await until(() => runtime.delivered.length === 1);
  resetLegacyDocumentStoresForTests();
  expect((await read()).rounds[0]!.decision!.delivery.state).toBe("sent");
  const repeats = await Promise.all(Array.from({ length: 3 },() => reviewPOST(request({ reviewId,retry: true }),"task-prototype",{ ...world,orchestrator: () => "conversation_new_seat" },delivery)));
  expect(repeats.every(response => response.status === 200)).toBe(true);
  expect(runtime.delivered).toHaveLength(1);
  expect(runtime.delivered[0]!.text).toContain("1 — Compact, 2 — Roomy"); expect(runtime.delivered[0]!.text).toContain(`Comment:\n${comment}\n\n`);
  const decision = loadTasks()[0]!.prototypeReviews![0]!.decision!;
  expect(decision.delivery.conversationId).toBe(runtime.conversationId);
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
  resetLegacyDocumentStoresForTests();
  expect((await reviewPOST(request({ reviewId: id,retry: true }),"task-prototype",world,losingAck)).status).toBe(200);
  expect(sends).toBe(1); expect(runtime.delivered).toHaveLength(2);
  expect((await read()).rounds[1]!.decision!.delivery.state).toBe("sent");
});
