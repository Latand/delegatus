import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import path from "node:path";
import { NextRequest } from "next/server";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { handleRuntimeRetry } from "@/lib/runtime/http";
import { startComposerPayloadRuntime, type ComposerPayloadRuntime } from "@/lib/runtime/fixtures/composerPayloadRuntime";
import { setConversationHostDependenciesForTests } from "@/app/api/conversation-host/dependencies";
import { runPrototypeAnswer } from "@/lib/externalRelay/prototypeAnswer";
import { teamStore, resetTeamStoreForTests } from "@/lib/team/store";
import { insertSeatRound, findSeatRound, mutateSeatRound } from "./seatRounds";
import { mintSession, MEMBER_COOKIE } from "@/lib/team/sessions";
import { attemptPrototypeDelivery, decidePrototype, prototypeDelivery } from "./decision";
import { deliverPrototypeDecision, resetPrototypeDeliveryWorkerForTests, settlePrototypeDeliveriesForTests } from "./deliveryWorker";
import { prototypeWorld } from "./world";
import type { PrototypeReviewRound } from "./types";

let runtime: ComposerPayloadRuntime;
const socket = process.env.LLV_RUNTIME_HOST_SOCKET;
const previousEnvironment = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
beforeAll(async () => {
  const root = path.join(process.env.TMPDIR!, "answer-runtime");
  runtime = await startComposerPayloadRuntime(root);
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "rt.sock");
  setConversationHostDependenciesForTests({ completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true }, generation: 1, targetGeneration: 1, cacheStatus: "hit", requestCount: 1, cloneDurationMs: 0 }) });
  teamStore().insertMember({ id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Owner", role: "owner", status: "active", color: "sky", telegram: { userId: "123456", username: null, firstName: null, linkedAt: "2026-10-16T08:00:00Z" }, createdAt: "2026-10-16T08:00:00Z", createdBy: "claim", revokedAt: null });
  await runtime.hostUp();
});
afterAll(async () => {
  await resetPrototypeDeliveryWorkerForTests();
  resetTeamStoreForTests(); setConversationHostDependenciesForTests(null);
  if (socket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = socket;
  await runtime?.close();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test.each(["recommended", "explicit"])("B: %s Telegram answer reaches the real destination once in team mode", async kind => {
  const id = `pr_${(kind === "recommended" ? "a" : "b").repeat(32)}`;
  const round: PrototypeReviewRound = { id, taskId: null, project: "project-a", title: "Choose delivery", createdAt: "2026-10-16T08:00:00Z", source: { conversationId: runtime.conversationId }, publicationKey: kind, inputDigest: "fixture", variants: [],
    questions: [{ id: "where", text: "Where?", options: [{ label: "Here", recommended: true }, { label: "Later" }] }] };
  insertSeatRound(round);
  const world = { ...prototypeWorld, orchestrator: () => runtime.conversationId };
  const before = runtime.delivered.length;
  const input = { reviewId: id, chosen: [], comment: "Keep the saved answer.", ...(kind === "recommended" ? { skip: true as const } : { answers: [{ questionId: "where", options: [1] }] }) };
  const result = await runPrototypeAnswer({ round, input }, "message-a", () => {}, { world, delivery: prototypeDelivery, telegramUserId: "123456" }).done;
  expect(result.status).toBe("done");
  await settlePrototypeDeliveriesForTests();
  expect(findSeatRound(id)!.decision!.decidedBy).toEqual({ kind: "member", memberId: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  for (let i = 0; i < 200 && runtime.delivered.length === before; i++) await Bun.sleep(10);
  expect(runtime.delivered).toHaveLength(before + 1);
  expect(runtime.delivered.at(-1)!.text).toBe(findSeatRound(id)!.decision!.delivery.text);
  expect((await prototypeDelivery.recover(findSeatRound(id)!.decision!))?.state).toBe("sent");
});


test("B: revoking the saved member during retry preparation refuses dispatch", async () => {
  const member = teamStore().member("m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")!;
  const peerRoot = path.join(process.env.TMPDIR!, "retry-authority-runtime");
  const peer = await startComposerPayloadRuntime(peerRoot);
  teamStore().insertMember(member);
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(peerRoot, "rt.sock");
  try {
    const id = `pr_${"c".repeat(32)}`;
    const round: PrototypeReviewRound = { id, taskId: null, project: "project-a", title: "Retry authority", createdAt: "2026-10-16T08:00:00Z", source: { conversationId: peer.conversationId }, publicationKey: "retry-authority", inputDigest: "fixture", variants: [],
      questions: [{ id: "retry", text: "Retry?", options: [{ label: "Yes", recommended: true }, { label: "Later" }] }] };
    insertSeatRound(round);
    const world = { ...prototypeWorld, orchestrator: () => peer.conversationId };
    const cookie = mintSession(teamStore(), "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "claim", { surface: "desktop", browser: "chrome" }).value;
    decidePrototype(new NextRequest("http://localhost", { headers: { host: "localhost", cookie: `${MEMBER_COOKIE}=${cookie}` } }), null,
      { reviewId: id, chosen: [], skip: true, comment: "Preserve this answer." }, world);
    deliverPrototypeDecision(null, id, { world, delivery: prototypeDelivery, now: Date.now });
    await settlePrototypeDeliveriesForTests();
    const operationId = findSeatRound(id)!.decision!.delivery.operationId!;
    for (let i = 0; i < 200 && peer.journal.operationResult(operationId)?.receipt.status !== "failed"; i++) await Bun.sleep(10);
    expect(peer.journal.operationResult(operationId)?.receipt.status).toBe("failed");
    await peer.hostUp();
    const client = new UnixRuntimeHostClient(path.join(peerRoot, "rt.sock"));
    const response = await handleRuntimeRetry(new NextRequest("http://localhost/api/runtime/retry", { method: "POST", headers: { host: "localhost" } }), operationId, {
      enabled: () => true, client: () => client, registry: () => peer.registry, kick: () => {},
      recover: async () => ({ target: null, path: peer.artifactPath, conversationId: peer.conversationId as `conversation_${string}`, spawned: false }),
      republish: async () => {
        const member = teamStore().member("m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")!;
        teamStore().updateMember({ ...member, status: "revoked", revokedAt: "2026-10-16T08:01:00Z" });
        return true;
      },
    }, () => { if (teamStore().member("m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")?.status !== "active") throw new Error("member revoked before retry"); });
    expect(teamStore().member("m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")?.status).toBe("revoked");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(peer.delivered).toHaveLength(0);
  } finally { await peer.close(); }
});

for (const explicitRetry of [false, true]) test(`seat channel: a saved answer follows rotation after admission (Retry: ${explicitRetry})`, async () => {
  setSystemTime(new Date("2026-10-16T12:05:00.000Z"));
  const root = path.join(process.env.TMPDIR!, `seat-succession-${explicitRetry}`);
  const peer = await startComposerPayloadRuntime(root, { secondConversation: true, holdFirstTurn: true });
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "rt.sock");
  try {
    await peer.hostUp();
    const next = peer.successor!;
    const ports = { world: prototypeWorld, delivery: prototypeDelivery, now: Date.now };
    const designate = (conversationId: string, artifactPath: string, key: string) => {
      beginOrchestratorSeatIntent({ project: "seat-answer-project", mandate: "coordinate", mode: "existing", clientRequestId: key });
      completeOrchestratorSeatIntent({ project: "seat-answer-project", clientRequestId: key, conversationId, path: artifactPath });
    };
    designate(peer.conversationId, peer.artifactPath, "seat-answer-first");
    const id = `pr_${(explicitRetry ? "e" : "d").repeat(32)}`;
    insertSeatRound({ id, taskId: null, project: "seat-answer-project", title: "Saved answer at rotation", createdAt: new Date().toISOString(),
      source: { conversationId: peer.conversationId }, publicationKey: "rotation-answer", inputDigest: "fixture", variants: [],
      questions: [{ id: "rotate", text: "Proceed?", options: [{ label: "Proceed", recommended: true }] }] });
    decidePrototype(new NextRequest("http://localhost", { headers: { host: "localhost" } }), null,
      { reviewId: id, chosen: [], answers: [{ questionId: "rotate", options: [0] }], comment: "Preserve this saved instruction." },
      prototypeWorld);
    await attemptPrototypeDelivery(null, id, ports);
    const original = findSeatRound(id)!.decision!.delivery.operationId!;
    expect(original).toBeTruthy();
    expect(peer.delivered).toHaveLength(0);
    if (explicitRetry) {
      // The explicit Retry path first fences its queued predecessor; admit another queued attempt under its saved key.
      await peer.journal.transitionOperation(original, "failed", { reason: "fixture retry" });
      const retried = await peer.handle(new Request(`http://localhost/api/runtime/operations/${original}`, { method: "POST" }));
      expect(retried.status).toBe(202);
      const response = await retried.json();
      mutateSeatRound(id, round => { round.decision!.delivery.operationId = response.operationId; round.decision!.delivery.state = "pending"; });
    }
    const queued = findSeatRound(id)!.decision!.delivery.operationId!;
    expect(["queued", "pending"]).toContain(peer.journal.operationResult(queued)?.receipt.status ?? "missing");
    designate(next.conversationId, next.artifactPath, "seat-answer-successor");
    await attemptPrototypeDelivery(null, id, ports);
    await peer.holdTurn!(false);
    for (let pass = 0; pass < 100 && !next.delivered.length; pass++) { await Bun.sleep(10); await attemptPrototypeDelivery(null, id, ports); }
    expect(peer.delivered).toHaveLength(0);
    expect(next.delivered).toHaveLength(1);
    expect(next.delivered[0]!.text).toBe(findSeatRound(id)!.decision!.delivery.text);
    expect(findSeatRound(id)!.decision!.delivery.conversationId).toBe(next.conversationId);
    expect(findSeatRound(id)!.decision!.delivery.predecessors).toContainEqual({ conversationId: peer.conversationId, operationId: queued });
    expect(peer.journal.operationResult(queued)?.receipt.status).toBe("failed");
    await attemptPrototypeDelivery(null, id, ports);
    expect(next.delivered).toHaveLength(1);
  } finally {
    await peer.close();
    setSystemTime();
  }
});
