import { expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { accountManager } from "@/lib/accounts/manager";
import type { SeatTickSources } from "@/lib/monitor/seatTickSources";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";
import { DeliveryProgressStore } from "@/lib/runtime/deliveryProgress";
import { resolveSendReceipt, SEND_UNVERIFIED_REASON } from "@/lib/runtime/sendSettlement";
import { observeOwnerTurn } from "./ownerRun";
import { relayAnswerOp } from "./ownerAnswer";
import { runClaimedRequest } from "./runner";
import { richRequest } from "./rich.fixture";
import { contextRequest } from "./request.fixture";
import { claimRelayRequestAsync, dropRun, externalRelayFile, updateRelayStore, type PairedRelay } from "./store";
import { readAnswerRecord } from "./answers";
import { setRelaySwitch } from "./switches";
import { startTestRelay } from "./testRelay";

const epoch = Date.parse("2026-11-01T08:50:00Z");

for (const [admission, acknowledgement] of [["pending", "accepted"], ["failed", "accepted"], ["completed-turn", "accepted"],
  ["pending", "unconfirmed"], ["pending", "refused"], ["unknown", "accepted"], ["unknown", "unconfirmed"],
  ["active-turn", "accepted"], ["stale-turn", "accepted"], ["echo-before-final", "accepted"], ["discard-during-liveness", "accepted"],
  ["uncertain-during-liveness", "accepted"], ["settled-during-liveness", "accepted"]] as const)
test(`owner delivery evidence and chat acknowledgement (${admission}, ${acknowledgement})`, async () => {
  setSystemTime(epoch);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-delivery-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"), { structuredHosts: true });
  const progress = new DeliveryProgressStore(path.join(root, "progress.json"));
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const posts: unknown[] = [];
  let attempts = 0;
  const service = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) {
      attempts++;
      if (acknowledgement !== "accepted") return { status: 409, body: { error: { code: acknowledgement === "unconfirmed" ? "already_completed" : "lease_lost" } } };
      expect(Date.now()).toBeLessThan(epoch + 600_000);
      posts.push(body);
    }
    return { body: { status: "ok" } };
  });
  const relay: PairedRelay = { id: "owner_delivery", origin: service.origin, api_base: `${service.origin}/v1`,
    name: "Fixture", description: "", credential: "fixture", owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: new Date().toISOString(), paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 32000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "none", enabled: true, engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 30, ownerTier: true }] };
  const source = richRequest();
  const request = { ...source, request_id: `owner_delivery_${admission}_${acknowledgement}`, claimed_at: new Date(epoch).toISOString(),
    deadline_at: new Date(epoch + 600_000).toISOString(), input: { ...source.input, tools: [],
      requester: { ...contextRequest.input.requester, is_owner: true } } };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  setRelaySwitch("chain_conversations", false);
  setAgentRegistryForTests(registry);
  let launches = 0;
  try {
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, transport: "structured",
      clientAttemptId: `relay-owner-${request.request_id}`, launchProfile: { title: "Answer relay delivery fixture" } });
    if (begun.kind !== "created") throw Error("spawn fixture refused");
    const { conversationId, launchId } = begun.receipt;
    const transcript = path.join(root, "owner.jsonl");
    const key = { engine: "codex" as const, sessionId: "owner-delivery-session" };
    expect(registry.stageStructuredSpawn(launchId, { key, artifactPath: transcript, cwd: root, accountId: null,
      claimEpoch: 0, status: "idle", host: null, structuredHost: null, claimOwner: null, pendingAction: null }).kind).toBe("settled");
    if (admission === "completed-turn") registry.completeSpawn(launchId, registry.snapshot().entries[`codex:${key.sessionId}`]!);
    const operationId = `spawn_message_${launchId}`;
    const text = "Complete the owner request";
    const delivery = registry.holdDelivery(conversationId, text, `spawn_${launchId}`, "text", [], null,
      { operationId, kind: "send", policy: "queue" });
    expect(delivery.state).toBe("assigned");
    expect(registry.beginDeliveryAttempt(delivery.id, delivery.generationId!)).toBeTruthy();
    journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
      conversationId, sessionKey: key, hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
      artifactPath: transcript, capabilities: { steer: true, structuredAttention: true } } });
    journal.executeOperation({ kind: "send", operationId, conversationId, idempotencyKey: `spawn_${launchId}`, text, policy: "queue" });
    journal.transitionOperation(operationId, "delivering");
    progress.note(operationId, conversationId, { waitReason: "dispatching", attempted: true });
    const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId));
    fs.writeFileSync(transcript, admission === "completed-turn" || admission === "unknown" ? "" : JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");
    if (admission !== "unknown" && admission !== "completed-turn") progress.timing(operationId, { engineEchoAt: new Date(epoch + 12_000).toISOString() });
    progress.note(operationId, conversationId, { waitReason: "evidence-unreadable", detail: "the delivery journal could not be listed: runtime host request timed out" });
    progress.note(operationId, conversationId, { waitReason: "wake-lost" });
    journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    registry.recordDeliveryOutcome(delivery.id, "failed", SEND_UNVERIFIED_REASON, "unverified");
    progress.settle(operationId, "uncertain", SEND_UNVERIFIED_REASON);
    const client = { transitionOperation: async () => { throw Error("runtime host request timed out"); },
      operationStatus: async () => { throw Error("runtime host request timed out"); } } as unknown as RuntimeHostClient;
    expect(await resolveSendReceipt(operationId, { registry, client })).toMatchObject({ state: "failed", duplicateRisk: true });
    if (admission === "failed" || admission === "unknown") registry.failSpawn(launchId, "delivery was started and never settled; whether it reached the recipient is unknown");
    setSystemTime(epoch + 190_000);
    let observationCount = 0;
    const sources = { registry: () => registry, now: () => epoch + 190_000,
      liveness: async () => {
        if (admission === "unknown") return [];
        if (admission === "discard-during-liveness") registry.recordDeliveryOutcomeForOperation(conversationId, operationId, "failed", "delivery-discarded", "unverified");
        if (admission === "uncertain-during-liveness") {
          registry.recordDeliveryOutcome(delivery.id, "failed", "canonical delivery acknowledgement is temporarily unavailable", "unverified");
          expect(registry.deliverySnapshotForOperation(operationId).deliveryOperationOwners[operationId]?.terminalReason)
            .toBe("canonical delivery acknowledgement is temporarily unavailable");
        }
        if (admission === "settled-during-liveness") registry.recordDeliveryOutcomeForOperation(conversationId, operationId, "delivered", null, "delivered");
        return [{ reason: admission === "active-turn" && observationCount === 1 ? "host_alive_turn_active" : "host_alive_turn_idle",
          lastRecordAt: new Date(admission === "stale-turn" && observationCount === 1 ? epoch - 1 : epoch + 190_000).toISOString() }];
      } } as unknown as Pick<SeatTickSources, "registry" | "liveness" | "now">;
    let observation: Awaited<ReturnType<typeof observeOwnerTurn>> | undefined;
    const result = await runClaimedRequest(relay, request, undefined, { leaseWorker: false, ownerPorts: {
      launch: async () => { launches++; return { status: 202, body: { conversationId, launchId, initialMessage: "pending" } }; },
      observe: async turn => {
        observationCount++;
        if (admission === "unknown") return observeOwnerTurn(turn, sources);
        expect(await relayAnswerOp(conversationId, { format: "rich_markdown" })).not.toBeNull();
        if (admission !== "echo-before-final" || observationCount > 1)
          fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "**Finished**" } }) + "\n");
        observation = await observeOwnerTurn(turn, sources);
        if ((admission === "active-turn" || admission === "stale-turn" || admission === "echo-before-final") && observationCount === 1) {
          expect(observation).toMatchObject({ state: "running", firstMessagePending: false });
          expect(posts).toEqual([]);
          return observation;
        }
        if (admission === "discard-during-liveness") {
          expect(observation).toMatchObject({ state: "failed", failure: { detail: "delivery-discarded" } });
          return observation;
        }
        // Fail promptly on the original gate instead of waiting out a real lease.
        expect(observation).toMatchObject({ state: "ended", firstMessagePending: false, finalText: "**Finished**" });
        return observation;
      }, stop: async () => {}, pollMs: 1,
    } });
    expect(result).toMatchObject({ outcome: "answered", answer: admission === "unknown"
      ? { text: expect.stringContaining("sending it again may deliver it twice") }
      : admission === "discard-during-liveness" ? { text: expect.stringContaining("delivery-discarded") }
      : { text: "**Finished**", format: "rich_markdown" } });
    expect(posts).toEqual(acknowledgement === "accepted" ? [result] : []);
    expect(attempts).toBe(1);
    const ledger = JSON.parse(fs.readFileSync(externalRelayFile("requests"), "utf8"));
    const claim = ledger.claims.find((row: { requestId: string }) => row.requestId === request.request_id);
    expect(claim?.completion).toEqual(acknowledgement === "accepted" ? result : undefined);
    expect(readAnswerRecord(relay.id, request.target_id, request.request_id)).toMatchObject({
      delivery: acknowledgement, outcome: acknowledgement === "accepted" ? "answered" : `failed:delivery_${acknowledgement}` });
    if (acknowledgement !== "refused") expect(await claimRelayRequestAsync(request.request_id, request.lease_id, Date.now() + 5000))
      .toEqual({ kind: "terminal", completion: acknowledgement === "accepted" ? result : null });
    if (acknowledgement === "unconfirmed") {
      expect(claim?.terminalAt).toBeNumber();
      expect(await runClaimedRequest(relay, request, undefined, { leaseWorker: false })).toBeNull();
    }
    if (admission === "unknown" && acknowledgement === "accepted") await runClaimedRequest(relay, request, undefined, { leaseWorker: false });
    expect(attempts).toBe(1);
    expect(launches).toBe(1);
    expect(journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
  } finally {
    dropRun(request.request_id);
    setAgentRegistryForTests(null); selection.mockRestore(); progress.close(); journal.close(); registry.close();
    await service.close(); setSystemTime(); fs.rmSync(root, { recursive: true, force: true });
  }
});
