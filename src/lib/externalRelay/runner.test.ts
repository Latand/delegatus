import { ownerRelayTargetMatches } from "./ownerAuthority";
import * as ownerContext from "./ownerBridgeContext";
import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import dns from "node:dns/promises";
import { callBody, toolSleep, type ToolLoopRuntime } from "./toolLoop";
import { requestSchema, handoffAnswerSchema, answerSchema, replyAnswerSchema, type ToolCallResult } from "./protocol";
import { ownerRequest, pendingRetryAfterSeconds, x1Request, x1Results, x1Errors, x1Dir } from "./toolLoop.fixture";
import { relayClaimCapabilities, sweepExternalRelayOrphans } from "./poller";
import { setRelaySwitch } from "./switches";
import { assertOwnerCaptureResponse } from "./ownerCapture.fixture";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { procBackend } from "@/lib/proc";
import { processMatches, terminateHeadlessReviewerGroup } from "@/lib/agent/headless";
import type { AccountContext } from "@/lib/accounts/contracts";
import { createManagedClaudeAccount } from "@/lib/accounts/claude";
import { advertisedSlots, completeRelayRequest, HANDOFF_DETAIL, memberLimitDetail, runClaimedRequest as runClaimedRequestWithLeaseWorker, runningCount } from "./runner";
import { relayActivity } from "./activity";
import { dropRun, externalRelayFile, readRunLedger, reserveRun, updateRelayStore, type PairedRelay } from "./store";
import { confirmRelayPairing } from "./pairing";
import { contextRequest, sampleRequest, serviceClaims } from "./request.fixture";
import { countMemberAnswers, listAnswerRecords, readAnswerRecord, settleInterruptedAnswer } from "./answers";
import { startTestRelay, deadlineNegotiatedCapture } from "./testRelay";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { telegramRound, telegramTask } from "@/lib/prototypeReview/telegram.fixture";
import { prototypeCopyLine, prototypeReference } from "@/lib/prototypeReview/telegramAnswer";
import { prototypeDecisionText } from "@/lib/prototypeReview/decision";
import { RelayLeaseTransport } from "./relayLeaseTransport";
import { answerCapabilities, checkedAnswerV2 } from "./answerV2";
import { richRequest } from "./rich.fixture";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runner-test-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(path.join(root, "state/external-relay/switches.json"), { force: true });
  fs.rmSync(path.join(root, "state/external-relay/conversations.json"), { force: true });
  const requests = externalRelayFile("requests");
  fs.rmSync(requests, { force: true });
  fs.rmSync(`${requests}.lock`, { force: true });
});
const original = accountManager.resolveHeadlessSpawn;
const home = path.join(root, "account");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "auth.json"), "{}");
fs.writeFileSync(
  path.join(home, "models_cache.json"),
  JSON.stringify({ models: [{ slug: "gpt-6-sol" }] }),
);
const account: AccountContext = {
  engine: "codex",
  accountId: "answer",
  kind: "managed",
  home,
  transcriptRoot: home,
  env: { ...process.env },
};
accountManager.resolveHeadlessSpawn = (() => ({
  kind: "available",
  account,
})) as typeof original;
afterAll(() => {
  accountManager.resolveHeadlessSpawn = original;
});
function relay(api_base: string): PairedRelay {
  return {
    id: "relay_1",
    origin: api_base.replace(/\/v1$/, ""),
    api_base,
    name: "Test",
    description: "Test",
    credential: "x".repeat(43),
    owner: {
      namespace: "test",
      id: "owner",
      display_name: "Owner",
      handle: null,
    },
    pairedAt: new Date().toISOString(),
    paused: false,
    limits: {
      max_response_bytes: 1048576,
      max_wait_s: 25,
      max_answer_chars: 4000,
    },
    targets: [
      {
        id: "target_1",
        name: "Target",
        answered_by: "install",
        fallback: "service",
        enabled: true,
        engine: "codex",
        model: "gpt-6-sol",
        effort: "low",
        project: null,
        concurrency: 1,
        hardCapMinutes: 1,
      },
    ],
  };
}

type RunnerRuntime = NonNullable<Parameters<typeof runClaimedRequestWithLeaseWorker>[3]>;
function runClaimedRequest(relayValue: PairedRelay, requestValue: unknown, onFreed?: () => void, runtime?: RunnerRuntime) {
  return runClaimedRequestWithLeaseWorker(relayValue, requestValue, onFreed, { ...runtime, leaseWorker: false });
}

test("capacity transition retains zero targets in the journal and ignores confirmed stop custody", () => {
  const paired = relay("http://127.0.0.1:1/v1"); paired.targets[0]!.concurrency = 3;
  const row = { requestId: "slot-old-a", leaseId: "fixture", relayId: paired.id, targetId: "target_1",
    childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: null, runDir: "", startedAt: "2026-01-01T00:00:00.000Z" };
  const lines: unknown[][] = [];
  const journal = spyOn(console, "info").mockImplementation((...args) => { lines.push(args); });
  try {
    reserveRun(row); reserveRun({ ...row, requestId: "slot-old-b" }); reserveRun({ ...row, requestId: "slot-current" });
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 0 }]);
    expect(lines.some(line => line[0] === "External relay target capacity" && (line[1] as { free?: number }).free === 0)).toBe(true);
    dropRun("slot-current"); dropRun("slot-old-a"); dropRun("slot-old-b");
    for (const requestId of ["slot-old-a", "slot-old-b"]) reserveRun({ ...row, requestId,
      ownerTurn: { clientAttemptId: requestId, cancel: "interrupt", confirmed: true } });
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 3 }]);
  } finally { journal.mockRestore(); for (const id of ["slot-old-a", "slot-old-b", "slot-current"]) dropRun(id); }
});

for (const downgrade of [false, true]) test(`production lease helper preserves a valid large Unicode completion${downgrade ? " through attachment downgrade" : ""}`, async () => {
  const request = richRequest(true);
  const text = "😀".repeat(20_000);
  const answer = checkedAnswerV2({ action: "reply", text, reply_to: "m1", format: "rich_markdown", buttons: [] }, request,
    answerCapabilities(request, "codex"), { handoff: true, ignore: true, stagedAttachments: 1 });
  expect(answer).not.toBeNull();
  expect(Buffer.byteLength(answer!.text)).toBe(80_000);
  const body = { lease_id: request.lease_id, outcome: "answered" as const, duration_ms: 0, answer: {
    action: "reply" as const, text, reply_to: "m1", format: "rich_markdown" as const, buttons: [],
    ...(downgrade ? { attachments: [{ attachment_id: "fixture_attachment", kind: "document" as const }] } : {}),
  } };
  const posts: typeof body[] = [];
  const server = await startTestRelay((req, value) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    if (req.url?.endsWith("/complete")) {
      posts.push(value as typeof body);
      if (downgrade && posts.length === 1) return { status: 422, body: { error: { code: "attachment_not_ready", message: "not ready" } } };
      return { body: { status: "accepted", duplicate: false } };
    }
    return { status: 404, body: {} };
  });
  const paired = relay(`${server.origin}/v1`);
  const transport = new RelayLeaseTransport(paired, request.request_id, request.target_id, request.lease_id, 10_000, () => {});
  try {
    await transport.ready;
    const result = await transport.complete(body, Date.now() + 10_000, 4000);
    expect(result.delivery).toBe("accepted");
    expect(result.body.outcome).toBe("answered");
    if (result.body.outcome !== "answered") throw new Error("accepted fixture returned no answer");
    expect(result.body.answer.text).toBe(text);
    expect(result.body.answer.attachments).toBeUndefined();
    expect(posts).toHaveLength(downgrade ? 2 : 1);
    expect(posts.at(-1)?.answer.text).toBe(text);
    expect(posts.at(-1)?.answer.attachments).toBeUndefined();
  } finally {
    await transport.close();
    await server.close();
  }
});

for (const refusalBeforeAck of [false, true]) test(`accepted completion releases capacity before chain cleanup and labels a racing heartbeat refusal (${refusalBeforeAck})`, async () => {
  const chains = await import("./conversations");
  let entered!: () => void, releaseCleanup!: () => void, releaseHeartbeat!: () => void, heartbeatArrived!: () => void, heartbeatLogged!: () => void;
  const cleanupEntered = new Promise<void>(r => { entered = r; });
  const cleanupGate = new Promise<void>(r => { releaseCleanup = r; });
  const heartbeatGate = new Promise<void>(r => { releaseHeartbeat = r; });
  const heartbeatPending = new Promise<void>(r => { heartbeatArrived = r; });
  const heartbeatJournal = new Promise<void>(r => { heartbeatLogged = r; });
  let completing = false;
  let completions = 0;
  const lines: unknown[][] = [];
  const info = console.info;
  const journal = spyOn(console, "info").mockImplementation((...args) => {
    lines.push(args); info(...args);
    if (args[0] === "External relay heartbeat" && (args[1] as { status?: number }).status === 409) heartbeatLogged();
  });
  const release = chains.releaseConversationAsync;
  const cleanup = spyOn(chains, "releaseConversationAsync").mockImplementation(async (id, patch, until) => {
    if (patch.state === "idle") { entered(); await cleanupGate; throw Error("fixture chain cleanup refused"); }
    return release(id, patch, until);
  });
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      if ((body as { seq: number }).seq > 1 && completing) {
        heartbeatArrived(); await heartbeatGate;
        return { status: 409, body: { error: { code: "lease_lost" } } };
      }
      return { body: { status: "ok" } };
    }
    if (req.url?.endsWith("/complete")) {
      completions++;
      completing = true;
      await heartbeatPending;
      if (refusalBeforeAck) { releaseHeartbeat(); await heartbeatJournal; }
      return { body: { status: "accepted", duplicate: false } };
    }
    return { status: 404 };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  paired.targets[0]!.concurrency = 3;
  for (const requestId of ["completion-stale-a", "completion-stale-b"]) reserveRun({ requestId, leaseId: "fixture", relayId: paired.id,
    targetId: "target_1", childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: null, runDir: "",
    startedAt: "2026-01-01T00:00:00.000Z", ownerTurn: { clientAttemptId: requestId, cancel: "interrupt", confirmed: true } });
  updateRelayStore(s => ({ ...s, relays: [paired] })); setRelaySwitch("chain_conversations", true);
  const request = { ...contextRequest, request_id: "slot-completion-race", chat: { key: "capacity-fixture" }, liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2 },
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } };
  const pending = runClaimedRequestWithLeaseWorker(paired, request, undefined, { leaseWorker: true, ownerPorts: {
    launch: async () => ({ status: 202, body: { conversationId: "conversation_slot-completion" } }),
    observe: async () => ({ state: "ended", finalText: "Done" }), stop: async () => { throw Error("settled work must not be stopped"); },
  } }).then(value => ({ value }), error => ({ error }));
  try {
    await cleanupEntered;
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 3 }]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
    for (const id of ["completion-stale-a", "completion-stale-b"]) dropRun(id);
    await sweepExternalRelayOrphans();
    expect(readRunLedger().runs.some(row => row.requestId === request.request_id)).toBe(true);
    expect(chains.readConversations().some(row => row.state === "running")).toBe(true);
    releaseHeartbeat(); await heartbeatJournal;
    expect(lines.some(line => line[0] === "External relay heartbeat" && (line[1] as { phase?: string }).phase === "post_completion")).toBe(true);
    expect(readAnswerRecord(paired.id, "target_1", request.request_id)).toMatchObject({ outcome: "answered", delivery: "accepted" });
  } finally {
    releaseHeartbeat(); releaseCleanup(); await pending;
    cleanup.mockRestore(); journal.mockRestore();
    for (const id of ["completion-stale-a", "completion-stale-b"]) dropRun(id);
    // A failed cleanup leaves its durable marker. The same process's sweep
    // must release its chain without re-controlling the ended owner turn.
    await sweepExternalRelayOrphans({ launch: async () => { throw Error("unexpected launch"); },
      observe: async () => { throw Error("unexpected observation"); }, stop: async () => { throw Error("unexpected stop"); } });
    expect(chains.readConversations().every(row => row.state !== "running")).toBe(true);
    expect(completions).toBe(1);
    await server.close();
    for (const id of [request.request_id, "completion-stale-a", "completion-stale-b"]) dropRun(id);
  }
});
function stub(script: string) {
  const file = path.join(root, `stub-${crypto.randomUUID()}`);
  fs.writeFileSync(file, `#!/usr/bin/env bun\nconsole.log(JSON.stringify({type:"thread.started",thread_id:"00000000-0000-0000-0000-000000000001"}));\nif(process.env.CODEX_HOME) await Bun.write(process.env.CODEX_HOME+"/sessions/rollout-fixture-00000000-0000-0000-0000-000000000001.jsonl", "fixture");\n${script}\n`);
  fs.chmodSync(file, 0o700);
  return file;
}
test.each(["enabled", "disabled", "long-reservation"])("prototype owner control records the web decision without capacity or an agent, and concurrent replay adds nothing (%s)", async kind => {
  const ownerTier = kind === "enabled";
  const round = telegramRound(); saveTasks([telegramTask([round])]);
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = ownerTier;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  let selections = 0, launches = 0;
  const previous = accountManager.resolveHeadlessSpawn;
  accountManager.resolveHeadlessSpawn = (() => { selections++; return { kind: "exhausted", resetsAt: null }; }) as typeof previous;
  const copy = prototypeCopyLine(round);
  const text = kind === "long-reservation" ? `${copy}, ${"я".repeat(20_000 - copy.length - 2)}` : `${prototypeCopyLine(round, 2)}\nKeep these controls.`;
  const request = { ...contextRequest, request_id: `prototype-owner-${kind}`, answer: { ...contextRequest.answer, max_chars: 4000 }, input: {
    ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true },
    conversation: contextRequest.input.conversation.map(m => ({ ...m, text })) } };
  try {
    const ports = { command: "/missing-prototype-cli", ownerPorts: { launch: async () => { launches++; throw new Error("must not spawn"); },
      observe: async () => ({ state: "failed" as const }), stop: async () => {} } };
    const [result, duplicate] = await Promise.all([runClaimedRequest(paired, request, undefined, ports), runClaimedRequest(paired, request, undefined, ports)]);
    expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: "m1" } });
    if (result?.outcome === "answered") expect(result.answer.text).toContain("✅ Записав рішення");
    if (duplicate !== null) expect(duplicate).toMatchObject({ outcome: "answered" });
    expect(selections).toBe(0); expect(launches).toBe(0); expect(completions).toHaveLength(1);
    const task = loadTasks()[0]!, decision = task.prototypeReviews![0]!.decision!;
    expect(decision).toMatchObject({ chosen: kind === "long-reservation" ? [] : [2], originalReply: text,
      answers: round.questions!.map(q => ({ questionId: q.id, options: [0] })) });
    if (kind === "long-reservation") {
      expect(decision.recommendedWithReservation).toBe(true);
      expect(decision.comment).toBe(text.slice(copy.length));
      if (result?.outcome === "answered") expect(result.answer.text).toContain("рекомендовані з застереженням");
    } else expect(decision.comment).toBe("Keep these controls.");
    expect(decision.delivery.clientMessageId).toBe(`prototype-decision:${round.id}`);
    if (kind === "long-reservation") {
      expect(Buffer.byteLength(decision.delivery.text)).toBeLessThanOrEqual(32_000);
      expect(decision.delivery.text).toContain("recommended with reservation");
      expect(decision.delivery.text).toContain("Read read_prototype_review");
      expect(decision.delivery.text).not.toContain("\uFFFD");
    } else expect(decision.delivery.text).toBe(prototypeDecisionText(task, round, decision));
    expect(readAnswerRecord(paired.id, "target_1", request.request_id)?.profile).toMatchObject({ owner: true, prototype: round.id });
    expect(readRunLedger().runs).toEqual([]);
    const persisted = JSON.stringify(loadTasks());
    const replay = await runClaimedRequest(paired, { ...request, lease_id: "repeat-".repeat(4) }, undefined, ports);
    expect(replay).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: "m1" } });
    expect(JSON.stringify(loadTasks())).toBe(persisted);
    expect(selections).toBe(0); expect(launches).toBe(0);
  } finally { accountManager.resolveHeadlessSpawn = previous; await server.close(); }
});

test("the claimed relay records an Other token before a recommendation marker", async () => {
  const round = telegramRound(); saveTasks([telegramTask([round])]);
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  const text = `${prototypeReference(round)} · Відповіді 1a 2a 3+ · Відповіді рекомендовані`;
  const request = { ...contextRequest, request_id: "prototype-other-before-recommendation", answer: { ...contextRequest.answer, max_chars: 4000 }, input: {
    ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true },
    conversation: contextRequest.input.conversation.map(m => ({ ...m, text })) } };
  try {
    const result = await runClaimedRequest(paired, request, undefined, { command: "/missing-prototype-cli" });
    expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: "m1" } });
    if (result?.outcome === "answered") {
      expect(result.answer.text).toContain("рекомендовані з застереженням");
      expect(result.answer.text).toContain("3+");
    }
    expect(completions).toHaveLength(1);
    expect(loadTasks()[0]!.prototypeReviews![0]!.decision).toMatchObject({
      originalReply: text,
      comment: "3+",
      recommendedWithReservation: true,
      answers: [
        { questionId: "place", options: [0] },
        { questionId: "scope", options: [0] },
        { questionId: "timing", options: [0], other: true },
      ],
    });
  } finally { await server.close(); }
});

for (const scenario of ["references", "lease-lost", "revoked", "disabled"] as const) test(`prototype ${scenario} refuses before recording or spawning`, async () => {
  const round = telegramRound(); saveTasks([telegramTask([round])]);
  const paired = relay("https://unused.invalid/v1"); paired.targets[0]!.ownerTier = scenario !== "disabled";
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat")) {
      if (scenario === "lease-lost") return { status: 409, body: { error: { code: "lease_lost", message: "gone" } } };
      if (scenario === "revoked") updateRelayStore(s => ({ ...s, relays: [{ ...paired, targets: [{ ...paired.targets[0]!, ownerTier: false }] }] }));
      if (scenario === "disabled") updateRelayStore(s => ({ ...s, relays: [{ ...paired, targets: [{ ...paired.targets[0]!, enabled: false }] }] }));
    }
    return { body: { status: "ok" } };
  });
  paired.api_base = `${server.origin}/v1`; paired.origin = server.origin;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  const text = prototypeCopyLine(round, 2) + (scenario === "references" ? `\n${prototypeReference(round)}` : "");
  try {
    const result = await runClaimedRequest(paired, { ...contextRequest, request_id: `prototype-${scenario}`, answer: { ...contextRequest.answer, max_chars: 4000 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true }, conversation: contextRequest.input.conversation.map(m => ({ ...m, text })) } },
      undefined, { command: "/missing-prototype-cli" });
    if (scenario === "references") {
      expect(result).toMatchObject({ outcome: "answered" });
      if (result?.outcome === "answered") expect(result.answer.text).toContain("Не записав:");
    } else if (scenario === "lease-lost") expect(result).toBeNull();
    else expect(result).toMatchObject({ outcome: "failed" });
    expect(loadTasks()[0]!.prototypeReviews![0]!.decision).toBeUndefined();
  } finally { await server.close(); }
});

for (const scenario of ["member", "owner-off-unknown", "unknown", "decided", "superseded"] as const) test(`prototype ${scenario} text follows the ordinary relay path`, async () => {
  const round = telegramRound();
  const held = telegramTask([round]);
  if (scenario === "decided") round.decision = { chosen: [1], comment: "Earlier", at: round.createdAt,
    delivery: { state: "no-orchestrator", conversationId: null, clientMessageId: "decision", text: "decision" } };
  if (scenario === "superseded") held.prototypeReviews!.push(telegramRound("next"));
  saveTasks(scenario === "unknown" || scenario === "owner-off-unknown" ? [] : [held]);
  const before = JSON.stringify(loadTasks());
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = scenario !== "owner-off-unknown";
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  let launches = 0;
  const text = prototypeCopyLine(round, 2);
  try {
    const result = await runClaimedRequest(paired, { ...contextRequest, request_id: `ordinary-${scenario}`, answer: { ...contextRequest.answer, max_chars: 4000 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: scenario !== "member" },
        tools: [], conversation: contextRequest.input.conversation.map(m => ({ ...m, text })) } }, undefined, {
      command: stub("const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Normal',reply_to:'m1'}));"),
      ownerPorts: { launch: async () => { launches++; return { status: 202, body: { conversationId: "conversation_ordinary" } }; },
        observe: async () => ({ state: "ended", finalText: "Normal" }), stop: async () => {}, pollMs: 5 },
    });
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "Normal" } });
    expect(launches).toBe(scenario === "member" || scenario === "owner-off-unknown" ? 0 : 1);
    expect(JSON.stringify(loadTasks())).toBe(before);
  } finally { await server.close(); }
});

test("an unsafe provider home declines as a profile error before launch", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const previous = accountManager.resolveHeadlessSpawn;
  const previousClaudeHome = process.env.LLV_CLAUDE_HOME;
  try {
    process.env.LLV_CLAUDE_HOME = path.join(root, "empty-claude-home");
    fs.mkdirSync(process.env.LLV_CLAUDE_HOME, { recursive: true });
    const provider = createManagedClaudeAccount("Relay provider", {
      config: { baseUrl: "https://provider.invalid", model: "provider-model", smallFastModel: null },
      token: "local-provider-fixture-token",
    });
    fs.rmSync(path.join(provider.home, ".provider-token"));
    const unsafeAccount: AccountContext = {
      ...account,
      engine: "claude",
      home: provider.home,
    };
    accountManager.resolveHeadlessSpawn = (() => ({
      kind: "available", account: unsafeAccount,
    })) as typeof previous;
    const paired = relay(`${server.origin}/v1`);
    paired.targets[0] = { ...paired.targets[0]!, engine: "claude", model: "haiku" };
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_unsafe_provider_home",
    }, undefined, { command: stub("throw new Error('should not launch')") });
    expect(outcome).toMatchObject({ outcome: "declined", reason: "profile_error" });
    expect(readAnswerRecord(paired.id, "target_1", "rq_unsafe_provider_home")?.admitted).toBe(false);
    expect(completions).toHaveLength(1);
    expect(readRunLedger().runs).toEqual([]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    accountManager.resolveHeadlessSpawn = previous;
    if (previousClaudeHome === undefined) delete process.env.LLV_CLAUDE_HOME;
    else process.env.LLV_CLAUDE_HOME = previousClaudeHome;
    await server.close();
  }
});
test("heartbeat 1 acknowledges the claim before account selection and a held owner spawn", async () => {
  const beats: { seq: number; progress: unknown }[] = [];
  let release!: () => void;
  const slowSpawn = new Promise<void>(resolve => { release = resolve; });
  let selectedAfterAck = false, launchedAfterAck = false, spawnStarted = false;
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) { beats.push(body as typeof beats[number]); return { body: { status: "ok" } }; }
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  paired.features = ["progress_steps"];
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockImplementation(() => {
    selectedAfterAck = beats.length > 0;
    return { kind: "available", account };
  });
  const claimedAt = Date.now();
  const pending = runClaimedRequest(paired, { ...contextRequest, request_id: "early-ack",
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
    ownerPorts: { launch: async () => { spawnStarted = true; launchedAfterAck = beats.length > 0; await slowSpawn;
      return { status: 202, body: { conversationId: "conversation_early_ack" } }; },
      observe: async () => ({ state: "ended", finalText: "Done" }), stop: async () => {}, pollMs: 1 },
  });
  try {
    for (let i = 0; i < 100 && !spawnStarted; i++) await Bun.sleep(5);
    expect(beats[0]).toMatchObject({ seq: 1, progress: { kind: "step", label: "accepted" } });
    expect(Date.now() - claimedAt).toBeLessThan(contextRequest.liveness.ack_window_s * 1000);
    expect(selectedAfterAck).toBe(true);
    expect(launchedAfterAck).toBe(true);
    expect(readRunLedger().runs.some(run => run.requestId === "early-ack")).toBe(true);
  } finally {
    release(); await pending; selection.mockRestore(); await server.close();
  }
});

test("a slow first acknowledgement cannot start work after the request cutoff", async () => {
  let launches = 0;
  const completions: unknown[] = [];
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) { await Bun.sleep(350); return { body: { status: "ok" } }; }
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  const pending = runClaimedRequest(paired, {
    ...contextRequest, request_id: "slow-first-ack-cutoff",
    deadline_at: new Date(Date.now() + 150).toISOString(),
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } },
  }, undefined, { ownerPorts: {
    launch: async () => { launches++; return { status: 202, body: { conversationId: "conversation_too_late" } }; },
    observe: async () => ({ state: "ended", finalText: "Too late" }), stop: async () => {}, pollMs: 1,
  } });
  try {
    expect(await pending).toMatchObject({ outcome: "declined", reason: "busy" });
    expect(launches).toBe(0);
    expect(completions).toHaveLength(1);
  } finally { await server.close(); }
});

test("a completion ready after the absolute deadline receives no renewed retry window", async () => {
  let completions = 0, settled = false;
  const server = await startTestRelay(async req => {
    if (req.url?.endsWith("/heartbeat")) { await Bun.sleep(350); return { body: { status: "ok" } }; }
    if (req.url?.endsWith("/complete")) { completions++; return { status: 503, body: { error: { code: "unavailable" } } }; }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`);
  const previous = accountManager.resolveHeadlessSpawn;
  accountManager.resolveHeadlessSpawn = (() => ({ kind: "exhausted", resetsAt: null })) as typeof previous;
  const pending = runClaimedRequest(paired, {
    ...sampleRequest, request_id: "completion-after-deadline",
    deadline_at: new Date(Date.now() + 150).toISOString(),
  }).finally(() => { settled = true; });
  try {
    await Promise.race([pending, Bun.sleep(1300)]);
    expect(settled).toBe(true);
    expect(completions).toBe(1);
  } finally { accountManager.resolveHeadlessSpawn = previous; await server.close(); }
}, 5000);

test("an accepted busy decline remains terminal after its execution slot row is gone", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body as typeof completions[number]);
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`);
  const blocker = { requestId: "terminal-claim-blocker", leaseId: "blocker-lease", relayId: paired.id, targetId: "target_1",
    childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid),
    runDir: root, startedAt: new Date().toISOString() };
  expect(reserveRun(blocker, 1)).toBe("added");
  const request = { ...sampleRequest, request_id: "terminal-busy-request", deadline_at: new Date(Date.now() + 10_100).toISOString() };
  try {
    expect(await runClaimedRequest(paired, request)).toMatchObject({ outcome: "declined", reason: "busy" });
    expect(readRunLedger().runs.map(run => run.requestId)).toEqual([blocker.requestId]);
    dropRun(blocker.requestId);
    expect(await runClaimedRequest(paired, request)).toMatchObject({ outcome: "declined", reason: "busy" });
    expect(completions).toEqual([{ lease_id: request.lease_id, outcome: "declined", reason: "busy", detail: null, retry_after_s: null }]);
  } finally { dropRun(blocker.requestId); await server.close(); }
});

test("failed feature refresh during an early completion releases duplicate suppression", async () => {
  let refuse = true;
  const server = await startTestRelay(() => refuse ? { status: 400, body: { error: { code: "unknown_feature" } } } : { body: { status: "ok" } });
  const paired = relay(`${server.origin}/v1`);
  const request = { ...sampleRequest, request_id: "early-refresh-failure", target_id: "unconfigured" };
  try {
    await expect(runClaimedRequest(paired, request, undefined, { onUnknownFeature: async () => { throw new Error("refresh failed"); } })).rejects.toThrow("refresh failed");
    refuse = false;
    expect(await runClaimedRequest(paired, request)).toMatchObject({ outcome: "declined", reason: "not_configured" });
  } finally { refuse = false; await server.close(); }
});

test("invalid compact completion retries end at the captured request deadline", async () => {
  setRelaySwitch("chain_conversations", true);
  setRelaySwitch("compact", true);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let attempts = 0, accept = false, settled = false;
  const server = await startTestRelay(() => {
    attempts++; now += 601000;
    return accept ? { body: { status: "ok" } } : { status: 503, body: { error: { code: "unavailable" } } };
  });
  const pending = runClaimedRequest(relay(`${server.origin}/v1`), { kind: "compact", request_id: "invalid-compact-deadline", lease_id: sampleRequest.lease_id })
    .then(value => { settled = true; return value; });
  try {
    await Promise.race([pending, Bun.sleep(300)]);
    expect(settled).toBe(true);
    expect(attempts).toBe(1);
    expect(await pending).toMatchObject({ outcome: "declined", reason: "invalid_request" });
  } finally { accept = true; await pending; clock.mockRestore(); setRelaySwitch("compact", false); setRelaySwitch("chain_conversations", false); await server.close(); }
}, 10000);

test("an early decline keeps heartbeats during delivery without renewing its deadline", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let heartbeatCount = 0, completionCount = 0, acceptCompletion = false, settled = false;
  const heartbeatWaiters: (() => void)[] = [];
  const server = await startTestRelay(async req => {
    if (req.url?.endsWith("/heartbeat")) {
      heartbeatCount++;
      heartbeatWaiters.splice(0).forEach(resolve => resolve());
      return { body: { status: "ok" } };
    }
    if (req.url?.endsWith("/complete")) {
      completionCount++;
      if (acceptCompletion) return { body: { status: "accepted", duplicate: false } };
      now += 46_000;
      await Promise.race([
        new Promise<void>(resolve => heartbeatWaiters.push(resolve)),
        Bun.sleep(1200),
      ]);
      return { status: 503, body: { error: { code: "unavailable" } } };
    }
    return { status: 404 };
  });
  const paired = relay(`${server.origin}/v1`);
  const previousSelection = accountManager.resolveHeadlessSpawn;
  accountManager.resolveHeadlessSpawn = (() => ({ kind: "exhausted", resetsAt: null })) as typeof previousSelection;
  const request = { ...sampleRequest, request_id: "early_decline_completion_retry",
    deadline_at: new Date(now + 120_000).toISOString(),
    liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2, stall_window_s: 120 } };
  const pending = runClaimedRequest(paired, request).then(outcome => { settled = true; return outcome; });
  try {
    const firstResult = await Promise.race([
      pending.then(outcome => ({ kind: "settled" as const, outcome })),
      Bun.sleep(7000).then(() => ({ kind: "timeout" as const })),
    ]);
    expect(firstResult.kind).toBe("settled");
    if (firstResult.kind === "settled") {
      expect(firstResult.outcome).toMatchObject({ outcome: "declined", reason: "no_capacity" });
    }
    expect(completionCount).toBeGreaterThan(0);
    expect(heartbeatCount).toBeGreaterThan(1);
    expect(readAnswerRecord(paired.id, "target_1", request.request_id)?.delivery).toBe("unconfirmed");
    expect(readRunLedger().runs.some(run => run.requestId === request.request_id)).toBe(false);
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 1 }]);
  } finally {
    acceptCompletion = true;
    heartbeatWaiters.splice(0).forEach(resolve => resolve());
    if (!settled) await Promise.race([pending, Bun.sleep(7000)]);
    accountManager.resolveHeadlessSpawn = previousSelection;
    clock.mockRestore();
    await server.close();
  }
}, 12000);

test("heartbeat journal records attempts, step ids and failures without credential or note content", async () => {
  const logs: unknown[][] = [];
  const logger = spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
  const server = await startTestRelay(req => req.url?.endsWith("/heartbeat")
    ? { status: 409, body: { error: { code: "lease_lost", message: "private remote detail" } } }
    : { body: { status: "accepted", duplicate: false } });
  const paired = relay(`${server.origin}/v1`); paired.features = ["progress_steps"];
  const request = { ...sampleRequest, request_id: "journal-request" };
  try {
    expect(await runClaimedRequest(paired, request, undefined, { command: "/missing-journal-cli" })).toBeNull();
    const journal = logs.filter(row => row[0] === "External relay heartbeat");
    expect(journal).toHaveLength(2);
    expect(journal[0]![1]).toMatchObject({ request: "journal-", seq: 1, phase: "attempt", step: "accepted" });
    expect(journal[1]![1]).toMatchObject({ request: "journal-", seq: 1, phase: "failed", status: 409, code: "lease_lost", step: "accepted" });
    for (const secret of [paired.credential, request.lease_id, "private remote detail", request.input.request_text])
      if (secret) expect(JSON.stringify(journal)).not.toContain(secret);
  } finally { logger.mockRestore(); await server.close(); }
});

test("heartbeat sends stay on their grid despite acknowledgement latency", async () => {
  const sends: number[] = [];
  const server = await startTestRelay(async req => {
    if (req.url?.endsWith("/heartbeat")) { sends.push(Date.now()); await Bun.sleep(400); }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  try {
    const result = await runClaimedRequest(paired, { ...contextRequest, request_id: "cadence",
      liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
      ownerPorts: { launch: async () => ({ status: 202, body: { conversationId: "conversation_cadence" } }),
        observe: async () => sends.length >= 6 ? { state: "ended", finalText: "Done" } : { state: "running" }, stop: async () => {}, pollMs: 20 },
    });
    expect(result?.outcome).toBe("answered");
    expect(sends.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < sends.length; i++) expect(sends[i]! - sends[i - 1]!).toBeLessThanOrEqual(2050);
  } finally { await server.close(); }
}, 25000);

test("heartbeats continue through silence, newest progress is sent, completion frees slot", async () => {
  const beats: { seq: number; progress: { label: string } | null }[] = [];
  const completed: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      beats.push(body as typeof beats[number]);
      return { body: { status: "ok" } };
    }
    if (req.url?.endsWith("/complete")) {
      completed.push(body);
      return { body: { status: "accepted", duplicate: false } };
    }
    return { status: 404 };
  });
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'First'}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Checking notes'}}));await Bun.sleep(2300);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:'m1'}));`,
  );
  try {
    const paired = relay(`${server.origin}/v1`);
    const request = {
      ...sampleRequest,
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2 },
    };
    expect(advertisedSlots(paired)).toEqual([
      { target_id: "target_1", free: 1 },
    ]);
    const pending = runClaimedRequest(paired, request, undefined, {
      command: script,
    });
    await Bun.sleep(300);
    expect(advertisedSlots(paired)).toEqual([
      { target_id: "target_1", free: 0 },
    ]);
    const outcome = await pending;
    expect(outcome?.outcome).toBe("answered");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0].seq).toBe(1);
    expect(beats[1]!.progress!.label).toBe("Checking notes");
    /* The settings page reads the same label, kept in memory for the relay. */
    expect(relayActivity(paired.id).lastProgress).toMatchObject({ targetId: "target_1", label: "Checking notes" });
    expect(completed).toHaveLength(1);
    expect(runningCount(paired.id, "target_1")).toBe(0);
    expect(readRunLedger().runs).toEqual([]);
  } finally {
    await server.close();
  }
});

test("a queued step crossing a grid point sends the overdue regular heartbeat immediately", async () => {
  const sends: { at: number; seq: number; label?: string }[] = [];
  let queuedAckAt = 0;
  let overdueSent = false;
  const cadenceAfterAck: number[] = [];
  const schedule = globalThis.setTimeout;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    if (queuedAckAt && !overdueSent && new Error().stack?.includes("armCadence")) cadenceAfterAck.push(Number(args[1] ?? 0));
    return schedule(...args);
  }) as typeof setTimeout);
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      const beat = body as { seq: number; progress?: { label?: string } };
      if (queuedAckAt) overdueSent = true;
      sends.push({ at: Date.now(), seq: beat.seq, label: beat.progress?.label });
      if (beat.progress?.label === "queued") { await Bun.sleep(1500); queuedAckAt = Date.now(); }
      return { body: { status: "ok" } };
    }
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true; paired.features = ["progress_steps"];
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  try {
    const result = await runClaimedRequest(paired, {
      ...contextRequest, request_id: "queued-step-grid-boundary",
      liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } },
    }, undefined, { ownerPorts: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_grid", initialMessage: "queued" } }),
      observe: async () => {
        const queued = sends.find(beat => beat.label === "queued");
        return queued && sends.some(beat => beat.seq > queued.seq) ? { state: "ended", finalText: "Done" } : { state: "running", firstMessagePending: true };
      }, stop: async () => {}, pollMs: 5,
    } });
    expect(result?.outcome).toBe("answered");
    const queued = sends.find(beat => beat.label === "queued")!;
    const following = sends.find(beat => beat.seq > queued.seq)!;
    expect(following.seq).toBeGreaterThan(queued.seq);
    expect(cadenceAfterAck.every(delay => delay === 0)).toBe(true);
    expect(following.at - queued.at).toBeLessThan(1900);
  } finally { timers.mockRestore(); await server.close(); }
}, 10000);
test("a full target waits for its slot and a nonzero CLI exit cannot use a written answer", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) =>
    req.url?.endsWith("/complete")
      ? (completions.push(body),
        { body: { status: "accepted", duplicate: false } })
      : { body: { status: "ok" } },
  );
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));await Bun.sleep(700);process.exit(2);`,
  );
  try {
    const paired = relay(`${server.origin}/v1`);
    const first = runClaimedRequest(
      paired,
      { ...sampleRequest, request_id: "rq_2" },
      undefined,
      { command: script },
    );
    await Bun.sleep(150);
    const busy = await runClaimedRequest(
      paired,
      { ...sampleRequest, request_id: "rq_3" },
      undefined,
      { command: script },
    );
    expect(busy).toMatchObject({ outcome: "failed", reason: "agent_error" });
    expect(await first).toMatchObject({
      outcome: "failed",
      reason: "agent_error",
    });
    expect(completions).toHaveLength(2);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    await server.close();
  }
});
test("a lost lease cancels the child and never completes", async () => {
  let completes = 0;
  const server = await startTestRelay((req) =>
    req.url?.endsWith("/heartbeat")
      ? {
          status: 409,
          body: { error: { code: "lease_lost", message: "gone" } },
        }
      : (completes++, { body: { status: "accepted", duplicate: false } }),
  );
  const script = stub(`await Bun.stdin.text();await Bun.sleep(5000);`);
  try {
    const outcome = await runClaimedRequest(
      relay(`${server.origin}/v1`),
      { ...sampleRequest, request_id: "rq_4" },
      undefined,
      { command: script },
    );
    expect(outcome).toBeNull();
    expect(completes).toBe(0);
  } finally {
    await server.close();
  }
});
test("unacknowledged heartbeats stop the child after the stall window", async () => {
  let completes = 0;
  let beats = 0;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat")) {
      beats++;
      return { status: 503, body: { error: { code: "unavailable", message: "later" } } };
    }
    completes++;
    return { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(`await Bun.stdin.text();await Bun.sleep(30000);`);
  try {
    const paired = relay(`${server.origin}/v1`);
    const start = Date.now();
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_stalled",
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2, stall_window_s: 10 },
    }, undefined, { command: script, timeoutMs: 15000 });
    expect(outcome).toBeNull();
    expect(Date.now() - start).toBeLessThan(14000);
    expect(beats).toBeGreaterThanOrEqual(2);
    expect(completes).toBe(0);
    expect(readRunLedger().runs).toEqual([]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    await server.close();
  }
}, 20_000);
test("a ledger failure after launch stops the child before failed completion", async () => {
  let childPid: number | null = null;
  let childIdentity: string | null = null;
  let aliveAtCompletion = true;
  let groupAliveAtCompletion = true;
  let slotsAtCompletion = -1;
  let injected = false;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    aliveAtCompletion = processMatches(childPid, childIdentity);
    try {
      process.kill(-childPid!, 0);
    } catch {
      groupAliveAtCompletion = false;
    }
    slotsAtCompletion = advertisedSlots(paired)[0]?.free ?? -1;
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`);
  const script = stub(`await Bun.stdin.text();await Bun.sleep(30000);`);
  try {
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_ledger_failure",
    }, undefined, {
      command: script,
      processIdentity: (pid) => {
        const identity = procBackend.processIdentity(pid);
        if (!injected) {
          injected = true;
          childPid = pid;
          childIdentity = identity;
          const file = externalRelayFile("runs");
          const original = fs.readFileSync(file, "utf8");
          fs.writeFileSync(file, "{broken");
          setTimeout(() => fs.writeFileSync(file, original), 0);
        }
        return identity;
      },
    });
    expect(injected).toBe(true);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "agent_error" });
    expect(aliveAtCompletion).toBe(false);
    expect(groupAliveAtCompletion).toBe(false);
    expect(slotsAtCompletion).toBe(0);
    expect(readRunLedger().runs).toEqual([]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    if (processMatches(childPid, childIdentity))
      terminateHeadlessReviewerGroup(childPid!, childIdentity);
    await server.close();
  }
}, 10_000);
test("a persistent ledger read error still releases the local slot", async () => {
  const requestId = "rq_ledger_unreadable";
  const ledgerFile = externalRelayFile("runs");
  let originalLedger: string | null = null;
  let childPid: number | null = null;
  let childIdentity: string | null = null;
  let completions = 0;
  const pairedServer = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions++;
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${pairedServer.origin}/v1`);
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: requestId,
    }, undefined, {
      command: stub(`await Bun.stdin.text();await Bun.sleep(30000);`),
      processIdentity: (pid) => {
        const identity = procBackend.processIdentity(pid);
        if (originalLedger === null) {
          childPid = pid;
          childIdentity = identity;
          originalLedger = fs.readFileSync(ledgerFile, "utf8");
          fs.writeFileSync(ledgerFile, "{broken");
        }
        return identity;
      },
    });
    expect(outcome).toMatchObject({ outcome: "failed", reason: "agent_error" });
    expect(completions).toBe(1);
    expect(runningCount(paired.id, "target_1")).toBe(0);
    expect(errors.some((message) => message.startsWith("External relay run ledger cleanup failed"))).toBe(true);
  } finally {
    console.error = originalError;
    if (originalLedger !== null) {
      fs.writeFileSync(ledgerFile, originalLedger);
      dropRun(requestId);
    }
    if (processMatches(childPid, childIdentity))
      terminateHeadlessReviewerGroup(childPid!, childIdentity);
    await pairedServer.close();
  }
}, 10_000);
test("an acknowledged heartbeat still keeps the run alive after a delayed response", async () => {
  const completions: unknown[] = [];
  const started = Date.now();
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      if (Date.now() - started < 8000)
        return { status: 503, body: { error: { code: "unavailable", message: "later" } } };
      await Bun.sleep(3000);
      return { body: { status: "ok" } };
    }
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.sleep(12000);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  try {
    const outcome = await runClaimedRequestWithLeaseWorker(relay(`${server.origin}/v1`), {
      ...sampleRequest, request_id: "rq_late_ack",
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2, stall_window_s: 10 },
    }, undefined, { command: script, timeoutMs: 18000, leaseWorker: true });
    expect(outcome?.outcome).toBe("answered");
    expect(completions).toHaveLength(1);
  } finally {
    await server.close();
  }
}, 20_000);
test("Claude startup failure without init completes agent_error", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(`await Bun.stdin.text();process.exit(2);`);
  try {
    const paired = relay(`${server.origin}/v1`);
    paired.targets[0].engine = "claude";
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_claude_startup",
    }, undefined, { command: script });
    expect(outcome).toMatchObject({ outcome: "failed", reason: "agent_error" });
    expect(completions).toHaveLength(1);
  } finally {
    await server.close();
  }
});
test("completion retry reuses the identical body after a lost response", async () => {
  const bodies: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    bodies.push(body);
    return bodies.length === 1
      ? { drop: true }
      : { body: { status: "accepted", duplicate: true } };
  });
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  try {
    const outcome = await runClaimedRequest(
      relay(`${server.origin}/v1`),
      { ...sampleRequest, request_id: "rq_5" },
      undefined,
      { command: script },
    );
    expect(outcome?.outcome).toBe("answered");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
  } finally {
    await server.close();
  }
});
test("accepted completion stays terminal if local settlement contends", async () => {
  const completions: unknown[] = [];
  const requestId = "rq_settlement_contention";
  const requestLock = `${externalRelayFile("requests")}.lock`;
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) {
      completions.push(body);
      fs.writeFileSync(requestLock, JSON.stringify({ pid: process.pid, identity: procBackend.processIdentity(process.pid) }), { flag: "wx" });
      setTimeout(() => fs.rmSync(requestLock, { force: true }), 6200);
    }
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`);
  try {
    const result = await runClaimedRequest(paired, { ...sampleRequest, request_id: requestId,
      deadline_at: new Date(Date.now() + 30000).toISOString() }, undefined,
      { command: stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`) });
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "Done" } });
    expect(completions).toHaveLength(1);
    dropRun(requestId);
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: requestId,
      deadline_at: new Date(Date.now() + 30000).toISOString() })).toMatchObject({ outcome: "answered", answer: { text: "Done" } });
    expect(completions).toHaveLength(1);
  } finally {
    fs.rmSync(requestLock, { force: true });
    await server.close();
  }
}, 15000);

test("claim identity contention waits within the request budget", async () => {
  const heartbeats: unknown[] = [];
  const completions: unknown[] = [];
  const requestLock = `${externalRelayFile("requests")}.lock`;
  fs.mkdirSync(path.dirname(requestLock), { recursive: true });
  fs.writeFileSync(requestLock, JSON.stringify({ pid: process.pid, identity: procBackend.processIdentity(process.pid) }), { flag: "wx" });
  const release = setTimeout(() => fs.rmSync(requestLock, { force: true }), 6200);
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) heartbeats.push(body);
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  try {
    const started = Date.now();
    const result = await runClaimedRequest(relay(`${server.origin}/v1`), { ...sampleRequest,
      request_id: "rq_claim_contention", deadline_at: new Date(started + 30000).toISOString() }, undefined,
      { command: stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`) });
    expect(result?.outcome).toBe("answered");
    expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(completions).toHaveLength(1);
  } finally {
    clearTimeout(release);
    fs.rmSync(requestLock, { force: true });
    await server.close();
  }
}, 15000);

test("an immediately available last-ten-seconds request may answer", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  try {
    const deadlineAt = Date.now() + 5000;
    const result = await runClaimedRequest(relay(`${server.origin}/v1`), { ...sampleRequest,
      request_id: "rq_last_ten_seconds", deadline_at: new Date(deadlineAt).toISOString() }, undefined,
      { command: stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`) });
    expect(result?.outcome).toBe("answered");
    expect(Date.now()).toBeLessThan(deadlineAt);
    expect(completions).toHaveLength(1);
  } finally { await server.close(); }
}, 10000);

test("an immediately admitted owner can answer in the final ten seconds", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`);
  paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  try {
    const deadlineAt = Date.now() + 5000;
    const result = await runClaimedRequest(paired, { ...contextRequest, request_id: "rq_owner_final_ten_seconds",
      deadline_at: new Date(deadlineAt).toISOString(), answer: { ...contextRequest.answer, max_chars: 1000, progress: "none" },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, { ownerPorts: {
        launch: async () => ({ status: 202, body: { conversationId: "conversation_deadline", initialMessage: "delivered" } }),
        observe: async () => ({ state: "ended", finalText: "Done" }),
        stop: async () => {}, pollMs: 5,
      } });
    expect(result?.outcome).toBe("answered");
    expect(Date.now()).toBeLessThan(deadlineAt);
    expect(completions).toHaveLength(1);
  } finally { await server.close(); }
}, 10000);

test("a confirmed owner run completes a readable timeout at the service deadline", async () => {
  const completions: unknown[] = [];
  const stops: string[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`);
  paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  try {
    const result = await runClaimedRequest(paired, { ...contextRequest, request_id: "rq_confirmed_past_deadline",
      deadline_at: new Date(Date.now() + 700).toISOString(),
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
      ownerPorts: {
        launch: async () => ({ status: 202, body: { conversationId: "conversation_past_deadline", initialMessage: "delivered" } }),
        observe: async () => { await Bun.sleep(1100); return { state: "ended", finalText: "Done" }; },
        stop: async (_id, action) => { stops.push(action); }, pollMs: 5,
      },
    });
    expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", text: expect.stringMatching(/ran out of time/i) } });
    expect(stops).toEqual(["interrupt"]);
    expect(completions).toHaveLength(1);
  } finally { await server.close(); }
}, 10000);

test("claim contention through expiry never sends a completion without exclusive request custody", async () => {
  const completions: unknown[] = [];
  const requestLock = `${externalRelayFile("requests")}.lock`;
  fs.mkdirSync(path.dirname(requestLock), { recursive: true });
  fs.writeFileSync(requestLock, JSON.stringify({ pid: process.pid, identity: procBackend.processIdentity(process.pid) }), { flag: "wx" });
  const release = setTimeout(() => fs.rmSync(requestLock, { force: true }), 5000);
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  try {
    const request = { ...sampleRequest, request_id: "rq_claim_contention_expired",
      deadline_at: new Date(Date.now() + 3000).toISOString() };
    const results = await Promise.all([
      runClaimedRequest(relay(`${server.origin}/v1`), request),
      runClaimedRequest(relay(`${server.origin}/v1`), request),
    ]);
    expect(results).toEqual([null, null]);
    expect(completions).toHaveLength(0);
  } finally {
    clearTimeout(release);
    fs.rmSync(requestLock, { force: true });
    await server.close();
  }
}, 10000);
test("unknown request kind is declined as unsupported", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((_req, body) => {
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  try {
    const outcome = await runClaimedRequest(
      relay(`${server.origin}/v1`),
      { ...sampleRequest, kind: "summarize", request_id: "rq_kind" },
    );
    expect(outcome).toMatchObject({ outcome: "declined", reason: "unsupported_kind" });
    expect(completions).toHaveLength(1);
  } finally {
    await server.close();
  }
});
test("404 heartbeat drops the lease and cancels the child", async () => {
  let completes = 0;
  const server = await startTestRelay((req) =>
    req.url?.endsWith("/heartbeat")
      ? { status: 404, body: { error: { code: "not_found", message: "gone" } } }
      : (completes++, { body: { status: "accepted", duplicate: false } }),
  );
  const script = stub(`await Bun.stdin.text();await Bun.sleep(5000);`);
  try {
    const outcome = await runClaimedRequest(
      relay(`${server.origin}/v1`),
      { ...sampleRequest, request_id: "rq_404" },
      undefined,
      { command: script },
    );
    expect(outcome).toBeNull();
    expect(completes).toBe(0);
  } finally {
    await server.close();
  }
});
test("a duplicate claim leaves the held lease alone", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) =>
    req.url?.endsWith("/heartbeat")
      ? { body: { status: "ok" } }
      : (completions.push(body), { body: { status: "accepted", duplicate: false } }),
  );
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.sleep(500);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  try {
    const paired = relay(`${server.origin}/v1`);
    const request = { ...sampleRequest, request_id: "rq_duplicate" };
    const first = runClaimedRequest(paired, request, undefined, { command: script });
    for (let i = 0; i < 30 && readRunLedger().runs.length === 0; i++) await Bun.sleep(20);
    expect(readRunLedger().runs.map((run) => run.requestId)).toContain(request.request_id);
    const routeCopy = await import("./runner.ts" + "?route-copy") as typeof import("./runner");
    expect(routeCopy.runningCount(paired.id, "target_1")).toBe(1);
    expect(await runClaimedRequest({ ...paired, paused: true }, request, undefined, { command: script })).toBeNull();
    expect(readRunLedger().runs.map((run) => run.requestId)).toContain(request.request_id);
    expect((await first)?.outcome).toBe("answered");
    expect(completions).toHaveLength(1);
  } finally {
    await server.close();
  }
});
test("newly confirmed targets default to a 30 minute hard cap", async () => {
  const owner = {
    namespace: "test", id: "owner", display_name: "Owner", handle: null,
  };
  const target = {
    target_id: "target", name: "Target", answered_by: "install" as const,
    fallback: "service" as const,
  };
  const server = await startTestRelay(() => ({
    body: { credential: "x".repeat(43), version: 1, owner, targets: [target] },
  }));
  try {
    updateRelayStore((store) => ({
      ...store,
      pending: [{
        id: "pending_cap", origin: server.origin, api_base: `${server.origin}/v1`,
        name: "Test", description: "", limits: relay(`${server.origin}/v1`).limits,
        pairing_id: "pair_cap", poll_secret: "x".repeat(43),
        code: "1234-5678", verify_url: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        poll_interval_s: 2, owner, targets: [target],
      }],
    }));
    const confirmed = await confirmRelayPairing("pending_cap", owner.id);
    expect(confirmed.targets[0].hardCapMinutes).toBe(30);
  } finally {
    await server.close();
  }
});
test("exhausted account sends a retry hint in seconds", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  accountManager.resolveHeadlessSpawn = (() => ({
    kind: "exhausted", resetsAt: Math.floor(Date.now() / 1000) + 3600,
  })) as typeof original;
  try {
    const outcome = await runClaimedRequest(relay(`${server.origin}/v1`), {
      ...sampleRequest, request_id: "rq_exhausted",
    });
    expect(outcome).toMatchObject({ outcome: "declined", reason: "no_capacity" });
    expect(outcome?.outcome === "declined" && outcome.retry_after_s).toBeGreaterThanOrEqual(3598);
    expect(outcome?.outcome === "declined" && outcome.retry_after_s).toBeLessThanOrEqual(3600);
    expect(completions).toHaveLength(1);
  } finally {
    accountManager.resolveHeadlessSpawn = (() => ({ kind: "available", account })) as typeof original;
    await server.close();
  }
});
test("a note arriving during a heartbeat is sent on the next beat", async () => {
  const beats: { seq: number; progress: { label: string } | null }[] = [];
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      beats.push(body as typeof beats[number]);
      if (beats.length === 1) await Bun.sleep(450);
    }
    return { body: { status: "ok" } };
  });
  const script = stub(`await Bun.stdin.text();await Bun.sleep(100);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Still working'}}));await Bun.sleep(3000);const a=process.argv.slice(2);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  try {
    const outcome = await runClaimedRequest(relay(`${server.origin}/v1`), {
      ...sampleRequest, request_id: "rq_progress_race",
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2 },
    }, undefined, { command: script });
    expect(outcome?.outcome).toBe("answered");
    expect(beats[0].progress).toBeNull();
    expect(beats.some((beat) => beat.progress?.label === "Still working")).toBe(true);
  } finally {
    await server.close();
  }
});
test("local answers and early declines survive recovery while completion is pending", async () => {
  for (const earlyDecline of [false, true]) {
    let received!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => { received = resolve; });
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    const server = await startTestRelay(async (req) => {
      if (req.url?.endsWith("/complete")) {
        received();
        await acknowledgement;
        return { body: { status: "accepted", duplicate: false } };
      }
      return { body: { status: "ok" } };
    });
    const paired = relay(`${server.origin}/v1`);
    paired.paused = earlyDecline;
    const requestId = earlyDecline ? "rq_pending_decline" : "rq_pending_answer";
    const pending = runClaimedRequest(paired, { ...sampleRequest, request_id: requestId }, undefined, {
      command: stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`),
    });
    try {
      await seen;
      const record = readAnswerRecord(paired.id, "target_1", requestId);
      expect(record).toMatchObject({
        state: "finished", delivery: "unconfirmed", input: sampleRequest.input,
        outcome: earlyDecline ? "declined:disabled" : "answered",
        answer: earlyDecline ? null : { action: "reply", text: "Done", reply_to: null },
      });
      // The recovery path only settles unfinished model work; a persisted
      // local result keeps its answer and its uncertain original receipt.
      settleInterruptedAnswer(paired.id, "target_1", requestId, "refused");
      expect(readAnswerRecord(paired.id, "target_1", requestId)).toEqual(record);
      release();
      await pending;
      expect(readAnswerRecord(paired.id, "target_1", requestId)).toMatchObject({
        delivery: "accepted", answer: record?.answer, outcome: record?.outcome,
      });
    } finally {
      release();
      await pending;
      await server.close();
    }
  }
}, 15_000);

test("413 on an answer completes failed invalid_answer immediately", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions.push(body);
    return completions.length === 1
      ? { status: 413, body: { error: { code: "too_large", message: "large" } } }
      : { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  try {
    const outcome = await runClaimedRequest(relay(`${server.origin}/v1`), {
      ...sampleRequest, request_id: "rq_too_large",
    }, undefined, { command: script });
    expect(completions.map((body) => { const completion = body as { outcome: string; reason?: string }; return [completion.outcome, completion.reason]; })).toEqual([
      ["answered", undefined], ["failed", "invalid_answer"],
    ]);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
    expect(readAnswerRecord("relay_1", "target_1", "rq_too_large")).toMatchObject({
      outcome: "failed:invalid_answer", delivery: "accepted",
      answer: { action: "reply", text: "Done", reply_to: null },
    });
  } finally {
    await server.close();
  }
});
for (const engine of ["codex", "claude"] as const)
  test(`${engine} forbidden tool cancels the child and completes profile_violation`, async () => {
    const completions: unknown[] = [];
    const server = await startTestRelay((req, body) => {
      if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
      completions.push(body);
      return { body: { status: "accepted", duplicate: false } };
    });
    const script = stub(engine === "codex"
      ? `await Bun.stdin.text();console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'false'}}));await Bun.sleep(5000);`
      : `await Bun.stdin.text();console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput','Bash'],mcp_servers:[]}));await Bun.sleep(5000);`);
    const start = Date.now();
    try {
      const paired = relay(`${server.origin}/v1`);
      paired.targets[0].engine = engine;
      const outcome = await runClaimedRequest(paired, {
        ...sampleRequest, request_id: `rq_violation_${engine}`,
      }, undefined, { command: script });
      expect(outcome).toMatchObject({ outcome: "failed", reason: "profile_violation" });
      expect(completions).toHaveLength(1);
      expect(Date.now() - start).toBeLessThan(4000);
      expect(readRunLedger().runs).toEqual([]);
      expect(runningCount(paired.id, "target_1")).toBe(0);
    } finally {
      await server.close();
    }
  });
test("hard cap kills the child and completes failed hard_cap", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) return { body: { status: "ok" } };
    completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const script = stub(`await Bun.stdin.text();await Bun.sleep(5000);`);
  try {
    const paired = relay(`${server.origin}/v1`);
    const outcome = await runClaimedRequest(paired, {
      ...sampleRequest, request_id: "rq_hard_cap",
    }, undefined, { command: script, timeoutMs: 300 });
    expect(outcome).toMatchObject({ outcome: "failed", reason: "hard_cap" });
    expect(completions).toHaveLength(1);
    expect(readRunLedger().runs).toEqual([]);
    expect(runningCount(paired.id, "target_1")).toBe(0);
  } finally {
    await server.close();
  }
});


test("relay advertises zero capacity and starts no answer child during drain, then admits after release", async () => {
  const { drainFile, writeDrain, releaseDrain } = await import("@/lib/selfUpdate/drain");
  const marker = path.join(root, "drain-child-marker");
  const command = stub(`const a=process.argv; await Bun.stdin.text(); await Bun.write(${JSON.stringify(marker)}, "launched"); await Bun.write(a[a.indexOf('--output-last-message')+1], JSON.stringify({action:'reply', text:'Done', reply_to:'m1'}));`);
  const completed: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completed.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const paired = relay(`${server.origin}/v1`);
  const request = { ...sampleRequest, request_id: "rq_drain" };
  try {
    writeDrain(drainFile(), { id: "relay-hold", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    const pending = runClaimedRequest(paired, request, undefined, { command });
    await Bun.sleep(100);
    expect(fs.existsSync(marker)).toBe(false); expect(readRunLedger().runs).toEqual([]);
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 0 }]);
    releaseDrain(drainFile(), "relay-hold");
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 1 }]);
    expect(await pending).toMatchObject({ outcome: "answered" });
    expect(fs.readFileSync(marker, "utf8")).toBe("launched");
    expect(completed).toHaveLength(1);
  } finally { releaseDrain(drainFile(), "relay-hold"); await server.close(); }
});

test("an answer admitted before drain completes normally while fresh children stay held", async () => {
  const { drainFile, writeDrain, releaseDrain } = await import("@/lib/selfUpdate/drain");
  const marker = path.join(root, "admitted-child-marker");
  const gate = path.join(root, "admitted-child-release");
  const command = stub(`const a=process.argv; await Bun.stdin.text(); await Bun.write(${JSON.stringify(marker)}, "launched"); while(!require('node:fs').existsSync(${JSON.stringify(gate)})) await Bun.sleep(10); await Bun.write(a[a.indexOf('--output-last-message')+1], JSON.stringify({action:'reply', text:'Done', reply_to:'m1'}));`);
  const server = await startTestRelay(() => ({ body: { status: "accepted", duplicate: false } }));
  const paired = relay(`${server.origin}/v1`);
  const pending = runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_admitted_drain" }, undefined, { command });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await Bun.sleep(10);
    expect(fs.existsSync(marker)).toBe(true);
    writeDrain(drainFile(), { id: "relay-admitted", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    fs.writeFileSync(gate, "release");
    expect(await pending).toMatchObject({ outcome: "answered" });
    expect(readRunLedger().runs).toEqual([]);
  } finally { fs.writeFileSync(gate, "release"); await pending; releaseDrain(drainFile(), "relay-admitted"); await server.close(); }
});

/** A Codex stub that answers with the hand-off action when its schema offers it, and records the schema and prompt it saw. */
function handoffStub(seen: string) {
  return stub(
    `const a=process.argv.slice(2);const prompt=await Bun.stdin.text();const schema=await Bun.file(a[a.indexOf('--output-schema')+1]).text();await Bun.write(${JSON.stringify(seen)},JSON.stringify({schema,prompt}));await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:schema.includes('handoff')?'handoff':'reply',text:'I will mute them',reply_to:'m1'}));`,
  );
}
test("a hand-off completes as declined/handoff with no text, and its exchange is recorded", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } };
  });
  const seen = path.join(root, "handoff-seen.json");
  try {
    const paired = relay(`${server.origin}/v1`);
    const outcome = await runClaimedRequest(paired, { ...contextRequest, request_id: "rq_handoff" }, undefined, { command: handoffStub(seen) });
    const sent = { lease_id: sampleRequest.lease_id, outcome: "declined", reason: "handoff", detail: HANDOFF_DETAIL, retry_after_s: null };
    expect(outcome).toEqual(sent as typeof outcome);
    expect(completions).toEqual([sent]);
    const { schema, prompt } = JSON.parse(fs.readFileSync(seen, "utf8"));
    expect(JSON.parse(schema).properties.action.enum).toEqual(["reply", "ignore", "handoff"]);
    expect(prompt).toContain("<tools>");
    const record = readAnswerRecord(paired.id, "target_1", "rq_handoff");
    expect(record).toMatchObject({
      state: "finished",
      outcome: "declined:handoff",
      answer: { action: "handoff", text: "", reply_to: null },
      delivery: "accepted",
      engine: "codex",
      model: "gpt-6-sol",
      targetName: "Target",
    });
    // The input is kept as received, unknown fields included.
    expect(record?.input).toEqual(contextRequest.input);
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    // Neither the lease nor the credential is written into the record.
    const files = fs.readdirSync(path.join(process.env.LLV_STATE_DIR!, "external-relay/answers", paired.id, "target_1"));
    const text = files.map((name) => fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "external-relay/answers", paired.id, "target_1", name), "utf8")).join("");
    expect(text).not.toContain(sampleRequest.lease_id);
    expect(text).not.toContain(paired.credential);
  } finally {
    await server.close();
  }
});
test("without a tool index the schema and the answer stay as before", async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } };
  });
  const seen = path.join(root, "legacy-seen.json");
  try {
    const paired = relay(`${server.origin}/v1`);
    const outcome = await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_legacy_schema", answer: { max_chars: 100, progress: "none" } }, undefined, { command: handoffStub(seen) });
    expect(outcome).toMatchObject({ outcome: "answered", answer: { action: "reply", text: "I will mute them", reply_to: "m1" } });
    expect(JSON.parse(JSON.parse(fs.readFileSync(seen, "utf8")).schema).properties.action.enum).toEqual(["reply", "ignore"]);
    expect(readAnswerRecord(paired.id, "target_1", "rq_legacy_schema")).toMatchObject({
      outcome: "answered", answer: { action: "reply", text: "I will mute them" }, delivery: "accepted",
    });
  } finally {
    await server.close();
  }
});
test("declines, lost leases and refused completions are recorded too", async () => {
  let completeStatus = 200;
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat"))
      return req.url.includes("rq_rec_lost") && (body as { seq: number }).seq > 1
        ? { status: 409, body: { error: { code: "lease_lost", message: "gone" } } }
        : { body: { status: "ok" } };
    return completeStatus === 200
      ? { body: { status: "accepted", duplicate: false } }
      : { status: completeStatus, body: { error: { code: "lease_lost", message: "gone" } } };
  });
  try {
    const paired = relay(`${server.origin}/v1`);
    paired.paused = true;
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_rec_paused" })).toMatchObject({ reason: "disabled" });
    expect(readAnswerRecord(paired.id, "target_1", "rq_rec_paused")).toMatchObject({ state: "finished", outcome: "declined:disabled", answer: null, delivery: "accepted", engine: null });
    paired.paused = false;
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_rec_lost", liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2 } }, undefined, { command: stub(`await Bun.stdin.text();await Bun.sleep(5000);`) })).toBeNull();
    expect(readAnswerRecord(paired.id, "target_1", "rq_rec_lost")).toMatchObject({ state: "finished", outcome: "lease_lost", delivery: null, engine: "codex" });
    completeStatus = 409;
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_rec_refused", kind: "other" })).toMatchObject({ reason: "unsupported_kind" });
    expect(readAnswerRecord(paired.id, "target_1", "rq_rec_refused")).toMatchObject({ outcome: "declined:unsupported_kind", delivery: "refused" });
    // A request whose ids cannot name a file is answered and not recorded.
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "../escape", target_id: "../x" })).toMatchObject({ reason: "invalid_request" });
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "external-relay/answers", paired.id, "..", "x"))).toBe(false);
    const listed = listAnswerRecords(paired.id, "target_1").map((row) => row.requestId);
    expect(listed.slice(0, 3)).toEqual(["rq_rec_refused", "rq_rec_lost", "rq_rec_paused"]);
  } finally {
    await server.close();
  }
}, 15_000);

test("every relay answer runs with the native web search, and the record says so", async () => {
  const server = await startTestRelay((req) => ({ body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } }));
  const argsFile = path.join(root, "web-search-args.json");
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(${JSON.stringify(argsFile)},JSON.stringify(a));await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  try {
    const paired = relay(`${server.origin}/v1`);
    expect(await runClaimedRequest(paired, { ...sampleRequest, request_id: "rq_web_search" }, undefined, { command: script })).toMatchObject({ outcome: "answered" });
    expect(JSON.parse(fs.readFileSync(argsFile, "utf8"))).toContain("web_search=live");
    expect(readAnswerRecord(paired.id, "target_1", "rq_web_search")).toMatchObject({ profile: { webSearch: true }, admitted: true, requester: null });
  } finally {
    await server.close();
  }
});
test("the member limit declines a member past it, per chat, and never counts the owner or admins", async () => {
  const completions: { reason?: string; detail?: string | null; retry_after_s?: number | null }[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body as never);
    return { body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } };
  });
  const script = stub(
    `const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`,
  );
  const ask = (n: number, requester: Record<string, unknown> | null, chat = "chat_key_aaaaaaaaaaaa", target?: Partial<PairedRelay["targets"][number]>) => {
    const paired = relay(`${server.origin}/v1`);
    paired.targets[0] = { ...paired.targets[0]!, id: "target_limit", memberLimitPerHour: 2, ...target };
    return runClaimedRequest(paired, {
      ...sampleRequest, request_id: `rq_limit_${n}`, target_id: paired.targets[0]!.id, chat: { key: chat },
      input: { ...sampleRequest.input, requester },
    }, undefined, { command: script });
  };
  const member = { key: "u_m", is_admin: false, can_restrict_members: false, can_delete_messages: false, is_owner: false, is_anonymous_admin: false };
  try {
    expect(await ask(1, member)).toMatchObject({ outcome: "answered" });
    expect(await ask(2, member)).toMatchObject({ outcome: "answered" });
    const third = await ask(3, member);
    expect(third).toMatchObject({ outcome: "declined", reason: "member_limit", detail: memberLimitDetail(2) });
    const retry = (third as { retry_after_s: number }).retry_after_s;
    expect(retry).toBeGreaterThan(3500);
    expect(retry).toBeLessThanOrEqual(3600);
    expect(readAnswerRecord("relay_1", "target_limit", "rq_limit_3")).toMatchObject({
      outcome: "declined:member_limit", admitted: false, chatKey: "chat_key_aaaaaaaaaaaa",
      requester: member,
    });
    // Another chat counts on its own; admins and the owner are not counted.
    expect(await ask(4, member, "chat_key_bbbbbbbbbbbb")).toMatchObject({ outcome: "answered" });
    expect(await ask(5, { ...member, is_admin: true })).toMatchObject({ outcome: "answered" });
    expect(await ask(6, { ...member, is_owner: true })).toMatchObject({ outcome: "answered" });
    // Another member is not affected; 0 and null are no limit; no requester block is never counted.
    expect(await ask(7, { ...member, key: "u_other" })).toMatchObject({ outcome: "answered" });
    expect(await ask(8, member, undefined, { memberLimitPerHour: 0 })).toMatchObject({ outcome: "answered" });
    expect(await ask(9, member, undefined, { memberLimitPerHour: null })).toMatchObject({ outcome: "answered" });
    expect(await ask(10, null)).toMatchObject({ outcome: "answered" });
    // A former admin or owner starts their member count with their first member run.
    const roleChangeChat = "chat_key_changedaaaaa";
    expect(await ask(11, { ...member, is_admin: true }, roleChangeChat, { memberLimitPerHour: 1 })).toMatchObject({ outcome: "answered" });
    expect(await ask(12, { ...member, is_owner: true }, roleChangeChat, { memberLimitPerHour: 1 })).toMatchObject({ outcome: "answered" });
    expect(await ask(13, member, roleChangeChat, { memberLimitPerHour: 1 })).toMatchObject({ outcome: "answered" });
    expect(await ask(14, member, roleChangeChat, { memberLimitPerHour: 1 })).toMatchObject({ outcome: "declined", reason: "member_limit" });
    expect(completions.filter((body) => body.reason === "member_limit")).toHaveLength(2);
  } finally {
    await server.close();
  }
}, 60_000);

test("pre-launch capacity and drain declines leave the member's allowance available", async () => {
  const { drainFile, writeDrain, releaseDrain } = await import("@/lib/selfUpdate/drain");
  const server = await startTestRelay(() => ({ body: { status: "accepted", duplicate: false } }));
  const paired = relay(`${server.origin}/v1`);
  paired.id = "relay_admission";
  paired.targets[0]!.memberLimitPerHour = 2;
  const requester = { key: "u_member", is_admin: false, can_restrict_members: false, can_delete_messages: false, is_anonymous_admin: false, is_owner: false };
  const request = (id: string) => ({ ...sampleRequest, request_id: id, chat: { key: "chat_key_admissionaa" }, input: { ...sampleRequest.input, requester } });
  const command = stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  const previous = accountManager.resolveHeadlessSpawn;
  try {
    accountManager.resolveHeadlessSpawn = (() => ({ kind: "exhausted", resetsAt: null })) as typeof previous;
    expect(await runClaimedRequest(paired, request("rq_before_capacity"), undefined, { command })).toMatchObject({ outcome: "declined", reason: "no_capacity" });
    // Acquire the drain after reservation/account selection, exercising the
    // second check immediately before the profile and child are built.
    accountManager.resolveHeadlessSpawn = (() => {
      writeDrain(drainFile(), { id: "admission-hold", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
      return { kind: "available", account };
    }) as typeof previous;
    expect(await runClaimedRequest(paired, { ...request("rq_before_drain"), deadline_at: new Date(Date.now() + 10500).toISOString() }, undefined, { command })).toMatchObject({ outcome: "declined", reason: "busy" });
    releaseDrain(drainFile(), "admission-hold");
    accountManager.resolveHeadlessSpawn = previous;
    for (const id of ["rq_before_capacity", "rq_before_drain"])
      expect(readAnswerRecord(paired.id, "target_1", id)?.admitted).toBe(false);
    for (const id of ["rq_after_capacity", "rq_after_drain"])
      expect(await runClaimedRequest(paired, request(id), undefined, { command })).toMatchObject({ outcome: "answered" });
    expect(await runClaimedRequest(paired, request("rq_after_allowance"), undefined, { command })).toMatchObject({ outcome: "declined", reason: "member_limit" });
  } finally {
    accountManager.resolveHeadlessSpawn = previous;
    releaseDrain(drainFile(), "admission-hold");
    await server.close();
  }
});

test("launched hand-offs, failed agents and running agents each consume the member limit", async () => {
  const server = await startTestRelay(() => ({ body: { status: "accepted", duplicate: false } }));
  const paired = relay(`${server.origin}/v1`);
  paired.id = "relay_count_launched";
  paired.targets[0] = { ...paired.targets[0]!, concurrency: 2, memberLimitPerHour: 1 };
  const requester = { key: "u_member", is_admin: false, can_restrict_members: false, can_delete_messages: false, is_anonymous_admin: false, is_owner: false };
  const request = (id: string, chatKey: string) => ({ ...contextRequest, request_id: id, chat: { key: chatKey }, input: { ...contextRequest.input, requester } });
  const handoff = handoffStub(path.join(root, "admission-handoff"));
  const failure = stub("process.exit(1)");
  const release = path.join(root, "admission-release");
  const running = stub(`const a=process.argv.slice(2);await Bun.stdin.text();while(!await Bun.file(${JSON.stringify(release)}).exists())await Bun.sleep(10);await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  let pending: ReturnType<typeof runClaimedRequest> | undefined;
  try {
    for (const [kind, command, outcome] of [
      ["handoff", handoff, "declined"], ["failed", failure, "failed"],
    ] as const) {
      const chat = `chat_key_${kind}_aaaaa`;
      const id = `rq_launched_${kind}`;
      expect(await runClaimedRequest(paired, request(id, chat), undefined, { command })).toMatchObject({ outcome, reason: kind === "handoff" ? "handoff" : "agent_error" });
      expect(readAnswerRecord(paired.id, "target_1", id)?.admitted).toBe(true);
      expect(await runClaimedRequest(paired, request(`${id}_limited`, chat), undefined, { command })).toMatchObject({ outcome: "declined", reason: "member_limit" });
    }
    const chat = "chat_key_runningaaaa";
    pending = runClaimedRequest(paired, request("rq_launched_running", chat), undefined, { command: running });
    const deadline = Date.now() + 5000;
    while (!readAnswerRecord(paired.id, "target_1", "rq_launched_running")?.admitted && Date.now() < deadline) await Bun.sleep(10);
    expect(readAnswerRecord(paired.id, "target_1", "rq_launched_running")).toMatchObject({ state: "running", admitted: true });
    expect(countMemberAnswers({ relayId: paired.id, targetId: "target_1", chatKey: chat, requesterKey: requester.key, sinceMs: Date.now() - 3600000 }).count).toBe(1);
    expect(await runClaimedRequest(paired, request("rq_running_limited", chat), undefined, { command: running })).toMatchObject({ outcome: "declined", reason: "member_limit" });
  } finally {
    fs.writeFileSync(release, "release");
    await pending;
    await server.close();
  }
}, 30_000);

test("service-built roles answer and the real runner and poller emit cross-check bodies", async () => {
  const { ensureExternalRelayPollers, stopExternalRelayPollers } = await import("./poller");
  const completions: unknown[] = [];
  let claimBody: unknown;
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [{ target_id: "t_target", name: "Target", answered_by: "install", fallback: "service" }] } };
    if (req.url?.endsWith("/claim")) {
      claimBody = body;
      stopExternalRelayPollers();
      return { status: 204 };
    }
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: req.url?.endsWith("/complete") ? { status: "accepted", duplicate: false } : { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`);
  paired.id = "relay_wire";
  paired.targets[0] = { ...paired.targets[0]!, id: "t_target", memberLimitPerHour: null };
  const command = stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  const fixture = (role: string) => serviceClaims.find(({ name }) => name === `claimed_rc_${role}.json`)!.body.request;
  try {
    for (const role of ["member", "admin", "owner", "anonymous_admin"]) {
      const request = { ...fixture(role), request_id: `rq_wire_${role}` };
      expect(await runClaimedRequest(paired, request, undefined, { command })).toMatchObject({ outcome: "answered" });
      expect(readAnswerRecord(paired.id, "t_target", request.request_id)).toMatchObject({
        requester: request.input.requester, input: request.input, admitted: true,
      });
    }
    const member = fixture("member");
    const handoff = await runClaimedRequest(paired, { ...member, request_id: "rq_wire_handoff" }, undefined, { command: handoffStub(path.join(root, "wire-handoff-seen")) });
    expect(handoff).toMatchObject({ outcome: "declined", reason: "handoff", detail: HANDOFF_DETAIL, retry_after_s: null });

    paired.id = "relay_wire_limit";
    paired.targets[0]!.memberLimitPerHour = 1;
    expect(await runClaimedRequest(paired, { ...member, request_id: "rq_wire_first" }, undefined, { command })).toMatchObject({ outcome: "answered" });
    const limited = await runClaimedRequest(paired, { ...member, request_id: "rq_wire_limit" }, undefined, { command });
    expect(limited).toMatchObject({ outcome: "declined", reason: "member_limit", detail: "This member reached 1 answer in the last hour in this chat." });
    expect(limited?.outcome === "declined" && limited.retry_after_s).toBeGreaterThan(3500);
    expect(limited?.outcome === "declined" && [...limited.detail!].length).toBeLessThanOrEqual(200);
    // These fixtures use the same key as the counted member; the role flags exempt them.
    for (const role of ["admin", "owner"])
      expect(await runClaimedRequest(paired, { ...fixture(role), request_id: `rq_wire_exempt_${role}`, input: { ...fixture(role).input, requester: { ...fixture(role).input.requester, key: member.input.requester.key } } }, undefined, { command })).toMatchObject({ outcome: "answered" });

    updateRelayStore((store) => ({ ...store, relays: [paired] }));
    ensureExternalRelayPollers();
    const deadline = Date.now() + 5000;
    while (!claimBody && Date.now() < deadline) await Bun.sleep(10);
    expect(claimBody).toEqual({ wait_s: 25, kinds: ["answer"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "request_deadline"], slots: [{ target_id: "t_target", free: 1 }] });
    const expected = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_completions.json"), "utf8"));
    expect(handoff).toEqual(expected.handoff);
    expect(claimBody).toEqual(JSON.parse(deadlineNegotiatedCapture(JSON.stringify(expected))).claim_body);
    // The absolute retry duration depends on the clock between launches.
    // Check its range above and compare the stable wire fields here.
    expect({ ...limited, retry_after_s: expected.member_limit.retry_after_s }).toEqual(expected.member_limit);
    expect(completions.filter((body) => ["handoff", "member_limit"].includes((body as { reason?: string }).reason ?? "")))
      .toEqual([handoff, limited]);
    if (process.env.LLV_RELAY_WIRE_OUTPUT) {
      fs.mkdirSync(path.dirname(process.env.LLV_RELAY_WIRE_OUTPUT), { recursive: true });
      fs.writeFileSync(process.env.LLV_RELAY_WIRE_OUTPUT, JSON.stringify({
        handoff, member_limit: limited, claim_body: claimBody,
        completions_on_wire: completions.filter((body) => ["handoff", "member_limit"].includes((body as { reason?: string }).reason ?? "")),
      }, null, 2) + "\n");
    }
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
}, 60_000);

// Slice 2a uses the real launchDetached command and relayCall HTTP seams.
function loopStub(plan: string, seen: string) {
  return stub(`import fs from 'node:fs';const a=process.argv.slice(2);const p=await Bun.stdin.text();
const schema=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8'));
const round=Number(p.match(/This is round (\\d+) of 8/)?.[1]??1);
const results=JSON.parse(p.match(/<tool_results>\\n([^]*?)\\n<\\/tool_results>/)?.[1]??'[]');
const final=!schema.properties.calls;
fs.appendFileSync(${JSON.stringify(seen)},JSON.stringify({round,prompt:p,schema,cwd:process.cwd()})+'\\n');
const call=(tool='search_docs',args={query:'meetup'},cursor=null)=>({tool,arguments:JSON.stringify(args),cursor});
const reply={action:'reply',text:'The meetup is Friday.',reply_to:'m_b40b71a0a9d43622ee0e2e6a',...(final?{}:{calls:[]})};
const answer=(()=>{${plan}})();
if(answer!==undefined)await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify(answer));`);
}
const oneCallPlan = `return round===1?{action:'call',text:'',reply_to:null,calls:[call()]}:reply;`;
type WireCall = ReturnType<typeof callBody>;
async function runLoopCase(options: {
  chainConversations?: boolean;
  live?: { engine: "codex" | "claude"; home: string };
  role?: string; request?: ReturnType<typeof x1Request>; plan?: string;
  response?: (body: WireCall, attempt: number) => { status?: number; body?: unknown; drop?: boolean } | Promise<{ status?: number; body?: unknown; drop?: boolean }>;
  completeResponse?: (body: unknown, attempt: number) => { status?: number; body?: unknown };
  runtime?: ToolLoopRuntime & { ownerPorts?: import("./ownerRun").OwnerRunPorts };
  relayId?: string; ownerTier?: boolean;
  reverseReadArrival?: boolean;
  heartbeatResponse?: (seq: number) => { status?: number; body?: unknown };
  features?: string[];
}) {
  setRelaySwitch("chain_conversations", options.chainConversations === true);
  const request = options.request ?? { ...x1Request(options.role ?? "member"), request_id: `loop_${crypto.randomUUID()}` };
  const calls: WireCall[] = [];
  const events: string[] = [];
  const heartbeats: unknown[] = [];
  const completions: unknown[] = [];
  const seen = path.join(root, `loop-seen-${crypto.randomUUID()}`);
  const originalHttpRequest = http.request;
  let releaseFirstSend: (() => void) | undefined;
  let toolPosts = 0;
  if (options.reverseReadArrival) http.request = ((...args: Parameters<typeof http.request>) => {
    const outgoing = originalHttpRequest(...args);
    const requestOptions = args[0] as http.RequestOptions;
    if (requestOptions.path?.endsWith("/tool-calls") && toolPosts++ === 0) {
      const end = outgoing.end;
      outgoing.end = ((...endArgs: Parameters<typeof outgoing.end>) => {
        releaseFirstSend = () => { end.apply(outgoing, endArgs); };
        return outgoing;
      }) as typeof outgoing.end;
    }
    return outgoing;
  }) as typeof http.request;
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      const seq = (body as { seq: number }).seq;
      events.push(`beat:${seq}`);
      heartbeats.push(body);
      if (options.heartbeatResponse) return options.heartbeatResponse(seq);
    }
    if (req.url?.endsWith("/complete")) { completions.push(body); if (options.completeResponse) return options.completeResponse(body, completions.length); }
    if (req.url?.endsWith("/tool-calls")) {
      events.push("call");
      calls.push(body as WireCall);
      if (calls.length === 1) releaseFirstSend?.();
      return options.response ? await options.response(body as WireCall, calls.length) : {
        body: { ...x1Results.ok, call_id: (body as WireCall).call_id, calls_remaining: 16 - new Set(calls.map((call) => call.call_id)).size },
      };
    }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`);
  if (options.features) paired.features = options.features;
  paired.id = options.relayId ?? `loop_${crypto.randomUUID()}`;
  paired.targets[0] = { ...paired.targets[0]!, id: request.target_id, memberLimitPerHour: null, ...(options.ownerTier !== undefined ? { ownerTier: options.ownerTier } : {}) };
  const previousSelection = accountManager.resolveHeadlessSpawn;
  const restoreFeatures = options.live ? setCodexFeatureReaderForTest(undefined) : undefined;
  if (options.live) {
    paired.targets[0] = { ...paired.targets[0]!, engine: options.live.engine,
      model: options.live.engine === "codex" ? "gpt-6-sol" : "haiku", effort: "low", hardCapMinutes: 2 };
    const liveAccount: AccountContext = { engine: options.live.engine, accountId: `synthetic_probe_${options.live.engine}`, kind: "managed",
      home: options.live.home, transcriptRoot: root, env: { ...process.env } };
    accountManager.resolveHeadlessSpawn = (() => ({ kind: "available", account: liveAccount })) as typeof previousSelection;
  }
  try {
    const requestClaims = externalRelayFile("requests");
    fs.rmSync(requestClaims, { force: true });
    fs.rmSync(`${requestClaims}.lock`, { force: true });
    const completion = await runClaimedRequest(paired, request, undefined, { ...(options.live ? {} : { command: loopStub(options.plan ?? oneCallPlan, seen) }),
      sleep: async () => {}, ...options.runtime });
    const rounds = fs.existsSync(seen) ? fs.readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    expect(events.indexOf("beat:1")).toBeLessThan(events.indexOf("call") === -1 ? Infinity : events.indexOf("call"));
    expect(readRunLedger().runs).toEqual([]);
    return { completion, calls, events, heartbeats, rounds, completions, paired, request,
      record: readAnswerRecord(paired.id, request.target_id, request.request_id) };
  } finally { http.request = originalHttpRequest; restoreFeatures?.(); accountManager.resolveHeadlessSpawn = previousSelection; await server.close(); }
}

for (const role of ["member", "admin", "owner", "anonymous_admin", "admin_owner_member", "actions_admin"])
  test(`X1 ${role} claim completes through the read loop`, async () => {
    const run = await runLoopCase({ role });
    expect(run.completion).toMatchObject({ outcome: "answered" });
    expect(run.calls).toHaveLength(1);
    expect(run.rounds).toHaveLength(2);
    expect(run.record).toMatchObject({ rounds: 2, toolCalls: [{ round: 1, tool: "search_docs", status: "ok", local: false }] });
    const stored = JSON.stringify(run.record);
    for (const secret of [run.calls[0]!.call_id, run.request.lease_id, run.paired.credential, x1Results.ok!.output]) expect(stored).not.toContain(secret);
    expect(run.record!.toolCalls![0]).not.toHaveProperty("arguments");
  });

for (const [name, sample] of Object.entries(x1Results))
  test(`X1 result ${name} crosses the runner projection`, async () => {
    // Even an unexpected action result must end calling safely; no action is sent.
    const run = await runLoopCase({
      response: (body, attempt) => ({ body: { ...(sample.status === "pending" && attempt > 1 ? x1Results.ok : sample), tool: "search_docs", call_id: body.call_id } }),
    });
    expect(run.completion).toMatchObject({ outcome: "answered" });
    const prompt = run.rounds[1].prompt as string;
    const projected = JSON.parse(prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)![1]!)[0];
    if (sample.audience) {
      expect(projected).toMatchObject({ status: "denied", code: "not_permitted", output: "" });
      expect(run.record!.toolCalls![0]!.withheld).toBe(true);
      expect(run.calls).toHaveLength(1);
    } else if (sample.status === "pending") {
      expect(run.calls).toHaveLength(2);
      expect(run.calls[1]).toEqual(run.calls[0]);
      expect(projected.output).toBe(x1Results.ok!.output);
    } else {
      expect(projected.status).toBe(sample.status);
      expect(projected.output).toBe(sample.output);
      if (sample.code) expect(projected.code).toBe(sample.code);
      expect(run.calls).toHaveLength(name === "unavailable" ? 3 : 1);
    }
    if (sample.delivered || sample.status === "outcome_unknown" || sample.code === "too_many_calls")
      expect(run.rounds[1].schema).toEqual(handoffAnswerSchema);
  });

for (const [name, envelope] of Object.entries(x1Errors).filter(([name]) => name !== "handoff_after_action"))
  test(`X1 transport ${name} uses the production HTTP path`, async () => {
    const waits: number[] = [];
    const run = await runLoopCase({ response: () => envelope, runtime: { sleep: async (ms) => { waits.push(ms); } } });
    if (["lease_lost", "not_found"].includes(name)) {
      expect(run.completion).toBeNull();
      expect(run.completions).toEqual([]);
      expect(run.record?.outcome).toBe("lease_lost");
    } else {
      expect(run.completion).toMatchObject({ outcome: "answered" });
      expect(run.rounds[1].prompt).toContain(`"code":"${name}"`);
      if (["unauthorized", "unsupported_version"].includes(name)) expect(run.rounds[1].schema).toEqual(handoffAnswerSchema);
      if (name === "rate_limited") expect(waits).toEqual([60000, 60000, 60000]);
    }
  });

for (const rejection of ["unauthorized", "unsupported_version"])
  test(`${rejection} cancels a sibling poll wait and completes one normal final round`, async () => {
    let waiting!: () => void;
    const siblingWaiting = new Promise<void>((resolve) => { waiting = resolve; });
    const run = await runLoopCase({
      plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('search_docs',{query:'reject'}),call('search_docs',{query:'sibling'})]}:reply;`,
      response: async (body) => {
        if ("arguments" in body && body.arguments?.query === "reject") {
          await siblingWaiting;
          return x1Errors[rejection]!;
        }
        return { body: { ...x1Results.pending, tool: "search_docs", call_id: body.call_id, retry_after_s: 60 } };
      },
      runtime: { sleep: async (ms, signal) => { waiting(); await toolSleep(ms, signal); } },
    });
    expect(run.calls).toHaveLength(2);
    expect(run.completions).toHaveLength(1);
    expect(run.completion).toMatchObject({ outcome: "answered" });
    expect(run.rounds).toHaveLength(2);
    expect(run.rounds[1].schema).toEqual(handoffAnswerSchema);
    expect(run.record?.outcome).toBe("answered");
    expect(run.record?.toolCalls?.map((call) => call.code)).toEqual([rejection, rejection]);
  });

test("exhausting the call budget still polls an already admitted read", async () => {
  const run = await runLoopCase({ response: (body, attempt) => ({ body: {
    ...(attempt === 1 ? x1Results.pending : x1Results.ok), tool: "search_docs", call_id: body.call_id, calls_remaining: 0,
  } }) });
  expect(run.calls).toHaveLength(2);
  expect(run.calls[0]).toEqual(run.calls[1]);
  expect(run.completions).toHaveLength(1);
  expect(run.completion).toMatchObject({ outcome: "answered" });
  expect(run.rounds[1].schema).toEqual(handoffAnswerSchema);
  expect(run.rounds[1].prompt).toContain(x1Results.ok!.output.replaceAll('"', '\\"'));
});

test("six requested calls send four, invalid arguments and forbidden tools stay local", async () => {
  const run = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:Array.from({length:6},(_,i)=>call('search_docs',{query:String(i)}))}:reply;` });
  expect(run.calls).toHaveLength(4);
  expect(run.record!.toolCalls!.slice(4).map((item) => item.code)).toEqual(["too_many_calls", "too_many_calls"]);
  const local = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('missing'),{tool:'search_docs',arguments:'[]',cursor:null},call('search_docs',{},'invented'),call('search_docs',{query:'x'.repeat(65536)})]}:reply;` });
  expect(local.calls).toHaveLength(0);
  expect(local.record!.toolCalls!.map((item) => item.code)).toEqual(["not_permitted", "invalid_arguments", "invalid_arguments", "invalid_arguments"]);
});
test("sixteen calls force a final schema, and sparse calls force round eight", async () => {
  for (const n of [1, 4]) {
    const run = await runLoopCase({ plan: `return final?reply:{action:'call',text:'',reply_to:null,calls:Array.from({length:${n}},(_,i)=>call('search_docs',{query:round+'-'+i}))};` });
    expect(run.calls).toHaveLength(n === 4 ? 16 : 7);
    expect(run.rounds).toHaveLength(n === 4 ? 5 : 8);
    expect(run.rounds.at(-1).schema).toEqual(handoffAnswerSchema);
  }
});
test("repeat calls use the local result, empty calls force the next round final", async () => {
  const run = await runLoopCase({ plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call()]}:reply;` });
  expect(run.calls).toHaveLength(1);
  const empty = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[]}:reply;` });
  expect(empty.calls).toHaveLength(0);
  expect(empty.rounds[1].schema).toEqual(handoffAnswerSchema);
});
test("a pending read stops at 330 seconds through the wait seam", async () => {
  let clock = 0;
  const run = await runLoopCase({ response: (body) => ({ body: { ...x1Results.pending, tool: "search_docs", call_id: body.call_id } }),
    runtime: { now: () => clock, sleep: async (ms) => { clock += ms; } } });
  expect(clock).toBe(330000);
  expect(run.rounds[1].prompt).toContain("The read did not finish.");
});
test("only 64 KiB of distinct outputs reaches subsequent prompts", async () => {
  const run = await runLoopCase({
    plan: `return final?reply:{action:'call',text:'',reply_to:null,calls:Array.from({length:4},(_,i)=>call('search_docs',{query:round+'-'+i}))};`,
    response: (body) => ({ body: { ...x1Results.ok, call_id: body.call_id, output: "😀".repeat(16000), calls_remaining: 16 } }),
  });
  const prompt = run.rounds.at(-1).prompt as string;
  const results = JSON.parse(prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)![1]!);
  expect(results.reduce((bytes: number, result: { output: string }) => bytes + Buffer.byteLength(result.output), 0)).toBeLessThanOrEqual(65536);
  expect(results.some((result: { code?: string }) => result.code === "quota_exhausted")).toBe(true);
});
test("a later Codex round cannot reuse a previous answer file", async () => {
  const run = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call()]}:undefined;` });
  expect(run.completion).toMatchObject({ outcome: "failed", reason: "agent_error" });
  expect(run.rounds[0].cwd).not.toBe(run.rounds[1].cwd);
});

test("C4 X2 marks only the stored outcome of an admitted call as replayed", () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json"), "utf8"));
  const [media, docs, page] = evidence.calls;
  expect(media.attempts[0].request).toEqual(media.attempts[1].request);
  expect(media.attempts[0].response).toMatchObject({ status: "pending", replayed: false });
  expect(media.attempts[1].response).toMatchObject({ status: "ok", replayed: true });
  expect(docs.attempts[0].response.replayed).toBe(false);
  expect(page.attempts[0].response.replayed).toBe(false);
});

for (const reverseArrival of [false, true])
test(`X2 is generated by the real poller and runner with X1 pending and pages (${reverseArrival ? "reversed" : "normal"} arrivals)`, async () => {
  setRelaySwitch("chain_conversations", false);
  const { ensureExternalRelayPollers, stopExternalRelayPollers } = await import("./poller");
  const request = x1Request("member");
  const plannedCalls = [
    { round: 1, body: callBody(request, { tool: "get_media", arguments: { message_id: "m_b40b71a0a9d43622ee0e2e6a" } }) },
    { round: 1, body: callBody(request, { tool: "search_docs", arguments: { query: "meetup" } }) },
    { round: 2, body: callBody(request, { cursor: x1Results.cursor_page!.cursor! }) },
  ];
  // Allocate fixture slots and admission snapshots in round/model-item order.
  const calls: { round: number; attempts: { request: WireCall; x1_sample: string; response: ToolCallResult }[] }[] =
    plannedCalls.map(({ round }) => ({ round, attempts: [] }));
  const seenIds = new Set<string>();
  let admitRoundOne!: () => void;
  const roundOneAdmitted = new Promise<void>((resolve) => { admitRoundOne = resolve; });
  let claimBody: unknown;
  let heartbeat = false;
  const arrivals: string[] = [];
  const originalHttpRequest = http.request;
  let releaseFirstSend: (() => void) | undefined;
  let toolPosts = 0;
  if (reverseArrival) http.request = ((...args: Parameters<typeof http.request>) => {
    const outgoing = originalHttpRequest(...args);
    const options = args[0] as http.RequestOptions;
    if (options.path?.endsWith("/tool-calls") && toolPosts++ === 0) {
      const end = outgoing.end;
      outgoing.end = ((...endArgs: Parameters<typeof outgoing.end>) => {
        releaseFirstSend = () => { end.apply(outgoing, endArgs); };
        return outgoing;
      }) as typeof outgoing.end;
    }
    return outgoing;
  }) as typeof http.request;
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [{ target_id: request.target_id, name: "Target", answered_by: "install", fallback: "service" }] } };
    if (req.url?.endsWith("/claim")) { claimBody = body; stopExternalRelayPollers(); return { status: 204 }; }
    if (req.url?.endsWith("/heartbeat")) heartbeat = true;
    if (req.url?.endsWith("/tool-calls")) {
      expect(heartbeat).toBe(true);
      const call = body as WireCall;
      arrivals.push("cursor" in call ? "page" : call.tool);
      if ("tool" in call && call.tool === "search_docs") releaseFirstSend?.();
      const first = !seenIds.has(call.call_id);
      seenIds.add(call.call_id);
      const index = plannedCalls.findIndex((planned) => planned.body.call_id === call.call_id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(call).toEqual(plannedCalls[index]!.body);
      // Both concurrent reads are admitted before either can start polling.
      if (seenIds.size >= 2) admitRoundOne();
      await roundOneAdmitted;
      const sample = "cursor" in call ? "last_page" : call.tool === "search_docs" ? "ok" : first ? "pending" : "cursor_page";
      const response = { ...x1Results[sample]!, call_id: call.call_id, calls_remaining: first ? 15 - index : 14,
        replayed: !first };
      const entry = calls[index]!;
      entry.attempts.push({ request: call, x1_sample: sample, response });
      return { body: response };
    }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`);
  paired.id = "relay_x2";
  paired.targets[0] = { ...paired.targets[0]!, id: request.target_id, memberLimitPerHour: null };
  try {
    updateRelayStore((store) => ({ ...store, relays: [paired] }));
    ensureExternalRelayPollers();
    const deadline = Date.now() + 5000;
    while (!claimBody && Date.now() < deadline) await Bun.sleep(10);
    expect(claimBody).toEqual({ wait_s: 25, kinds: ["answer"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "request_deadline"], slots: [{ target_id: request.target_id, free: 1 }] });
    const completion = await runClaimedRequest(paired, request, undefined, { sleep: async () => {}, command: loopStub(
      `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('get_media',{message_id:'m_b40b71a0a9d43622ee0e2e6a'}),call()]};
       if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('get_media',{},results.find(r=>r.next_cursor).next_cursor)]};return reply;`,
      path.join(root, "x2-seen")) });
    expect(completion?.outcome).toBe("answered");
    if (reverseArrival) expect(arrivals.slice(0, 2)).toEqual(["search_docs", "get_media"]);
    if (completion?.outcome !== "answered") throw new Error("X2 did not answer");
    expect(completion.duration_ms).toBeGreaterThanOrEqual(0);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const x2Rounds = fs.readFileSync(path.join(root, "x2-seen"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const hashes = { prompts: x2Rounds.slice(-3).map((r) => hash(r.prompt)), schemas: x2Rounds.slice(-3).map((r) => hash(JSON.stringify(r.schema))),
      calls: calls.flatMap((entry) => entry.attempts.map((attempt) => hash(JSON.stringify(attempt.request)))) };
    const hashFile = path.join(x1Dir, "actions-off-x2-2a-hashes.json");

    const output = JSON.stringify({ x1: { revision: "a0d9245bcac2c2246f29f180f8bd21aa825d478c", claim: "claimed_tools_member.json",
      claim_sha256: createHash("sha256").update(fs.readFileSync(path.join(x1Dir, "claimed_tools_member.json"))).digest("hex") },
      claim_body: claimBody, calls, completion: { ...completion, duration_ms: 0 },
      ...(JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json"), "utf8")).actions ? { actions: JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json"), "utf8")).actions } : {}) }, null, 2) + "\n";
    const readWire = JSON.parse(output);
    delete readWire.actions;
    readWire.claim_body.features = readWire.claim_body.features.filter((feature: string) => feature !== "relay_tool_actions" && feature !== "request_deadline");
    expect({ ...hashes, wire: hash(JSON.stringify(readWire, null, 2) + "\n") })
      .toEqual(JSON.parse(fs.readFileSync(hashFile, "utf8")));
    if (process.env.LLV_RELAY_WIRE_OUTPUT_TOOL_LOOP) fs.writeFileSync(process.env.LLV_RELAY_WIRE_OUTPUT_TOOL_LOOP, output);
    expect(output).toBe(deadlineNegotiatedCapture(fs.readFileSync(path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json"), "utf8")));
    expect(calls[0]!.attempts[0]!.request).toEqual(calls[0]!.attempts[1]!.request);
    expect(calls[2]!.attempts[0]!.request).toEqual({ lease_id: request.lease_id, call_id: calls[2]!.attempts[0]!.request.call_id, cursor: x1Results.cursor_page!.cursor! });
  } finally { http.request = originalHttpRequest; stopExternalRelayPollers(); await server.close(); }
}, 30_000);

test("C6 re-claim sends the stored call identity under a new lease and counts the member once", async () => {
  const request = { ...x1Request("member"), request_id: "rq_reclaim_read" };
  const relayId = "relay_reclaim_read";
  let first: WireCall | undefined;
  let executions = 0;
  const lost = await runLoopCase({ request, relayId, response: (body) => {
    first = body; executions++; return x1Errors.lease_lost!;
  } });
  expect(lost.completion).toBeNull();
  const reclaimed = await runLoopCase({ request: { ...request, lease_id: "b".repeat(64) }, relayId,
    response: (body) => {
      expect(body.call_id).toBe(first!.call_id);
      if (body.call_id !== first!.call_id) executions++;
      return { body: { ...x1Results.ok, call_id: body.call_id, replayed: true } };
    } });
  expect(reclaimed.completion).toMatchObject({ outcome: "answered" });
  expect(executions).toBe(1);
  expect(countMemberAnswers({ relayId, targetId: request.target_id, chatKey: request.chat!.key,
    requesterKey: request.input.requester!.key, sinceMs: Date.now() - 3600000 }).count).toBe(1);
});

test("heartbeats span the pending phase between child rounds", async () => {
  const request = { ...x1Request("member"), request_id: "rq_pending_beats",
    liveness: { ...x1Request("member").liveness, heartbeat_interval_s: 2 } };
  const run = await runLoopCase({ request, response: (body, attempt) => ({ body: {
    ...(attempt === 1 ? x1Results.pending : x1Results.ok), tool: "search_docs", call_id: body.call_id,
  } }), runtime: { sleep: async (ms) => { await Bun.sleep(ms); } } });
  expect(run.events.indexOf("beat:2")).toBeGreaterThan(run.events.indexOf("call"));
  expect(run.events).toContain("beat:3");
  expect(run.calls[0]).toEqual(run.calls[1]);
}, 20_000);

test("a stalled lease aborts a call phase and sends no completion", async () => {
  const request = { ...x1Request("member"), request_id: "rq_stalled_call",
    liveness: { ...x1Request("member").liveness, heartbeat_interval_s: 2, stall_window_s: 10 } };
  const run = await runLoopCase({ request, response: async (body) => {
    await Bun.sleep(12000); return { body: { ...x1Results.ok, call_id: body.call_id } };
  }, heartbeatResponse: (seq) => seq === 1 ? { body: { status: "ok" } } : { status: 503 } });
  expect(run.completion).toBeNull();
  expect(run.completions).toEqual([]);
  expect(run.record!.outcome).toBe("lease_lost");
}, 25_000);

for (const role of ["admin", "owner", "anonymous_admin"])
  test(`audience projection for ${role} permits only its own flags`, async () => {
    for (const audience of ["admin", "owner"] as const) {
      const sample = x1Results[audience]!;
      const run = await runLoopCase({ role, response: (body) => ({ body: { ...sample, tool: "search_docs", call_id: body.call_id } }) });
      const allowed = audience === "admin" || role === "owner";
      expect(run.record!.toolCalls![0]!.withheld).toBe(!allowed);
      const result = JSON.parse(run.rounds[1].prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)[1])[0];
      expect(result.output).toBe(allowed ? sample.output : "");
    }
  });

test("slice 1 requests launch with unchanged prompt/schema, no calls and no loop record fields", async () => {
  setRelaySwitch("chain_conversations", false);
  const { answerPrompt } = await import("./prompt");
  const { answerSchema } = await import("./protocol");
  for (const fixture of serviceClaims) {
    const request = requestSchema.parse(fixture.body.request);
    const run = await runLoopCase({ request, plan: "return reply;" });
    expect(run.rounds[0].prompt).toBe(answerPrompt(request));
    expect(run.rounds[0].schema).toEqual(request.input.tools?.length ? handoffAnswerSchema : answerSchema);
    expect(run.calls).toEqual([]);
    expect(run.record).not.toHaveProperty("rounds");
    expect(run.record).not.toHaveProperty("toolCalls");
  }
  const readRequest = x1Request("member");
  const request = { ...readRequest, request_id: "rq_handoff_only", input: { ...readRequest.input, tool_guidance: null,
    tools: readRequest.input.tools!.map((tool) => ({ name: tool.name, summary: tool.summary, mode: "handoff" as const })) } };
  const run = await runLoopCase({ request, plan: "return reply;" });
  expect(run.calls).toEqual([]);
  expect(run.rounds[0].prompt).toBe(answerPrompt(request));
  expect(run.record).not.toHaveProperty("rounds");
});

test("concurrent reads settle in model order with at most four in flight", async () => {
  let active = 0;
  let maximum = 0;
  const run = await runLoopCase({ plan: `return round===1?{action:'call',text:'',reply_to:null,calls:Array.from({length:4},(_,i)=>call('search_docs',{query:String(i)}))}:reply;`,
    response: async (body) => {
      active++; maximum = Math.max(maximum, active);
      const query = "arguments" in body ? body.arguments!.query as string : "";
      await Bun.sleep((4 - Number(query)) * 20); active--;
      return { body: { ...x1Results.ok, call_id: body.call_id, output: query, calls_remaining: 12 } };
    } });
  expect(maximum).toBe(4);
  const results = JSON.parse(run.rounds[1].prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)[1]);
  expect(results.map((item: { output: string }) => item.output)).toEqual(["0", "1", "2", "3"]);
});

test("transport and invalid-result retries keep identical bodies", async () => {
  for (const kind of ["5xx", "bad_result", "oversize_response"]) {
    const waits: number[] = [];
    const run = await runLoopCase({ response: (body, attempt) => {
      if (attempt < 4) {
        if (kind === "5xx") return { status: 503 };
        if (kind === "oversize_response") return { body: { ...x1Results.ok, output: "x".repeat(65537), call_id: body.call_id } };
        return { body: { ...x1Results.ok, status: "unexpected", call_id: body.call_id } };
      }
      return { body: { ...x1Results.ok, call_id: body.call_id } };
    }, runtime: { sleep: async (ms) => { waits.push(ms); } } });
    expect(run.calls).toHaveLength(4);
    expect(run.calls.every((body) => JSON.stringify(body) === JSON.stringify(run.calls[0]))).toBe(true);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(run.completion).toMatchObject({ outcome: "answered" });
  }
});

test("a historical replay cannot restore the fresh remaining-call budget", async () => {
  const run = await runLoopCase({ plan: `if(final)return reply;return round<=2?{action:'call',text:'',reply_to:null,calls:[call('search_docs',{query:String(round)})]}:reply;`,
    response: (body, attempt) => ({ body: { ...x1Results.ok, call_id: body.call_id, calls_remaining: attempt === 1 ? 2 : 15, replayed: attempt === 2 } }) });
  expect(run.rounds[2].prompt).toContain("2 calls are left.");
});

// Captured on the slice 2a head before changing the loop; only deterministic wire surfaces.
test("actions OFF preserves every 2a round, schema and call byte", async () => {
  const hashes: Record<string, unknown> = {};
  for (const role of ["member", "admin", "owner", "anonymous_admin", "admin_owner_member", "actions_off"]) {
    const request = x1Request(role === "actions_off" ? "actions_admin" : role);
    if (role === "actions_off") request.input.tools = request.input.tools!.map((tool) => tool.effect === "action"
      ? { name: tool.name, summary: tool.summary, mode: "handoff" as const } : tool);
    const run = await runLoopCase({ request });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    hashes[role] = { prompts: run.rounds.map((r) => hash(r.prompt)), schemas: run.rounds.map((r) => hash(JSON.stringify(r.schema))),
      calls: run.calls.map((call) => hash(JSON.stringify(call))) };
    expect(run.record!.toolCalls!.every((row) => !("effect" in row))).toBe(true);
  }
  const file = path.join(x1Dir, "actions-off-2a-hashes.json");
  if (process.env.LLV_RELAY_CAPTURE_2A) fs.writeFileSync(file, JSON.stringify(hashes, null, 2) + "\n");
  expect(hashes).toEqual(JSON.parse(fs.readFileSync(file, "utf8")));
});

const actionPlan = (tool: string, final = "reply") =>
  `return round===1?{action:'call',text:'',reply_to:null,calls:[call('${tool}',{})]}:${final};`;
const projectionsOf = (run: Awaited<ReturnType<typeof runLoopCase>>, round = 1) =>
  JSON.parse(run.rounds[round].prompt.match(/<tool_results>\n([^]*?)\n<\/tool_results>/)[1]);

test("N1 owner switch OFF preserves v3 runner bytes with additive deadline negotiation", async () => {
  const hashes: Record<string, unknown> = {};
  setRelaySwitch("relay:owner_tools:enabled", false);
  for (const role of ["member", "admin", "owner", "anonymous_admin", "admin_owner_member", "actions_admin"]) {
    const run = await runLoopCase({ request: x1Request(role) });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    hashes[role] = { prompts: run.rounds.map((r) => hash(r.prompt)), schemas: run.rounds.map((r) => hash(JSON.stringify(r.schema))),
      calls: run.calls.map((call) => hash(JSON.stringify(call))) };
  }
  hashes.claim = JSON.stringify(relayClaimCapabilities({ features: ["relay_owner_tools"] }));
  const output = JSON.stringify(hashes, null, 2) + "\n";
  if (process.env.LLV_RELAY_CAPTURE_OWNER_N1) fs.writeFileSync(process.env.LLV_RELAY_CAPTURE_OWNER_N1, output);
  else {
    const expected = JSON.parse(fs.readFileSync(path.join(x1Dir, "owner-tools-off-runner-hashes.json"), "utf8"));
    const claim = JSON.parse(expected.claim);
    claim.features.push("request_deadline");
    expected.claim = JSON.stringify(claim);
    expect(output).toBe(JSON.stringify(expected, null, 2) + "\n");
  }
});

const ownerFeatures = ["requester_context", "relay_tool_calls", "relay_tool_actions", "relay_owner_tools"];
const ownerRateLimit = (seconds = 7) => ({ status: 429,
  body: { error: { code: "rate_limited", message: "rate limited", retry_after_s: seconds } } });
const ownerResponse = (body: WireCall, overrides: Partial<ToolCallResult> = {}) => ({ body: {
  call_id: body.call_id, tool: "tool" in body ? body.tool : "owner_list_grid_chats", status: "ok", output: "[]",
  truncated: false, effect: "tool" in body && ["owner_list_grids", "owner_list_grid_chats"].includes(body.tool!) ? "read" : "action",
  delivered: false, replayed: false, calls_remaining: 15, audience: "owner", ...overrides,
} });

test("both owner switches preserve non-owner relay runs and reject offered owner tools", async () => {
  setRelaySwitch("relay:owner_tools:enabled", true);
  let launches = 0;
  const runtime = { ownerPorts: {
    launch: async () => { launches++; throw Error("non-owner must not launch"); },
    observe: async () => ({ state: "running" as const }), stop: async () => {},
  } };
  try {
    for (const role of ["member", "admin", "anonymous_admin"]) {
      const request = ownerRequest(`both_switches_${role}`);
      const input = x1Request(role).input;
      request.input.requester = input.requester;
      request.input.conversation = input.conversation;
      const options = { request, features: ownerFeatures, runtime,
        plan: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('owner_create_grid',{body:{name:'Grid A'}})]};return {action:'reply',text:'Done',reply_to:null,calls:[]};` };
      const off = await runLoopCase({ ...options, ownerTier: false });
      const on = await runLoopCase({ ...options, ownerTier: true });
      expect(on.completion).toMatchObject({ outcome: "answered" });
      expect({ ...on.completion, duration_ms: 0 }).toEqual({ ...off.completion, duration_ms: 0 });
      const surfaces = (run: typeof on) => run.rounds.map(({ prompt, schema }) => ({ prompt, schema }));
      expect(surfaces(on)).toEqual(surfaces(off));
      expect(on.calls).toEqual([]);
      expect(on.record!.profile).not.toHaveProperty("owner");
      expect(on.rounds[0].schema.properties.calls.items.properties.tool.enum).not.toContain("owner_create_grid");
      expect(projectionsOf(on)[0]).toMatchObject({ status: "denied", code: "not_permitted" });
    }
    expect(launches).toBe(0);
  } finally { setRelaySwitch("relay:owner_tools:enabled", false); }
});

test("E3 owner pure 429 ceiling refunds its debit and permits completion with handoff", async () => {
  setRelaySwitch("relay:owner_tools:enabled", true);
  try {
    const run = await runLoopCase({ request: ownerRequest("owner_refund_regression"), features: ownerFeatures,
      plan: `if(round<=2)return {action:'call',text:'',reply_to:null,calls:[call('owner_create_grid',{body:{name:'Grid A'}})]};return {action:'handoff',text:'',reply_to:null,calls:[]};`,
      response: () => ownerRateLimit(), runtime: { sleep: async () => {} } });
    expect(run.completion).toMatchObject({ outcome: "declined", reason: "handoff" });
    expect(run.calls).toHaveLength(4); expect(run.rounds[1].prompt.includes("16 calls are left.")).toBe(true);
  } finally { setRelaySwitch("relay:owner_tools:enabled", false); }
});

for (const refusal of ["malformed", "too_large"]) test(`E3 owner ${refusal} refusal followed by a pure 429 ceiling permits handoff`, async () => {
  setRelaySwitch("relay:owner_tools:enabled", true);
  try {
    const run = await runLoopCase({ request: ownerRequest(`owner_refusal_${refusal}`), features: ownerFeatures,
      plan: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('owner_create_grid',{body:{name:'Grid A'}})]};
        if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('owner_attach_grid_chats',{grid_id:'00000000-0000-0000-0000-000000000000',body:{}})]};
        return {action:'handoff',text:'',reply_to:null,calls:[]};`,
      response: (_body, attempt) => attempt === 1 ? x1Errors[refusal]! : ownerRateLimit(), runtime: { sleep: async () => {} } });
    expect(run.completion).toMatchObject({ outcome: "declined", reason: "handoff" });
    expect(run.calls).toHaveLength(5); expect(run.rounds).toHaveLength(3);
    expect(new Set(run.calls.slice(1).map((call) => JSON.stringify(call))).size).toBe(1);
    expect(run.rounds[2].prompt).toContain("15 calls are left.");
    expect(run.rounds[2].schema.properties.action.enum).toContain("handoff");
  } finally { setRelaySwitch("relay:owner_tools:enabled", false); }
});

for (const status of ["ok", "error"] as const) test(`E3 owner admitted ${status} followed by a pure 429 ceiling keeps handoff blocked`, async () => {
  setRelaySwitch("relay:owner_tools:enabled", true);
  try {
    const run = await runLoopCase({ request: ownerRequest(`owner_admitted_${status}`), features: ownerFeatures,
      plan: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('owner_create_grid',{body:{name:'Grid A'}})]};
        if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('owner_attach_grid_chats',{grid_id:'00000000-0000-0000-0000-000000000000',body:{}})]};
        return {action:'handoff',text:'',reply_to:null,calls:[]};`,
      response: (body, attempt) => attempt === 1 ? ownerResponse(body, { status }) : ownerRateLimit(), runtime: { sleep: async () => {} } });
    expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
    expect(run.calls).toHaveLength(5); expect(run.rounds[2].prompt).toContain("15 calls are left.");
    expect(run.rounds[2].schema.properties.action.enum).not.toContain("handoff");
  } finally { setRelaySwitch("relay:owner_tools:enabled", false); }
});

test("X4 six owner runs extend the existing X2 capture format", async () => {
  const capture: { name: string; x1: unknown; calls: unknown[]; completion: unknown }[] = [];
  const grid = "00000000-0000-0000-0000-000000000000";
  const page = "public-next-page";
  const plans: Record<string, string> = {
    reads: `if(round===1||round===3)return {action:'call',text:'',reply_to:null,calls:[call('owner_list_grid_chats',{grid_id:'${grid}',cursor:'public-query-cursor',limit:2})]};
      if(round===2){const page=JSON.parse(results.at(-1).output);return {action:'call',text:'',reply_to:null,calls:[call('owner_list_grid_chats',{grid_id:'${grid}',cursor:page.next_cursor,limit:2})]};}return reply;`,
    writes: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('owner_create_grid',{body:{name:'Grid A'}}),call('owner_list_grids',{})]};
      if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('owner_create_grid',{body:{name:'Grid B'}})]};
      if(round===3)return {action:'call',text:'',reply_to:null,calls:[call('owner_attach_grid_chats',{grid_id:'${grid}',body:{owned:[101]}})]};
      if(round===4)return {action:'call',text:'',reply_to:null,calls:[call('owner_activate_clone',{bot_id:42})]};return reply;`,
    retry_ceiling: `if(round<=2)return {action:'call',text:'',reply_to:null,calls:[call('owner_create_grid',{body:{name:'Grid A'}})]};return {action:'handoff',text:'',reply_to:null,calls:[]};`,
    inner_404: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('owner_get_grid',{grid_id:'${grid}'})]};
      if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('owner_list_grids',{})]};return reply;`,
    lease_lost: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('owner_list_grids',{})]}:reply;`,
    confirmation: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('owner_deactivate_clone',{bot_id:42})]}:reply;`,
  };
  setRelaySwitch("relay:owner_tools:enabled", true);
  try {
    for (const [name, plan] of Object.entries(plans)) {
      const calls: { body: WireCall; attempts: { request: WireCall; x1_sample: string; response?: unknown; status?: number; body?: unknown }[] }[] = [];
      const admitted = new Set<string>();
      const waits: number[] = [];
      const run = await runLoopCase({ request: ownerRequest(`owner_x4_${name}`), plan, features: ownerFeatures,
        runtime: { now: () => Date.parse("2026-10-10T00:00:00Z"), sleep: async (ms) => { waits.push(ms); } },
        response: (body) => {
          let entry = calls.find((call) => call.body.call_id === body.call_id);
          if (!entry) { entry = { body, attempts: [] }; calls.push(entry); }
          const attempt = entry.attempts.length + 1;
          const tool = "tool" in body ? body.tool : "owner_list_grid_chats";
          const refused = name === "retry_ceiling" || name === "writes" && tool === "owner_activate_clone" && attempt === 1;
          if (refused || name === "lease_lost") {
            const response = name === "lease_lost" ? x1Errors.lease_lost! : ownerRateLimit();
            entry.attempts.push({ request: body, x1_sample: refused ? "owner_rate_limited" : "lease_lost", ...response });
            return response;
          }
          const replayed = admitted.has(body.call_id);
          admitted.add(body.call_id);
          let result: Partial<ToolCallResult> = { tool, calls_remaining: 16 - admitted.size, replayed };
          let sample = "owner_ok";
          if (name === "reads") {
            const last = "arguments" in body && body.arguments?.cursor === page;
            const item = { chat_id: last ? 102 : 101, name: last ? "Chat B" : "Chat A", username: null,
              avatar_url: null, total_participants: 2, synced_section_count: 0 };
            result = { ...result, effect: "read", output: JSON.stringify({ items: [item], next_cursor: last ? null : page }) };
            if (!last && attempt === 1) { sample = "owner_pending"; result = { ...result, status: "pending", output: "", retry_after_s: pendingRetryAfterSeconds }; }
            else sample = last ? "owner_last_page" : "owner_first_page";
          } else if (name === "inner_404") {
            result = { ...result, effect: "read", ...(tool === "owner_get_grid" ? { status: "error", output: '{"http_status":404,"message":"Grid not found"}' } : { output: '{"items":[]}' }) };
            sample = tool === "owner_get_grid" ? "owner_inner_404" : "owner_ok";
          } else if (name === "confirmation") {
            sample = "owner_confirmation_pending";
            result = { ...result, status: "confirmation_pending", output: "", delivered: true, calls_remaining: 0,
              confirmation_id: "confirmation_owner_x4", summary: "Deactivate the named clone?", expires_at: "2026-10-10T00:10:00Z" };
          } else if (tool === "owner_attach_grid_chats") { sample = "owner_204"; result.output = ""; }
          else if (tool === "owner_create_grid") {
            const name = (body.arguments!.body as { name: string }).name;
            result.output = JSON.stringify({ grid_id: name === "Grid A" ? grid : "00000000-0000-0000-0000-000000000001", kind: "settings", name });
          }
          else if (tool === "owner_list_grids") result.output = '{"items":[]}';
          else if (tool === "owner_activate_clone") result.output = JSON.stringify({ bot_id: 42, status: "active", webhook_url: "https://hooks.example/clone" });
          const response = ownerResponse(body, result);
          entry.attempts.push({ request: body, x1_sample: sample, response: response.body });
          return response;
        } });
      if (name === "lease_lost") {
        expect(run.completion).toBeNull(); expect(run.completions).toEqual([]); expect(run.record?.outcome).toBe("lease_lost");
      } else expect(run.completion?.outcome).toBe(name === "retry_ceiling" ? "declined" : "answered");
      if (name === "reads") {
        expect(waits).toEqual([5000]);
        expect(run.calls).toHaveLength(3); expect(run.calls[1]).toEqual(run.calls[0]);
        expect(run.calls[2]).toEqual(callBody(run.request, { tool: "owner_list_grid_chats", arguments: { grid_id: grid, cursor: page, limit: 2 } }));
        expect(projectionsOf(run, 3)).toHaveLength(2); // cached repetition grows no prompt
        const outputs = calls.map((call) => (call.attempts.at(-1)!.response as ToolCallResult).output);
        expect(projectionsOf(run, 3).map((result: { output: string }) => result.output)).toEqual(outputs);
        expect(outputs.map((output) => JSON.parse(output).next_cursor)).toEqual([page, null]);
        expect(projectionsOf(run, 3).every((result: { truncated: boolean; next_cursor?: string }) => !result.truncated && result.next_cursor === undefined)).toBe(true);
      }
      if (name === "writes") {
        expect(run.calls.map((call) => "tool" in call && call.tool)).toEqual([
          "owner_list_grids", "owner_create_grid", "owner_create_grid", "owner_attach_grid_chats", "owner_activate_clone", "owner_activate_clone"]);
        expect(run.calls[4]).toEqual(run.calls[5]); expect(waits).toEqual([7000]);
        expect(run.rounds[1].prompt).toContain("further distinct owner writes requested");
        expect(projectionsOf(run, 3).at(-1).output).toBe("");
        expect(run.rounds[4].prompt).toContain("11 calls are left.");
        expect(projectionsOf(run, 4).at(-1).output).toBe((calls.at(-1)!.attempts.at(-1)!.response as ToolCallResult).output);
      }
      if (name === "retry_ceiling") {
        expect(run.calls).toHaveLength(4); expect(new Set(run.calls.map((call) => JSON.stringify(call))).size).toBe(1);
        expect(waits).toEqual([7000, 7000, 7000]); expect(run.rounds[1].prompt).toContain("16 calls are left.");
        expect(run.rounds[2].schema.properties.action.enum).toContain("handoff");
        expect(run.completion).toMatchObject({ outcome: "declined", reason: "handoff" });
      }
      if (name === "inner_404") {
        expect(run.calls).toHaveLength(2); expect(projectionsOf(run)[0]).toMatchObject({ status: "error", output: '{"http_status":404,"message":"Grid not found"}' });
      }
      if (name === "confirmation") {
        const projection = projectionsOf(run)[0];
        expect(projection).toMatchObject({ status: "confirmation_pending", summary: "Deactivate the named clone?", expires_in_s: 600, delivered: true });
        expect(projection).not.toHaveProperty("confirmation_id"); expect(projection).not.toHaveProperty("expires_at");
        expect(run.rounds[1].prompt).not.toContain("confirmation_owner_x4");
        expect(run.rounds[1].prompt).not.toContain("2026-10-10T00:10:00Z");
        expect(run.rounds[1].prompt).toContain("nothing you can call confirms it");
        expect(run.rounds[1].schema).toEqual(answerSchema);
      }
      // The regeneration command selects this test alone. Refuse malformed
      // R8 bodies here as well as in the committed-capture regression.
      for (const call of calls) for (const attempt of call.attempts) {
        if (attempt.response) assertOwnerCaptureResponse(attempt.response);
      }
      capture.push({ name, x1: { amendment_revision: "03de6455", amendment_sha256: "0a0e746a0868d7e5c81be9bdd12219205506f4cee082bb0126e2e82c89af050e",
        claim: "claimed_tools_owner_tools.json", claim_source: "local I10 owner index over unchanged X1 2b claim", index: "owner-tools-index.json" }, calls,
        completion: run.completion ? { ...run.completion, duration_ms: 0 } : null });
    }
    const [reads, ...actions] = capture;
    const output = JSON.stringify({ x1: reads!.x1, claim_body: { wait_s: 25, ...relayClaimCapabilities({ features: ownerFeatures }),
      slots: [{ target_id: ownerRequest().target_id, free: 1 }] }, calls: reads!.calls, completion: reads!.completion, actions }, null, 2) + "\n";
    const file = path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop_owner.json");
    if (process.env.LLV_RELAY_WIRE_OUTPUT_OWNER) fs.writeFileSync(process.env.LLV_RELAY_WIRE_OUTPUT_OWNER, output);
    else expect(output).toBe(deadlineNegotiatedCapture(fs.readFileSync(file, "utf8")));
  } finally { setRelaySwitch("relay:owner_tools:enabled", false); }
});
const actionResponse = (sample: string, body: WireCall) => ({ body: {
  ...x1Results[sample]!, call_id: body.call_id, tool: "tool" in body ? body.tool : x1Results[sample]!.tool,
} });

test("a post-execution switch-off denial prevents a changed-reason ban after switch-on", async () => {
  let actionsEnabled = true;
  const executed = new Set<string>();
  const run = await runLoopCase({ role: "actions_admin",
    plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call('ban_participant',{
      target_message_id:'m_b40b71a0a9d43622ee0e2e6a',reason:round===1?'Spam':'Repeated spam'})]}:reply;`,
    response: (body) => {
      expect(actionsEnabled).toBe(true);
      executed.add(body.call_id);
      actionsEnabled = false;
      // Exact output of Celestia's withhold_action_result at dcc35137,
      // apps/backend/application/usecase/clones/relay_tool_call.py:115.
      const withheld = { call_id: body.call_id, tool: "ban_participant", status: "denied", output: "",
        truncated: false, effect: "action", delivered: false, replayed: false, calls_remaining: 15, code: "not_permitted" };
      actionsEnabled = true;
      return { body: withheld };
    } });
  expect(executed.size).toBe(1);
  expect(run.calls).toHaveLength(1);
  expect(projectionsOf(run)[0]).toMatchObject({ status: "denied", code: "not_permitted", effect: "action" });
  expect(run.rounds[1].schema).toEqual(answerSchema);
  // Even a model that ignores the final schema cannot issue another ban or hand off.
  expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
  expect(run.completions).toHaveLength(1);
});

for (const choice of ["reply", "call", "handoff", "ignore"])
  test(`an exhausted unavailable replay preserves the completed ban's uncertainty with ${choice}`, async () => {
    const executed = new Set<string>();
    const run = await runLoopCase({ role: "actions_admin",
      plan: `if(round===1||'${choice}'==='call'&&!final)return {action:'call',text:'',reply_to:null,calls:[call('ban_participant',{
        target_message_id:'m_b40b71a0a9d43622ee0e2e6a',reason:round===1?'Spam':'Repeated spam'})]};
        if('${choice}'==='call')return {action:'call',text:'',reply_to:null,calls:[call('ban_participant',{reason:'Repeated spam'})]};
        return '${choice}'==='reply'?{...reply,text:'The ban may have happened; I will not repeat it.'}:{action:'${choice}',text:'',reply_to:null};`,
      response: (body) => {
        if (!executed.has(body.call_id)) {
          executed.add(body.call_id);
          return { drop: true }; // Ban finished, but its first HTTP result was lost.
        }
        // Celestia reauthorizes a saved ok result before replaying it. The
        // pinned dispatcher returns this denial when that check is unavailable.
        return { body: { call_id: body.call_id, tool: "ban_participant", status: "denied", output: "",
          truncated: false, effect: "action", delivered: false, replayed: true, calls_remaining: 15,
          code: "unavailable", retry_after_s: 1 } };
      } });
    expect(executed.size).toBe(1);
    expect(run.calls).toHaveLength(4);
    expect(new Set(run.calls.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(projectionsOf(run)[0]).toMatchObject({ status: "denied", code: "unavailable", effect: "action", execution_unknown: true });
    expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
    expect(run.rounds[1].prompt).toContain("execution_unknown means the action may have happened");
    expect(run.rounds).toHaveLength(2);
    expect(run.record!.toolCalls![0]).toMatchObject({ status: "denied", code: "unavailable", replayed: true, local: false });
    expect(run.completion).toMatchObject(choice === "reply" ? { outcome: "answered" } : { outcome: "failed", reason: "invalid_answer" });
    expect(run.completions).toHaveLength(1);
  });

for (const sample of ["action_ok", "action_error", "action_denied", "confirmation_pending", "outcome_unknown", "action_replayed", "action_delivered"])
  test(`X1 ${sample} crosses the real action loop`, async () => {
    const wire = x1Results[sample]!;
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan(wire.tool),
      runtime: { now: () => Date.parse("2026-01-01T00:00:00Z") }, response: (body) => actionResponse(sample, body) });
    expect(run.calls).toHaveLength(1);
    expect(run.completion).toMatchObject({ outcome: "answered" });
    expect(projectionsOf(run)[0]).toMatchObject({ status: wire.status, effect: "action", output: wire.output });
    const schema = run.rounds[1].schema;
    expect(schema.properties.action.enum).not.toContain("handoff");
    if (sample === "outcome_unknown") expect(schema).toEqual(replyAnswerSchema);
    else if (wire.delivered || wire.status === "confirmation_pending" || wire.status === "denied") expect(schema).toEqual(answerSchema);
    else expect(schema.properties.action.enum).toContain("call");
    if (wire.delivered) expect(projectionsOf(run)[0].delivered).toBe(true);
    if (sample === "confirmation_pending") {
      expect(projectionsOf(run)[0].summary).toBe(wire.summary);
      expect(projectionsOf(run)[0].expires_in_s).toBe(Math.max(0, Math.ceil((Date.parse(wire.expires_at!) - Date.parse("2026-01-01T00:00:00Z")) / 1000)));
      expect(projectionsOf(run)[0]).not.toHaveProperty("confirmation_id");
    }
    expect(run.record!.toolCalls![0]).toMatchObject({ effect: "action", local: false });
    for (const field of ["output", "summary", "confirmation_id", "arguments", "call_id", "lease_id", "credential"])
      expect(run.record!.toolCalls![0]).not.toHaveProperty(field);
  });

for (const choice of ["ignore", "handoff"])
  test(`an unknown action rejects ${choice} even if the model ignores its schema`, async () => {
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan("generate_video", `{action:'${choice}',text:'',reply_to:null}`),
      response: (body) => actionResponse("outcome_unknown", body) });
    expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
    expect(run.completions).toHaveLength(1);
    expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
  });

test("handoff_after_action completion is resent as failed/invalid_answer", async () => {
  const run = await runLoopCase({ plan: `return {action:'handoff',text:'',reply_to:null,calls:[]};`,
    completeResponse: (_body, attempt) => attempt === 1 ? x1Errors.handoff_after_action! : { body: { status: "ok" } } });
  expect(run.completions).toHaveLength(2);
  expect(run.completions[0]).toMatchObject({ outcome: "declined", reason: "handoff" });
  expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
  expect(run.record?.delivery).toBe("accepted");
});

test("action repeats in one round and later rounds join one execution", async () => {
  const run = await runLoopCase({ role: "actions_admin",
    plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('react_to_message',{})]}:reply;`,
    response: (body) => actionResponse("action_ok", body) });
  expect(run.calls).toHaveLength(1);
  expect(projectionsOf(run, 2)).toHaveLength(1);
  expect(run.record!.toolCalls).toHaveLength(4);
});

test("a second action is local and can be requested after the first result", async () => {
  const run = await runLoopCase({ role: "actions_admin", plan: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('ban_participant',{})]};
    if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('ban_participant',{})]};return reply;`,
    response: (body) => actionResponse("action_ok", body) });
  expect(run.calls.map((body) => "tool" in body && body.tool)).toEqual(["react_to_message", "ban_participant"]);
  expect(run.record!.toolCalls![1]).toMatchObject({ local: true, code: "too_many_calls", effect: "action" });
});

test("reads settle before an action even when the model lists the action first", async () => {
  let settledReads = 0;
  const run = await runLoopCase({ role: "actions_admin", plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('search_docs',{query:'a'}),call('search_docs',{query:'b'})]}:reply;`,
    response: async (body) => {
      if ("tool" in body && body.tool === "search_docs") {
        await Bun.sleep(20); settledReads++; return { body: { ...x1Results.ok, call_id: body.call_id } };
      }
      expect(settledReads).toBe(2); return actionResponse("action_ok", body);
    } });
  expect(run.calls.map((body) => "tool" in body && body.tool)).toEqual(["search_docs", "search_docs", "react_to_message"]);
  expect(projectionsOf(run).map((p: { tool: string }) => p.tool)).toEqual(["react_to_message", "search_docs", "search_docs"]);
});

for (const failure of ["transport", "malformed", "503_then_400", "call_conflict", "pending_deadline", "ambiguous_429", "ambiguous_413", "pending_then_400", "malformed_then_400", "five_xx", "oversized_response", "wrong_tool"])
  test(`${failure} cannot prove an action fate and ends calling`, async () => {
    let clock = 0;
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan("react_to_message"),
      runtime: { now: () => clock, sleep: async (ms) => { clock += ms; } },
      response: (body, attempt) => {
        if (failure === "pending_deadline") return actionResponse("action_pending", body);
        if (failure === "call_conflict") return x1Errors.call_conflict!;
        if (failure === "malformed") return { body: { ...x1Results.action_ok, call_id: "wrong" } };
        if (failure === "transport") return { drop: true };
        if (failure === "five_xx") return { status: 503 };
        if (failure === "oversized_response") return { body: { ...x1Results.action_ok, call_id: body.call_id, output: "x".repeat(65537) } };
        if (failure === "wrong_tool") return { body: { ...x1Results.action_ok, call_id: body.call_id, tool: "generate_image" } };
        if (failure === "pending_then_400") return attempt === 1 ? actionResponse("action_pending", body) : { status: 400 };
        if (failure === "malformed_then_400") return attempt === 1 ? { body: "malformed" } : { status: 400 };
        return attempt === 1 ? { status: 503 } : { status: failure === "503_then_400" ? 400 : failure === "ambiguous_413" ? 413 : 429, body: { error: { code: "refused" } } };
      } });
    expect(run.completion).toMatchObject({ outcome: "answered" });
    expect(projectionsOf(run)[0]).toMatchObject({ status: "outcome_unknown", effect: "action" });
    expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
    expect(new Set(run.calls.map((call) => JSON.stringify(call))).size).toBe(1);
    expect(run.record!.toolCalls![0]).toMatchObject({ status: "outcome_unknown", local: true, effect: "action" });
    if (["transport", "malformed"].includes(failure)) expect(run.calls).toHaveLength(4);
    if (failure === "pending_deadline") expect(clock).toBe(330000);
  });

for (const unresolved of [302, 408, 418, 409])
  for (const refusal of [400, 401, 413, 426, 429])
    test(`an unresolved ${unresolved} then ${refusal} prevents a changed-reason ban`, async () => {
      const executed = new Set<string>();
      const run = await runLoopCase({ role: "actions_admin",
        plan: `if(final)return reply;return round<=2?{action:'call',text:'',reply_to:null,calls:[call('ban_participant',{
          target_message_id:'m_b40b71a0a9d43622ee0e2e6a',reason:round===1?'Spam':'Repeated spam'})]}:reply;`,
        response: (body, attempt) => {
          if (attempt === 1) {
            executed.add(body.call_id);
            return { status: unresolved, body: { error: { code: "unexpected_response" } } };
          }
          if (body.call_id === [...executed][0]) return { status: refusal, body: { error: { code: "refused" } } };
          executed.add(body.call_id);
          return actionResponse("action_ok", body);
        } });
      expect(executed.size).toBe(1);
      expect(run.calls).toHaveLength(refusal === 429 ? 4 : 2);
      expect(new Set(run.calls.map((body) => JSON.stringify(body))).size).toBe(1);
      expect(projectionsOf(run)[0]).toMatchObject({ status: "outcome_unknown", effect: "action" });
      expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
      expect(run.rounds).toHaveLength(2);
      expect(run.record!.toolCalls![0]).toMatchObject({ status: "outcome_unknown", local: true });
      expect(run.completion).toMatchObject({ outcome: "answered" });
    });

for (const status of [400, 413, 429, 401, 426])
  test(`pre-admission ${status} alone remains an action error`, async () => {
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan("react_to_message"),
      response: () => ({ status, body: { error: { code: "refused" } } }) });
    expect(projectionsOf(run)[0]).toMatchObject({ status: "error", effect: "action" });
    expect(run.rounds[1].schema.properties.action.enum).not.toContain("handoff");
    if ([401, 426].includes(status)) expect(run.rounds[1].schema).toEqual(answerSchema);
  });

for (const rejection of ["unauthorized", "unsupported_version"])
  for (const first of ["pending", "transport", "503"])
    test(`an action's ${first} then ${rejection} preserves uncertainty and rejects ignore`, async () => {
      const run = await runLoopCase({ role: "actions_admin",
        plan: actionPlan("react_to_message", `{action:'ignore',text:'',reply_to:null}`),
        response: (body, attempt) => attempt > 1 ? x1Errors[rejection]!
          : first === "pending" ? actionResponse("action_pending", body)
          : first === "transport" ? { drop: true } : { status: 503 } });
      expect(run.calls).toHaveLength(2);
      expect(run.calls[0]).toEqual(run.calls[1]);
      expect(projectionsOf(run)[0]).toMatchObject({ status: "outcome_unknown", effect: "action" });
      expect(run.record!.toolCalls![0]).toMatchObject({ status: "outcome_unknown", local: true });
      expect(run.rounds[1].schema).toEqual(replyAnswerSchema);
      expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
      expect(run.completions).toHaveLength(1);
    });

for (const status of ["ok", "error"])
  for (const pendingRemaining of [15, 0])
    test(`a replayed action ${status} with zero ends calls after polling pending with ${pendingRemaining} left`, async () => {
      const run = await runLoopCase({ role: "actions_admin",
        plan: `if(final)return reply;return round<=2?{action:'call',text:'',reply_to:null,calls:[call(round===1?'generate_voice':'react_to_message',{})]}:reply;`,
        response: (body, attempt) => ({ body: {
          ...actionResponse(attempt === 1 ? "action_pending" : "action_error", body).body,
          status: attempt === 1 ? "pending" : status, delivered: false,
          calls_remaining: attempt === 1 ? pendingRemaining : 0, replayed: attempt > 1,
        } }) });
      expect(run.calls).toHaveLength(2);
      expect(run.calls[0]).toEqual(run.calls[1]);
      expect(projectionsOf(run)[0]).toMatchObject({ status, effect: "action" });
      expect(run.rounds).toHaveLength(2);
      expect(run.rounds[1].schema).toEqual(answerSchema);
      expect(run.completion).toMatchObject({ outcome: "answered" });
    });

test("a positive historical action replay keeps the fresh remaining-call budget", async () => {
  const run = await runLoopCase({ role: "actions_admin",
    plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{message_id:String(round)})]}:reply;`,
    response: (body, attempt) => ({ body: { ...actionResponse("action_ok", body).body,
      calls_remaining: attempt === 1 ? 2 : 15, replayed: attempt === 2 } }) });
  expect(run.calls).toHaveLength(2);
  expect(run.rounds[2].prompt).toContain("2 calls are left.");
  expect(run.rounds[2].schema.properties.action.enum).toContain("call");
  expect(run.completion).toMatchObject({ outcome: "answered" });
});

test("C6 action identity survives a new lease with one execution", async () => {
  const request = { ...x1Request("actions_admin"), request_id: "rq_reclaim_action" };
  let first: WireCall | undefined;
  let executions = 0;
  const lost = await runLoopCase({ request, plan: actionPlan("generate_image"), response: (body) => {
    first = body; executions++; return x1Errors.lease_lost!;
  } });
  expect(lost.completion).toBeNull(); expect(lost.completions).toEqual([]); expect(lost.calls).toHaveLength(1);
  const reclaimed = await runLoopCase({ request: { ...request, lease_id: "b".repeat(64) }, plan: actionPlan("generate_image"), response: (body) => {
    expect(body.call_id).toBe(first!.call_id);
    if (body.call_id !== first!.call_id) executions++;
    return actionResponse("action_replayed", body);
  } });
  expect(reclaimed.completion).toMatchObject({ outcome: "answered" }); expect(executions).toBe(1);
});

test("an action cannot hand off after a denial or after a terminal result", async () => {
  for (const sample of ["action_denied", "action_delivered"]) {
    const run = await runLoopCase({ role: "actions_admin", plan: actionPlan(x1Results[sample]!.tool, `{action:'handoff',text:'',reply_to:null,calls:[]}`),
      response: (body) => actionResponse(sample, body) });
    expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
    expect(run.completions).toHaveLength(1);
  }
});

test("confirmation expiry is projected at zero and is never polled", async () => {
  const wire = x1Results.confirmation_pending!;
  const run = await runLoopCase({ role: "actions_admin", plan: actionPlan(wire.tool),
    runtime: { now: () => Date.parse(wire.expires_at!) + 1000 }, response: (body) => actionResponse("confirmation_pending", body) });
  expect(projectionsOf(run)[0]).toMatchObject({ expires_in_s: 0, summary: wire.summary });
  expect(run.calls).toHaveLength(1);
});

test("member flags remove admin actions from the prompt, schema and wire", async () => {
  const request = x1Request("actions_admin"); request.input.requester = x1Request("member").input.requester;
  const run = await runLoopCase({ request, plan: actionPlan("ban_participant") });
  expect(run.rounds[0].schema.properties.calls.items.properties.tool.enum).not.toContain("ban_participant");
  const tools = JSON.parse(run.rounds[0].prompt.match(/<tools>\n([^]*?)\n<\/tools>/)[1]);
  expect(tools.some((tool: { name: string }) => tool.name === "ban_participant")).toBe(false);
  expect(run.calls).toEqual([]);
  expect(run.record!.toolCalls![0]).toMatchObject({ code: "not_permitted", local: true });
});

test("action progress hides restricted tool names and shows unrestricted actions", async () => {
  for (const tool of ["ban_participant", "react_to_message"]) {
    const request = x1Request("actions_admin"); request.answer.progress = "notes"; request.liveness.heartbeat_interval_s = 2;
    const run = await runLoopCase({ request, plan: actionPlan(tool),
      runtime: { sleep: async (ms) => { await Bun.sleep(ms); } }, response: (body, attempt) => actionResponse(attempt === 1 ? "action_pending" : "action_ok", body) });
    // Real heartbeats carry only the loop's permitted progress labels.
    const activity = JSON.stringify(run.heartbeats);
    expect(activity).not.toContain("ban_participant");
    if (tool === "react_to_message") expect(activity).toContain("react_to_message");
  }
}, 20_000);


test("heartbeat lease loss between reads and an action prevents the action and completion", async () => {
  const request = x1Request("actions_admin"); request.liveness.heartbeat_interval_s = 2;
  const run = await runLoopCase({ request,
    plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('search_docs',{query:'meetup'})]}:reply;`,
    response: async (body) => { await Bun.sleep(2400); return { body: { ...x1Results.ok, call_id: body.call_id } }; },
    heartbeatResponse: (seq) => seq === 1 ? { body: { status: "ok" } } : x1Errors.lease_lost! });
  expect(run.calls).toHaveLength(1); expect(run.calls[0]).toHaveProperty("tool", "search_docs");
  expect(run.events).toContain("beat:2"); expect(run.completion).toBeNull(); expect(run.completions).toEqual([]);
}, 10_000);

for (const reverseReadArrival of [false, true])
test(`X2 actions are generated by the real runner using the service fixtures (${reverseReadArrival ? "reversed" : "normal"} arrivals)`, async () => {
  const runs: unknown[] = [];
  const plans = [
    { name: "action_and_confirmation", plan: `if(round===1)return {action:'call',text:'',reply_to:null,calls:[call('search_chat_messages',{query:'spam'}),call('search_docs',{query:'meetup'}),call('react_to_message',{emoji:'👍',message_id:'m_b40b71a0a9d43622ee0e2e6a'})]};
      if(round===2)return {action:'call',text:'',reply_to:null,calls:[call('request_kick_participant',{reason:'Repeated spam',target_message_id:'m_b40b71a0a9d43622ee0e2e6a'})]};
      return {...reply,text:'Removal is waiting for confirmation in the chat.',reply_to:null};` },
    { name: "delivered_generation", plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('generate_image',{prompt:'A quiet forest'})]}:{action:'ignore',text:'',reply_to:null};` },
    { name: "outcome_unknown", plan: `return round===1?{action:'call',text:'',reply_to:null,calls:[call('generate_video',{prompt:'A quiet forest at dawn'})]}:{...reply,text:'The video may have been sent; I will not try again.',reply_to:null};` },
  ];
  for (const { name, plan } of plans) {
    const request = x1Request("actions_admin");
    const tools = name === "action_and_confirmation"
      ? ["search_chat_messages", "search_docs", "react_to_message", "request_kick_participant"]
      : [name === "delivered_generation" ? "generate_image" : "generate_video"];
    // Admission slots and budgets follow model order, independently of HTTP arrival.
    const calls: { round: number; attempts: { request: WireCall; x1_sample: string; response: ToolCallResult }[] }[] =
      tools.map((tool) => ({ round: tool === "request_kick_participant" ? 2 : 1, attempts: [] }));
    const stored = new Map<string, ToolCallResult>();
    const executions = new Map<string, number>();
    let admitReads!: () => void;
    const readsAdmitted = new Promise<void>((resolve) => { admitReads = resolve; });
    const run = await runLoopCase({ request, plan, reverseReadArrival: reverseReadArrival && name === "action_and_confirmation",
      runtime: { now: () => Date.parse("2026-10-07T12:00:00Z") },
      response: async (body) => {
        if (!("tool" in body) || !body.tool) throw new Error("X2 action has no tool");
        const index = tools.indexOf(body.tool);
        expect(index).toBeGreaterThanOrEqual(0);
        const first = !stored.has(body.call_id);
        const sample = body.tool === "search_chat_messages" ? "admin" : body.tool === "search_docs" ? "ok"
          : body.tool === "react_to_message" ? "action_ok"
          : body.tool === "request_kick_participant" ? "confirmation_pending" : body.tool === "generate_video" ? "outcome_unknown"
          : first ? "action_pending" : "action_delivered";
        if (first) {
          executions.set(body.call_id, (executions.get(body.call_id) ?? 0) + 1);
          const terminal = body.tool === "generate_image" ? x1Results.action_delivered! : x1Results[sample]!;
          stored.set(body.call_id, { ...terminal, call_id: body.call_id,
            calls_remaining: terminal.calls_remaining === 0 ? 0 : 15 - index });
        }
        if (name === "action_and_confirmation" && index < 2) {
          if (stored.size >= 2) admitReads();
          await readsAdmitted;
        }
        const response = first
          ? { ...x1Results[sample]!, call_id: body.call_id, calls_remaining: x1Results[sample]!.calls_remaining === 0 ? 0 : 15 - index, replayed: false }
          : { ...stored.get(body.call_id)!, replayed: true };
        expect(response.tool).toBe(body.tool!);
        calls[index]!.attempts.push({ request: body, x1_sample: sample, response });
        return { body: response };
      } });
    expect([...executions.values()].every((count) => count === 1)).toBe(true);
    expect(run.completion?.outcome).toBe("answered");
    if (run.completion?.outcome !== "answered") throw new Error("X2 action did not answer");
    expect(run.completion.duration_ms).toBeGreaterThanOrEqual(0);
    if (name === "action_and_confirmation") {
      expect(run.calls.map((call) => "tool" in call && call.tool)).toEqual(reverseReadArrival
        ? ["search_docs", "search_chat_messages", "react_to_message", "request_kick_participant"]
        : ["search_chat_messages", "search_docs", "react_to_message", "request_kick_participant"]);
      expect(run.rounds).toHaveLength(3);
    } else expect(run.rounds).toHaveLength(2);
    if (name === "delivered_generation") {
      expect(run.calls[0]).toEqual(run.calls[1]);
      expect(calls[0]!.attempts[0]!.response).toMatchObject({ status: "pending", replayed: false });
      expect(calls[0]!.attempts[1]!.response).toMatchObject({ status: "ok", delivered: true, replayed: true });
      expect(executions.get(run.calls[0]!.call_id)).toBe(1);
    }
    runs.push({ name, x1: { claim: "claimed_tools_actions_admin.json", claim_sha256: createHash("sha256").update(fs.readFileSync(path.join(x1Dir, "claimed_tools_actions_admin.json"))).digest("hex") },
      calls, completion: { ...run.completion, duration_ms: 0 } });
  }
  const file = path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop.json");
  const expected = JSON.parse(fs.readFileSync(file, "utf8"));
  if (process.env.LLV_RELAY_WIRE_OUTPUT_ACTIONS) fs.writeFileSync(process.env.LLV_RELAY_WIRE_OUTPUT_ACTIONS, JSON.stringify({ ...expected, actions: runs }, null, 2) + "\n");
  expect(runs).toEqual(expected.actions);
});

// Opt-in live-model checks use only the local fake; credentials remain in the profile's auth source.
for (const engine of ["codex", "claude"] as const)
  for (const task of ["react", "meetup"])
    (process.env.LLV_RELAY_LIVE_ACTION_PROBE === "1" ? test : test.skip)(`${engine} live model ${task} uses only the requested action`, async () => {
      const accountHome = process.env[engine === "codex" ? "LLV_RELAY_LIVE_CODEX_HOME" : "LLV_RELAY_LIVE_CLAUDE_HOME"];
      if (!accountHome) throw new Error("live action probe account home is required");
      const request = x1Request("actions_admin");
      request.request_id = `rq_live_synthetic_${engine}_${task}`;
      request.input.tools = request.input.tools!.filter((tool) => ["react_to_message", "search_docs"].includes(tool.name));
      request.input.tool_guidance = null;
      request.input.instructions = "Answer the requester briefly using the supplied tools when needed.";
      request.input.request_text = task === "react" ? "React with 👍 to message m_b40b71a0a9d43622ee0e2e6a." : "When is the meetup?";
      request.input.short_term_memory = null;
      request.input.documents = [];
      request.input.conversation = [];
      const run = await runLoopCase({ request, live: { engine, home: accountHome }, response: (body) => {
        if ("tool" in body && body.tool === "react_to_message") return actionResponse("action_ok", body);
        return { body: { ...x1Results.ok, call_id: body.call_id, output: "The meetup is Friday." } };
      } });
      expect(run.completion).toMatchObject({ outcome: "answered" });
      const actions = run.calls.filter((call) => "tool" in call && call.tool === "react_to_message");
      expect(actions).toHaveLength(task === "react" ? 1 : 0);
    }, 180_000);


test("a read effect returned for an indexed action never restores handoff", async () => {
  const run = await runLoopCase({ role: "actions_admin", plan: actionPlan("generate_image", `{action:'handoff',text:'',reply_to:null,calls:[]}`),
    response: (body) => ({ body: { ...x1Results.not_permitted, call_id: body.call_id, tool: "generate_image" } }) });
  expect(projectionsOf(run)[0]).toMatchObject({ effect: "action", status: "denied", code: "not_permitted" });
  expect(run.rounds[1].schema.properties.action.enum).not.toContain("handoff");
  expect(run.completion).toMatchObject({ outcome: "failed", reason: "invalid_answer" });
});

// Captured by replaying the accepted slice 2b runner before enabling any slice 3 path.
test("slice 3 dark and ineligible paths preserve the slice 2b wire and records", async () => {
  setRelaySwitch("chain_conversations", false);
  const fixtureFile = path.join(x1Dir, "switches-off-2b-hashes.json");
  const snapshot = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  const cases = ["member", "admin", "owner", "anonymous_admin", "admin_owner_member", "actions_admin", "action_react", "action_ban"];
  const surfaces: Record<string, unknown> = {};
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  async function replay(role: string, ownerTier?: boolean) {
    const request = x1Request(role.startsWith("action_") ? "actions_admin" : role);
    const run = await runLoopCase({ request, ownerTier, relayId: "baseline_relay", ...(role.startsWith("action_") ? { plan: actionPlan(role === "action_react" ? "react_to_message" : "ban_participant") } : {}) });
    const record = { ...run.record, startedAt: "time", finishedAt: "time", durationMs: 0 };
    const view = (await import("./store")).publicRelay({ ...run.paired, origin: "https://fixture.example", api_base: "https://fixture.example/v1", pairedAt: "time" });
    if (ownerTier !== undefined) delete view.targets[0]!.ownerTier;
    return { prompts: run.rounds.map((r) => hash(r.prompt)), schemas: run.rounds.map((r) => hash(JSON.stringify(r.schema))), calls: run.calls.map((call) => hash(JSON.stringify(call))), record: hash(JSON.stringify(record)), view: hash(JSON.stringify(view)) };
  }
  for (const role of cases) surfaces[role] = await replay(role);
  if (process.env.LLV_RELAY_CAPTURE_2B) { fs.writeFileSync(process.env.LLV_RELAY_CAPTURE_2B, JSON.stringify({ ...snapshot, surfaces }, null, 2) + "\n"); return; }
  expect(surfaces).toEqual(snapshot.surfaces);
  for (const role of cases.filter(r => r !== "owner")) expect(await replay(role, true)).toEqual(snapshot.surfaces[role]);
  const switchFile = path.join(path.dirname(externalRelayFile("relays")), "switches.json");
  try {
    for (const raw of [JSON.stringify({ v: 1, chain_conversations: false, compact: false })]) {
      fs.writeFileSync(switchFile, raw);
      for (const role of cases) expect(await replay(role)).toEqual(snapshot.surfaces[role]);
    }
    setRelaySwitch("chain_conversations", false);
    for (const role of ["admin", "anonymous_admin", "actions_admin"]) expect(await replay(role)).toEqual(snapshot.surfaces[role]);
  } finally { fs.rmSync(switchFile, { force: true }); }
}, 30000);


test("short owner reply continues the earlier relay answer", async () => {
  const approval = "Роби";
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`);
  paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const message = contextRequest.input.conversation[0];
  const earlierText = "Can you fix the issue discussed here?";
  const answerText = "I can implement the fix and open a pull request. Shall I proceed?";
  const resolve = ownerContext.resolveOwnerReplyContext;
  const contexts: ReturnType<typeof resolve>[] = [];
  const accessor = spyOn(ownerContext, "resolveOwnerReplyContext").mockImplementation((request, owner) => {
    const context = resolve(request, owner);
    contexts.push(context);
    return context;
  });
  let launches = 0;
  try {
    const result = await runClaimedRequest(paired, { ...contextRequest, answer: { max_chars: 1000, progress: "none" }, input: {
      ...contextRequest.input, request_text: approval, requester: { ...contextRequest.input.requester, is_owner: true },
      conversation: [
        { ...message, id: "earlier-request", text: earlierText },
        { ...message, id: "earlier-answer", author: { key: "assistant", name: "Assistant", self: true }, text: answerText, reply_to: "earlier-request" },
        { ...message, text: approval, reply_to: "earlier-answer" },
      ],
    } }, undefined, { ownerPorts: {
      launch: async () => {
        launches++;
        expect(contexts.at(-1)).toMatchObject({ message_id: "earlier-answer", text: answerText, reply_to: "earlier-request",
          earlier_request: { message_id: "earlier-request", text: earlierText } });
        return { status: 202, body: { conversationId: "conversation_reply_fixture" } };
      },
      observe: async () => ({ state: "ended", finalText: "Fix completed." }), stop: async () => {}, pollMs: 1,
    } });
    expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: message.id } });
    expect(launches).toBe(1);
    expect(accessor).toHaveBeenCalledTimes(1);
  } finally { accessor.mockRestore(); await server.close(); }
});

test("owner message without a target selects an account and launches once", async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`);
  paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const select = spyOn(accountManager, "resolveHeadlessSpawn");
  let launches = 0;
  try {
    const result = await runClaimedRequest(paired, { ...contextRequest, request_id: "owner-unresolved", answer: { max_chars: 1000, progress: "none" },
      input: { ...contextRequest.input, request_text: "Роби", requester: { ...contextRequest.input.requester, is_owner: true },
        conversation: contextRequest.input.conversation.map(message => ({ ...message, text: "Роби", reply_to: null })) } }, undefined,
      { ownerPorts: { launch: async () => { launches++; return { status: 202, body: { conversationId: "conversation_unresolved_fixture" } }; },
        observe: async () => ({ state: "ended", finalText: "Please clarify." }), stop: async () => {}, pollMs: 1 } });
    expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", text: expect.any(String) } });
    expect(select).toHaveBeenCalled();
    expect(launches).toBe(1);
    expect(readRunLedger().runs).toEqual([]);
  } finally { select.mockRestore(); await server.close(); }
});

test("a non-owner short reply keeps the restricted answer path", async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`);
  paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const message = contextRequest.input.conversation[0];
  let launches = 0;
  try {
    const result = await runClaimedRequest(paired, { ...contextRequest, answer: { max_chars: 1000, progress: "none" }, input: {
      ...contextRequest.input, tools: [], request_text: "Роби", conversation: [
        { ...message, id: "earlier-answer", author: { key: "assistant", name: "Assistant", self: true }, text: "Shall I proceed?" },
        { ...message, text: "Роби", reply_to: "earlier-answer" },
      ],
    } }, undefined, {
      command: stub("const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Normal reply',reply_to:'m1'}));"),
      ownerPorts: { launch: async () => { launches++; throw new Error("a member cannot launch an owner agent"); },
        observe: async () => ({ state: "failed" }), stop: async () => {} },
    });
    expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: message.id } });
    expect(launches).toBe(0);
    expect(readAnswerRecord(paired.id, paired.targets[0]!.id, contextRequest.request_id)?.profile).not.toHaveProperty("owner");
  } finally { await server.close(); }
});

for (const explicitReply of [false, true])
  test(`owner report custody restricts handoff only with an explicit reply (${explicitReply})`, async () => {
  const { Database } = await import("bun:sqlite");
  const { appendBridgeReports, recordBridgeReportTelegram } = await import("@/lib/bridge/store");
  const { recordPublishedRelayReference } = await import("./publishedReferences");
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`);
  paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const directory = path.join(process.env.LLV_STATE_DIR!, "telegram");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "bot.sqlite");
  fs.rmSync(filename, { force: true });
  const db = new Database(filename);
  db.exec("CREATE TABLE chats (chat_id TEXT PRIMARY KEY, alias TEXT)");
  const chatId = String(2 ** 6), messageId = 2 ** 5 + Number(explicitReply);
  db.query("INSERT INTO chats VALUES (?, ?)").run(chatId, "report-room");
  db.close();
  const body = "Create a clone with one button? Confirm the start.";
  const report = appendBridgeReports([{ key: `owner-report-${explicitReply}`, project: "project-b", targetSeatConversationId: "seat-b",
    origin: { kind: "manager", conversationId: "seat-b", role: "orchestrator" }, class: "question", at: new Date().toISOString(), body,
    telegram: { chat: "report-room", html: body } }]).appended[0];
  recordBridgeReportTelegram(report.id, { state: "sent", messageIds: [messageId], at: new Date().toISOString() });
  recordPublishedRelayReference(paired.api_base, "/targets/target_1/messages", "POST", { chat_id: Number(chatId), message_id: messageId }, 200, { message_key: `posted-report-${explicitReply}`, replayed: false });
  let launches = 0;
  const accessor = spyOn(ownerContext, "resolveOwnerReplyContext");
  try {
    const result = await runClaimedRequest(paired, { ...contextRequest, request_id: "owner-report-reply", answer: { max_chars: 1000, progress: "none" },
      input: { ...contextRequest.input, request_text: "implement X in project-a", requester: { ...contextRequest.input.requester, is_owner: true },
        conversation: [
          { ...contextRequest.input.conversation[0], id: `posted-report-${explicitReply}`, text: "An altered history copy of the report." },
          ...contextRequest.input.conversation.map(message => ({ ...message, text: "/ai implement X in project-a", reply_to: explicitReply ? `posted-report-${explicitReply}` : null })),
        ] } }, undefined,
      { ownerPorts: { launch: async () => {
        launches++;
        if (explicitReply) expect(accessor).not.toHaveBeenCalled();
        else expect(accessor).toHaveBeenCalledTimes(1);
        return { status: 202, body: { conversationId: "conversation_report_reply" } };
      },
        observe: async () => {
          const run = readRunLedger().runs.find(run => run.requestId === "owner-report-reply")!;
          if (explicitReply) expect(run.ownerTurn?.bridgeReport).toMatchObject({ project: "project-b", sourceSeat: "seat-b", reportText: body });
          else expect(run.ownerTurn).not.toHaveProperty("bridgeReport");
          expect(ownerRelayTargetMatches(run.conversationId!, "project-a", "seat-a")).toBe(!explicitReply);
          expect(ownerRelayTargetMatches(run.conversationId!, "project-b", "seat-b")).toBe(true);
          return { state: "ended", finalText: "Передано до місця проєкту." };
        }, stop: async () => {}, pollMs: 1 } });
    expect(result).toMatchObject({ outcome: "answered" });
    expect(launches).toBe(1);
  } finally { accessor.mockRestore(); await server.close(); fs.rmSync(filename, { force: true }); }
});

for (const scenario of ["answer", "owner_tools", "lease_lost", "hard_cap", "invalid_request"] as const)
  test(`owner tier runner: ${scenario}`, async () => {
    const { contextRequest } = await import("./request.fixture");
    const { readConversations } = await import("./conversations");
    const switchFile = path.join(path.dirname(externalRelayFile("relays")), "switches.json");
    const bodies: Record<string, unknown>[] = [], stops: string[] = [], beats: Record<string, unknown>[] = [];
    const id = `owner_${crypto.randomUUID()}`;
    const server = await startTestRelay((req, body) => {
      if (req.url?.endsWith("/heartbeat")) {
        beats.push(body as Record<string, unknown>);
        return scenario === "lease_lost" && beats.length > 1 ? { status: 409, body: { error: { code: "lease_lost", message: "gone" } } } : { body: { status: "ok" } };
      }
      return { body: { status: "ok" } };
    });
    const paired = relay(`${server.origin}/v1`);
    paired.targets[0]!.ownerTier = true;
    if (scenario === "owner_tools") paired.features = ownerFeatures;
    updateRelayStore(s => ({ ...s, relays: [paired] }));
    const request = { ...contextRequest, liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2 }, request_id: id, chat: { key: "owner-group" },
      input: { ...contextRequest.input, ...(scenario === "owner_tools" ? { tools: ownerRequest().input.tools } : {}), requester: { ...contextRequest.input.requester, is_owner: scenario === "invalid_request" ? "true" : true } } };
    const conversationsBefore = readConversations();
    try {
      setRelaySwitch("chain_conversations", true);
      if (scenario === "owner_tools") setRelaySwitch("relay:owner_tools:enabled", true);
      const completion = await runClaimedRequest(paired, request, undefined, {
        command: "/missing-owner-must-never-run-cli", timeoutMs: scenario === "hard_cap" ? 50 : 4000,
        ownerPorts: {
          launch: async body => { bodies.push(body); return { status: 202, body: { conversationId: "conversation_owner_runner" } }; },
          observe: async () => {
            expect(readRunLedger().runs[0]).toMatchObject({ conversationId: "conversation_owner_runner", childPid: null,
              ownerTurn: { request: { text: contextRequest.input.conversation[0]!.text, requestText: null } } });
            if (!beats.length || scenario === "lease_lost" || scenario === "hard_cap") return { state: "running" };
            return { state: "ended", finalText: "Owner reply" };
          },
          stop: async (_id, action) => { stops.push(action); }, pollMs: 5,
        },
      });
      expect(readConversations()).toEqual(conversationsBefore);
      expect(readRunLedger().runs).toEqual([]);
      if (scenario === "invalid_request") { expect(completion).toMatchObject({ outcome: "declined", reason: "invalid_request" }); expect(bodies).toEqual([]); }
      else {
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({ cwd: os.homedir(), engine: "codex", model: "gpt-6-sol", effort: "low", accountId: "answer", clientAttemptId: `relay-owner-${id}`, mcpServers: ["viewer"], plugins: [] });
        expect(beats.length).toBeGreaterThan(0);
        expect(beats.every(b => !b.progress)).toBe(true);
        const record = readAnswerRecord(paired.id, "target_1", id);
        expect(record).toMatchObject({ profile: { webSearch: true, owner: true }, conversationId: "conversation_owner_runner" });
        if (scenario === "answer" || scenario === "owner_tools") { expect(completion).toMatchObject({ outcome: "answered", answer: { text: "Owner reply", reply_to: "m1" } }); expect(stops).toEqual([]); }
        if (scenario === "lease_lost") { expect(completion).toBeNull(); expect(stops).toEqual(["interrupt"]); }
        if (scenario === "hard_cap") { expect(completion).toMatchObject({ outcome: "failed", reason: "hard_cap" }); expect(stops).toEqual(["interrupt"]); }
      }
    } finally { fs.rmSync(switchFile, { force: true }); await server.close(); }
  });


for (const phase of ["running", "pending"] as const) test(`owner cutoff through PATCH stops ${phase} host work and withholds late reply`, async () => {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("@/app/api/external-relay/relays/[id]/route");
  const { soloBrowserSession } = await import("@/lib/agent/operatorSession");
  const completions: unknown[] = [], stops: string[] = [];
  let notify!: () => void, release!: () => void;
  const reached = new Promise<void>(r => { notify = r; });
  const held = new Promise<void>(r => { release = r; });
  let working = false;
  const service = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "ok" } };
  });
  const paired = relay(`${service.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  const requestId = `cutoff_${phase}`;
  try {
    const done = runClaimedRequest(paired, { ...contextRequest, request_id: requestId,
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
      timeoutMs: 2000, ownerPorts: {
        launch: async () => {
          if (phase === "pending") { notify(); await held; }
          working = true;
          return { status: 202, body: { conversationId: `conversation_cutoff_${phase}` } };
        },
        observe: async () => { if (phase === "running") { notify(); await held; } return { state: "ended", finalText: "Late owner reply" }; },
        stop: async (_id, action) => { stops.push(action); working = false; }, pollMs: 1, stopRetryMs: 1,
      },
    });
    await reached;
    const origin = "http://127.0.0.1:8899";
    const response = await PATCH(new NextRequest(`${origin}/api/external-relay/relays/${paired.id}`, {
      method: "PATCH", headers: { cookie: `llv_operator=${soloBrowserSession()}`, origin, host: "127.0.0.1:8899", "content-type": "application/json" },
      body: JSON.stringify({ target: { id: "target_1", ownerTier: false } }),
    }), { params: Promise.resolve({ id: paired.id }) });
    expect(response.status).toBe(200);
    if (phase === "pending") expect(readRunLedger().runs[0]?.ownerTurn).toMatchObject({ cancel: "kill" });
    release();
    expect(await done).toMatchObject({ outcome: "failed", reason: "cancelled" });
    await Bun.sleep(20);
    expect(working).toBe(false);
    expect(stops).toEqual([phase === "pending" ? "kill" : "interrupt"]);
    expect(JSON.stringify(completions)).not.toContain("Late owner reply");
    const record = readAnswerRecord(paired.id, "target_1", requestId);
    expect(record?.answer).toBeNull();
    expect(record?.conversationId).toBe(`conversation_cutoff_${phase}`);
    const { sweepExternalRelayOrphans } = await import("./poller");
    await sweepExternalRelayOrphans();
    expect(readRunLedger().runs).toEqual([]);
  } finally { release(); await service.close(); }
});

test("owner admission rechecks current store even when the claimed target object is stale", async () => {
  const service = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${service.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [{ ...paired, targets: [{ ...paired.targets[0]!, ownerTier: false }] }] }));
  let launches = 0;
  try {
    const completion = await runClaimedRequest(paired, { ...contextRequest, request_id: "stale_owner_admission",
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
      ownerPorts: { launch: async () => { launches++; return { status: 202, body: {} }; }, observe: async () => ({ state: "failed" }), stop: async () => {} },
    });
    expect(launches).toBe(0); expect(completion?.outcome).toBe("failed");
    expect(readRunLedger().runs).toEqual([]);
  } finally { await service.close(); }
});

for (const trigger of ["hard_cap", "lease_lost"] as const) test(`owner ${trigger} retains failed-stop custody and recovers through sweep`, async () => {
  const { sweepExternalRelayOrphans } = await import("./poller");
  const service = await startTestRelay((req, body) => req.url?.endsWith("/heartbeat") && trigger === "lease_lost" && (body as { seq: number }).seq > 1
    ? { status: 409, body: { error: { code: "lease_lost", message: "gone" } } } : { body: { status: "ok" } });
  const paired = relay(`${service.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  let stops = 0, working = true, recover = false;
  const ports = { launch: async () => ({ status: 202, body: { conversationId: `conversation_stop_${trigger}` } }),
    observe: async () => ({ state: "running" as const }), stopRetryMs: 1, pollMs: 1,
    stop: async () => { stops++; if (!recover) throw Error("control unavailable"); working = false; } };
  try {
    const done = await runClaimedRequest(paired, { ...contextRequest, request_id: `stop_${trigger}`, liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, { timeoutMs: trigger === "lease_lost" ? 4000 : 20, ownerPorts: ports });
    if (trigger === "lease_lost") expect(done).toBeNull(); else expect(done).toMatchObject({ reason: "hard_cap" });
    expect(stops).toBe(3); expect(working).toBe(true);
    expect(readRunLedger().runs[0]).toMatchObject({ conversationId: `conversation_stop_${trigger}`, ownerTurn: { cancel: "interrupt" } });
    expect(advertisedSlots(paired)[0]!.free).toBe(0);
    expect(relayActivity(paired.id).lastOutcome).toBe("owner_stop_pending");
    const { relayPollerStatus } = await import("./poller");
    const { noteRelayOutcome } = await import("./activity");
    noteRelayOutcome(paired.id, "failed:hard_cap");
    expect(relayPollerStatus(paired.id).lastOutcome).toBe("owner_stop_pending");
    // A restarted Viewer still has the receipt-bound conversation to stop.
    const { changeRun } = await import("./store");
    changeRun(`stop_${trigger}`, r => ({ ...r, ownerPid: 999999999, ownerIdentity: "gone" }));
    recover = true;
    await sweepExternalRelayOrphans(ports);
    expect(stops).toBe(4); expect(working).toBe(false); expect(readRunLedger().runs).toEqual([]);
  } finally { await service.close(); }
});

for (const admission of ["failed_receipt", "lost_response"] as const) test(`owner ${admission} keeps custody until host control confirms`, async () => {
  const { sweepExternalRelayOrphans } = await import("./poller");
  const service = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${service.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  let stops = 0, recover = false;
  const conversationId = `conversation_${admission}`;
  const ports = {
    launch: async () => admission === "lost_response" ? { status: 202, body: {} }
      : { status: 503, body: { conversationId } },
    observe: async () => ({ state: "failed" as const, conversationId,
      failure: { kind: "launch-failed" as const, detail: "receipt failed before cleanup was confirmed" } }),
    stop: async () => { stops++; if (!recover) throw Error("control receipt pending"); }, stopRetryMs: 1,
  };
  try {
    const completion = await runClaimedRequest(paired, { ...contextRequest, request_id: admission,
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, { ownerPorts: ports });
    expect(completion).toMatchObject({ outcome: "failed" });
    expect(stops).toBe(3);
    expect(readRunLedger().runs[0]).toMatchObject({ conversationId, ownerTurn: { cancel: "kill", admissionComplete: true } });
    expect(readAnswerRecord(paired.id, "target_1", admission)?.conversationId).toBe(conversationId);
    expect(readRunLedger().runs[0]!.ownerTurn!.confirmed).not.toBe(true);
    expect(advertisedSlots(paired)[0]!.free).toBe(0);
    // Retry while the same Viewer is alive, without relying on a restart.
    recover = true;
    await sweepExternalRelayOrphans(ports);
    expect(stops).toBe(4); expect(readRunLedger().runs).toEqual([]);
  } finally { await service.close(); }
});

test("owner credentials, host paths and key material never reach completion, answer records or diagnostics", async () => {
  const { rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
  const control = rotateOperatorSpawnCapability();
  const spawn = randomBytes(32).toString("base64url");
  const completions: unknown[] = [], diagnostics: unknown[][] = [];
  const service = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) completions.push(body); return { body: { status: "ok" } }; });
  const paired = relay(`${service.origin}/v1`); paired.targets[0]!.ownerTier = true;
  paired.credential = randomBytes(32).toString("base64url");
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  const paths = ["/srv/review-fixture/private-note.txt", "~/private-note.txt", "file:///srv/private-note.txt", String.raw`C:\fixture\private.txt`, String.raw`\\fixture-host\share\private.txt`];
  const material = "fixture-private-material";
  const pgpMaterial = "fixture-pgp-private-material";
  const value = ["fixture", "host", "credential", "value"].join("-");
  const json = JSON.stringify({ password: value, api_key: value });
  const finalText = ["Done", json, JSON.stringify({ detail: json }), paired.credential, control, spawn, ...paths, "-----BEGIN PRIVATE KEY-----", material, "-----END PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----", pgpMaterial, "-----END PGP PRIVATE KEY BLOCK-----"].join("\n");
  const oldError = console.error;
  console.error = (...args) => { diagnostics.push(args); };
  try {
    const outcome = await runClaimedRequest(paired, { ...contextRequest, request_id: "owner_scrubbed",
      answer: { ...contextRequest.answer, max_chars: 32000 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
      ownerPorts: { launch: async () => ({ status: 202, body: { conversationId: "conversation_scrubbed" } }), observe: async () => ({ state: "ended", finalText }), stop: async () => {} },
    });
    expect(outcome).toMatchObject({ outcome: "answered", answer: { text: expect.stringContaining("Done") } });
    const record = readAnswerRecord(paired.id, "target_1", "owner_scrubbed");
    expect(completions).toHaveLength(1);
    expect(record?.answer?.text).toContain("Done");
    for (const surface of [completions, record, diagnostics]) for (const secret of [value, paired.credential, control, spawn, ...paths, material, pgpMaterial]) expect(JSON.stringify(surface)).not.toContain(JSON.stringify(secret).slice(1, -1));
    const encoded = Array.from(paired.credential, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const encodedOutcome = await runClaimedRequest(paired, { ...contextRequest, request_id: "owner_encoded",
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
      ownerPorts: { launch: async () => ({ status: 202, body: { conversationId: "conversation_encoded" } }),
        observe: async () => ({ state: "ended", finalText: `{"detail":"${encoded}"}` }), stop: async () => {} },
    });
    expect(encodedOutcome).toMatchObject({ outcome: "answered", answer: { text: "[redacted]" } });
    expect(completions[1]).toMatchObject({ answer: { text: "[redacted]" } });
    expect(readAnswerRecord(paired.id, "target_1", "owner_encoded")?.answer?.text).toBe("[redacted]");
    let partial = control.slice(0, 42) + `\\u${control.charCodeAt(42).toString(16).padStart(4, "0")}`;
    for (let depth = 0; depth < 3; depth++) {
      partial = JSON.stringify({ detail: partial });
      const id = `owner_partial_${depth}`;
      const result = await runClaimedRequest(paired, { ...contextRequest, request_id: id,
        input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
        ownerPorts: { launch: async () => ({ status: 202, body: { conversationId: "conversation_partial" } }),
          observe: async () => ({ state: "ended", finalText: partial }), stop: async () => {} },
      });
      expect(result).toMatchObject({ outcome: "answered", answer: { text: "[redacted]" } });
      expect(completions.at(-1)).toMatchObject({ answer: { text: "[redacted]" } });
      expect(readAnswerRecord(paired.id, "target_1", id)?.answer?.text).toBe("[redacted]");
      expect(JSON.stringify([completions, readAnswerRecord(paired.id, "target_1", id), diagnostics])).not.toContain(control.slice(0, 42));
    }
    for (const [kind, opaque] of [["home", "q".repeat(36) + ["", "home", "a"].join("-")],
      ["vendor", "q".repeat(27) + ["", "sk", "r".repeat(12)].join("-")],
      ["encoded", "%71" + "q".repeat(26) + ["", "sk", "r".repeat(12)].join("-")]] as const) {
      const id = `owner_opaque_${kind}`;
      const opaqueOutcome = await runClaimedRequest(paired, { ...contextRequest, request_id: id,
        answer: { ...contextRequest.answer, max_chars: 32000 },
        input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
        ownerPorts: { launch: async () => ({ status: 202, body: { conversationId: "conversation_opaque" } }),
          observe: async () => ({ state: "ended", finalText: JSON.stringify({ detail: opaque }) }), stop: async () => {} },
      });
      const opaqueRecord = readAnswerRecord(paired.id, "target_1", id);
      expect(opaqueOutcome).toMatchObject({ outcome: "answered" });
      expect(opaqueRecord?.answer?.text).toContain("[redacted]");
      expect(JSON.stringify([opaqueOutcome, opaqueRecord, completions])).not.toContain(opaque.slice(0, 27));
    }
    await runClaimedRequest(paired, { ...contextRequest, request_id: "owner_safe_diagnostic",
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, {
      timeoutMs: 10, ownerPorts: { launch: async () => ({ status: 202, body: { conversationId: "conversation_diag" } }),
        observe: async () => ({ state: "running" }), stop: async () => { throw Error(finalText); }, stopRetryMs: 1, pollMs: 1 },
    });
    for (const secret of [value, paired.credential, control, spawn, ...paths, material, pgpMaterial]) expect(JSON.stringify(diagnostics)).not.toContain(JSON.stringify(secret).slice(1, -1));
    const { dropRun } = await import("./store"); dropRun("owner_safe_diagnostic");
  } finally { console.error = oldError; await service.close(); }
});

for (const retry of [false, true]) test(`owner completion rechecks cutoff after DNS resolution${retry ? " on retry" : ""}`, async () => {
  const completions: unknown[] = [];
  const server = await startTestRelay((_req, body) => {
    completions.push(body);
    return retry && completions.length === 1 ? { drop: true } : { body: { status: "ok" } };
  });
  let reached!: () => void, release!: () => void;
  const resolving = new Promise<void>(r => { reached = r; });
  const held = new Promise<void>(r => { release = r; });
  let attempts = 0, allowed = true;
  const lookup = spyOn(dns, "lookup").mockImplementation((async () => {
    if (++attempts === (retry ? 2 : 1)) { reached(); await held; }
    return [{ address: "127.0.0.1", family: 4 }];
  }) as unknown as typeof dns.lookup);
  try {
    const paired = relay(`${server.origin.replace("127.0.0.1", "relay-fixture.test")}/v1`);
    const done = completeRelayRequest(paired, "owner_dns_fixture", {
      lease_id: "lease_fixture", outcome: "answered", duration_ms: 0, answer: { action: "reply", text: "Late owner reply", reply_to: null },
    }, () => Date.now() + 45000, () => allowed);
    await resolving; allowed = false; release();
    expect(await done).toMatchObject({ body: { outcome: "failed", reason: "cancelled" }, delivery: "accepted" });
    expect(completions.at(-1)).toMatchObject({ outcome: "failed", reason: "cancelled" });
    expect(completions).toHaveLength(retry ? 2 : 1);
  } finally { release(); lookup.mockRestore(); await server.close(); }
});


test("negotiated rich completion preserves the guide, schema, table and URL button", async () => {
  const { richRequest } = await import("./rich.fixture");
  const request = richRequest(); request.request_id = "rq_rich_roundtrip";
  const text = "# Report\n\n| A | B |\n|---|---|\n| x | y |\n\n" + "x".repeat(5000);
  const buttons = [[{ text: "Open", url: "https://example.com/report" }]];
  const captures: unknown[] = [];
  const server = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) captures.push(body); return { body: { status: "ok" } }; });
  const paired = relay(`${server.origin}/v1`);
  const fake = stub(`const a=process.argv.slice(2); const prompt=await Bun.stdin.text();
    const schema=JSON.parse(await Bun.file(a[a.indexOf('--output-schema')+1]).text());
    if (!prompt.includes('<format>') || !prompt.includes(${JSON.stringify(JSON.stringify(request.input.format))}) || !schema.properties.format || !schema.properties.buttons) process.exit(2);
    await Bun.write(a[a.indexOf('--output-last-message')+1], JSON.stringify(${JSON.stringify({action:"reply",text,reply_to:"m1",format:"rich_markdown",buttons})}));`);
  try {
    const result = await runClaimedRequest(paired, request, undefined, { command: fake });
    expect(result).toMatchObject({ outcome: "answered", answer: { text, format: "rich_markdown", buttons } });
    expect(captures).toEqual([result]);
  } finally { await server.close(); }
});

test("v2 invalid_format downgrades once while legacy completion retries stay unchanged", async () => {
  const bodies: unknown[] = [];
  const server = await startTestRelay((_req, body) => {
    bodies.push(body);
    return bodies.length === 1 ? { status: 422, body: { error: { code: "invalid_format" } } } : { body: {} };
  });
  try {
    const result = await completeRelayRequest(relay(`${server.origin}/v1`), "rq_rich_downgrade", { lease_id: sampleRequest.lease_id, outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: "# Short", reply_to: null, format: "rich_markdown", buttons: [] } }, () => Date.now() + 5000);
    expect(result.delivery).toBe("accepted");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ answer: { format: "plain", text: "# Short" } });
  } finally { await server.close(); }
});
test("invalid_format cannot downgrade an over-cap rich answer to plain",async()=>{
  const bodies:{answer?:Record<string,unknown>;outcome?:string}[]=[];
  const server=await startTestRelay((_req,body)=>{bodies.push(body as typeof bodies[number]);return bodies.length===1?{status:422,body:{error:{code:"invalid_format"}}}:{body:{}};});
  try {
    const result=await completeRelayRequest(relay(`${server.origin}/v1`),"rq_oversized_plain_fallback",{
      lease_id:sampleRequest.lease_id,outcome:"answered",duration_ms:1,
      answer:{action:"reply",text:"# Report\n\n"+"x".repeat(5000),reply_to:null,format:"rich_markdown",buttons:[]},
    },()=>Date.now()+5000);
    expect(result.body).toMatchObject({outcome:"failed",reason:"invalid_answer"});
    expect(bodies[1]).toMatchObject({outcome:"failed",reason:"invalid_answer"});
  }finally{await server.close();}
});

test("attachment readiness fallback preserves long rich text and URL buttons", async () => {
  const bodies: { answer?: Record<string, unknown> }[] = [];
  const server = await startTestRelay((_req, body) => {
    bodies.push(body as typeof bodies[number]);
    return bodies.length === 1 ? { status: 422, body: { error: { code: "attachment_not_ready" } } } : { body: {} };
  });
  const buttons = [[{ text: "Open", url: "https://example.com/" }]];
  try {
    const result = await completeRelayRequest(relay(`${server.origin}/v1`), "rq_attachment_downgrade", {
      lease_id: sampleRequest.lease_id, outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: "# Report\n\n" + "x".repeat(5000), reply_to: null, format: "rich_markdown", buttons, attachments: [{ attachment_id: "a0-fixture", kind: "document" }] },
    }, () => Date.now() + 5000);
    expect(result.delivery).toBe("accepted");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.answer).toMatchObject({ format: "rich_markdown", buttons, text: bodies[0]?.answer?.text });
    expect(bodies[1]?.answer?.attachments ?? []).toEqual([]);
  } finally { await server.close(); }
});

test("already_completed conflict refuses a changed completion body", async () => {
  const bodies: unknown[] = [];
  const server = await startTestRelay((_req, body) => {
    bodies.push(body);
    return { status: 409, body: { error: { code: "already_completed" } } };
  });
  try {
    const result = await completeRelayRequest(relay(`${server.origin}/v1`), "rq_changed_completion", {
      lease_id: sampleRequest.lease_id, outcome: "answered", duration_ms: 1,
      answer: { action: "reply", text: "changed body", reply_to: null, format: "rich_markdown", buttons: [] },
    }, () => Date.now() + 5000);
    expect(result).toMatchObject({ delivery: "refused", body: { outcome: "failed", reason: "invalid_answer" } });
    expect(bodies).toHaveLength(1);
  } finally { await server.close(); }
});
test("the identical rich completion is accepted after a lost acknowledgement",async()=>{
  const bodies:unknown[]=[];
  const server=await startTestRelay((_req,body)=>{bodies.push(body);return bodies.length===1?{drop:true}:{body:{}};});
  const completion={lease_id:sampleRequest.lease_id,outcome:"answered" as const,duration_ms:1,
    answer:{action:"reply" as const,text:"# Same",reply_to:null,format:"rich_markdown" as const,buttons:[]}};
  try {
    const result=await completeRelayRequest(relay(`${server.origin}/v1`),"rq_identical_rich",completion,()=>Date.now()+5000);
    expect(result.delivery).toBe("accepted");expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);
  } finally {await server.close();}
});


test.each(["ok","lease_lost","refused","media_only_refused","outside","ignore"])("negotiated generated attachment crosses runner and upload (%s)", async mode => {
  const { richRequest } = await import("./rich.fixture");
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer();
  const request=richRequest(true); request.request_id=`rq_image_${mode}`;
  const sent: unknown[]=[]; let puts=0;
  const server=await startTestRelay((req,body)=>{
    if(req.method==="PUT") {
      puts++;
      expect(body).toEqual(bytes);
      expect(req.headers["delegatus-relay-lease"]).toBe(request.lease_id);
      if(mode==="lease_lost") return {status:409,body:{error:{code:"lease_lost"}}};
      if(mode.includes("refused")) return {status:415,body:{error:{code:"unsupported_media_type"}}};
      return {status:201,body:{attachment_id:req.url!.split("/").at(-1),mime_type:"image/png",filename:"exec-1.png",sha256:req.headers["delegatus-relay-sha256"],byte_size:bytes.length,expires_at:new Date(Date.now()+60_000).toISOString()}};
    }
    if(req.url?.endsWith("/complete")) sent.push(body);
    return {body:{status:"ok"}};
  });
  let seenRunDir="";
  const marker=path.join(root,`image-home-${mode}`);
  const command=stub(`import fs from 'node:fs'; import path from 'node:path';
    const a=process.argv.slice(2),out=a[a.indexOf('--output-last-message')+1];
    await Bun.stdin.text();
    const dir=path.join(process.env.CODEX_HOME,'generated_images','thread_image');fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,'exec-1.png');fs.writeFileSync(file,Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64'));
    await Bun.write(${JSON.stringify(marker)},path.dirname(out));
    console.log(JSON.stringify({type:'thread.started',thread_id:'thread_image'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'image_generation_call'}}));
    await Bun.write(out,JSON.stringify({action:${JSON.stringify(mode==="ignore"?"ignore":"reply")},text:${JSON.stringify(mode==="media_only_refused"?"":"Picture")},reply_to:'m1',format:'plain',buttons:[],attachments:[{path:${mode==="outside"?JSON.stringify(path.join(root,"outside.png")):"file"},kind:'photo',caption:'Picture'}]}));`);
  const paired=relay(`${server.origin}/v1`);
  try {
    const result=await runClaimedRequest(paired,request,undefined,{command});
    seenRunDir=fs.readFileSync(marker,"utf8");
    if(mode==="lease_lost") {expect(result).toBeNull();expect(sent).toEqual([]);}
    else if(mode==="media_only_refused") expect(result).toMatchObject({outcome:"failed",reason:"invalid_answer"});
    else if(mode==="ignore") expect(result).toMatchObject({outcome:"answered",answer:{action:"ignore",text:"",format:"plain",buttons:[]}});
    else if(mode==="refused") expect(result).toMatchObject({outcome:"failed",reason:"invalid_answer"});
    else if(mode==="outside") {expect(result).toMatchObject({outcome:"answered"});expect(result && "answer" in result ? result.answer.attachments??[]:[]).toEqual([]);}
    else {expect(result).toMatchObject({outcome:"answered",answer:{attachments:[{kind:"photo",caption:"Picture"}]}});}
    expect(puts).toBe(mode==="outside" || mode==="ignore"?0:1);
    expect(fs.existsSync(seenRunDir)).toBe(false);
    const record=readAnswerRecord(paired.id,request.target_id,request.request_id);
    expect(record).toHaveProperty("features",request.features);
    expect(JSON.stringify(record)).not.toContain(seenRunDir);
    if(mode==="outside") expect(record).toHaveProperty("drops",[{part:"attachment",index:0,reason:"outside_run"}]);
    if(mode.includes("refused")) expect(record).toHaveProperty("drops",[{part:"attachment",reason:"unsupported_media_type"},...(mode==="refused"?[{part:"answer",reason:"attachment_not_ready"}]:[])]);
  } finally {await server.close();}
});


test.each(["claude","codex"])("owner %s returns rich text, buttons and a document through the real MCP binding", async engine=>{
  const { richRequest }=await import("./rich.fixture");
  const { viewerMcpBindings, productionDomainDependencies }=await import("@/lib/mcp/bindings");
  const ownerHome=fs.mkdtempSync(path.join("/tmp","relay-rich-owner-"));
  fs.mkdirSync(path.join(ownerHome,"handoff")); const file=path.join(ownerHome,"handoff","report.md");fs.writeFileSync(file,"# Report");
  const oldHome=process.env.HOME, oldState=process.env.LLV_STATE_DIR; process.env.HOME=ownerHome; process.env.LLV_STATE_DIR=path.join(ownerHome,"state");
  const request=richRequest(true);request.request_id=`rq_owner_rich_${engine}`;
  request.input.requester={key:"u1",is_owner:true,is_admin:true,is_anonymous_admin:false,can_delete_messages:true,can_restrict_members:true};
  const events:string[]=[];
  const server=await startTestRelay((req)=>{
    if(req.method==="PUT") {events.push("upload");return {status:201,body:{attachment_id:req.url!.split("/").at(-1),mime_type:"text/markdown",filename:"report.md",byte_size:8,sha256:req.headers["delegatus-relay-sha256"],expires_at:new Date(Date.now()+60_000).toISOString()}};}
    if(req.url?.endsWith("/complete"))events.push("complete");
    return {body:{status:"ok"}};
  });
  const paired=relay(`${server.origin}/v1`);paired.targets[0]={...paired.targets[0]!,ownerTier:true,engine};
  updateRelayStore(s=>({...s,relays:[paired]}));
  const conversationId=`conversation_owner_rich_${engine}`;
  const binding=(via?:{deputy:string},kind="agent")=>viewerMcpBindings(undefined,{get:async()=>({}),post:async()=>({})},{...productionDomainDependencies,callerAttribution:()=>({kind,conversationId,role:null,...(via?{via}:{})})} as never);
  const own=binding();let observedError:unknown;
  const text=("# Report\n\n"+"Long report. ".repeat(500)).trimEnd();
  try {
    const result=await runClaimedRequest(paired,request,undefined,{timeoutMs:10000,ownerPorts:{
      launch:async body=>{expect(body.prompt).toContain("<format>");expect(body.prompt).toContain("relay_answer");return {status:202,body:{conversationId}};},
      observe:async()=>{
        try{
          await expect(binding({deputy:"seat"}).relay_answer({format:"rich_markdown"})).rejects.toMatchObject({details:{code:"relay_answer_unavailable"}});
          await expect(binding(undefined,"voice-gateway").relay_answer({format:"rich_markdown"})).rejects.toMatchObject({details:{code:"relay_answer_unavailable"}});
          await own.relay_answer({format:"rich_markdown",mentions:[{author_key:"u1",offset:2,length:6}],buttons:[[{text:"Open",url:"https://example.com/report"}]],attachments:[{path:file,kind:"document",caption:"Report"}]});
        }catch(error){observedError=error;}
        return {state:"ended",finalText:text};
      },stop:async()=>{},pollMs:1}});
    if(observedError)throw observedError;
    expect(result).toMatchObject({outcome:"answered",answer:{text,format:"rich_markdown",mentions:[{author_key:"u1",offset:2,length:6}],buttons:[[{text:"Open"}]],attachments:[{kind:"document",caption:"Report"}]}});
    expect(events).toEqual(["upload","complete"]);
    await expect(own.relay_answer({format:"plain"})).rejects.toMatchObject({details:{code:"relay_answer_unavailable"}});
  }finally{await server.close(); if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome; if(oldState===undefined)delete process.env.LLV_STATE_DIR;else process.env.LLV_STATE_DIR=oldState;fs.rmSync(ownerHome,{recursive:true,force:true});}
});


test("negotiated tool rounds reject plain over the cap and preserve their rich answer parts", async()=>{
  const {richRequest}=await import("./rich.fixture");
  const request=richRequest();request.input.tools=x1Request("member").input.tools;
  const rich=await runLoopCase({request,plan:`return round===1?{action:'call',text:'',reply_to:null,format:'plain',buttons:[],calls:[call('search_docs',{query:'x'})]}:{action:'reply',text:'# Result\\n\\n'+'Long text. '.repeat(500),reply_to:'m1',format:'rich_markdown',buttons:[[{text:'Open',url:'https://example.com/'}]]};`});
  expect(rich.completion).toMatchObject({outcome:"answered",answer:{format:"rich_markdown",buttons:[[{text:"Open"}]]}});
  expect(rich.rounds).toHaveLength(2);
  for(const round of rich.rounds) {expect(round.prompt).toContain("<format>");expect(round.schema.properties).toHaveProperty("format");}
  const plain=richRequest();plain.request_id="rq_plain_cap";
  const refused=await runLoopCase({request:plain,plan:`return {action:'reply',text:'x'.repeat(4001),reply_to:null,format:'plain',buttons:[]};`});
  expect(refused.completion).toMatchObject({outcome:"failed",reason:"invalid_answer"});
});
test.each([false, true])("owner reply chains reuse one conversation, learn bot answers and bind only the current authority (rich %s)", async rich => {
  const { liveOwnerRelayConversation, ownerRelayPayload } = await import("./ownerAuthority");
  const { relayServiceToolsOp } = await import("./ownerServiceTools");
  const { relayAnswerOp } = await import("./ownerAnswer");
  const { formatGuide } = await import("./rich.fixture");
  const text = rich ? "# Fixture answer\n\n" + "Fixture paragraph. ".repeat(300).trimEnd() : "Done";
  const buttons = [[{ text: "Open", url: "https://example.com/report" }]];
  const { readConversations } = await import("./conversations");
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  setRelaySwitch("chain_conversations", true);
  let launches = 0; const prompts: string[] = []; let current = "";
  const make = (n: number, parent: string | null, includeRoot = true) => {
    const message = (id: string, reply_to: string | null, self = false) => ({ ...contextRequest.input.conversation[0]!, id, reply_to,
      author: { key: self ? "fixture-bot" : contextRequest.input.requester.key, name: self ? "Assistant" : "Owner", self }, text: `Fixture turn ${id}` });
    return { ...contextRequest, ...(rich ? { features: ["relay_tool_calls", "relay_rich_messages"] } : {}), request_id: `chain-owner-${n}`, chat: { key: "fixture-owner-chain" }, answer: { max_chars: rich ? 32000 : 1000, progress: "none" as const }, input: {
      ...contextRequest.input, ...(rich ? { format: formatGuide } : {}), tools: ownerRequest().input.tools, instructions: "Static fixture instructions. ".repeat(1000), requester: { ...contextRequest.input.requester, is_owner: true },
      respond_to: `turn-${n}`, conversation: [ ...(includeRoot && n > 1 ? [message("turn-1", null), message("bot-1", "turn-1", true)] : []), message(`turn-${n}`, parent) ] } };
  };
  const ports: import("./ownerRun").OwnerRunPorts = {
    launch: async body => { launches++; prompts.push(String(body.prompt)); return { status: 202, body: { conversationId: "conversation_chain_fixture",
      launchId: "launch_chain_fixture", initialMessage: "delivered" } }; },
    continue: async (turn, prompt) => {
      prompts.push(prompt);
      expect(turn.clientAttemptId).toBe(`relay-owner-${current}`);
      expect(liveOwnerRelayConversation("conversation_chain_fixture")).toBe(true);
      expect(ownerRelayPayload("context", "conversation_chain_fixture")?.text).toContain(current.endsWith("2") ? "Fixture turn turn-2" : "Fixture turn turn-3");
      return { ok: true, structured: true, target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId };
    },
    observe: async () => {
      const listed = await relayServiceToolsOp("conversation_chain_fixture", { op: "list" });
      expect(listed).toHaveProperty("tools.0");
      if (rich) expect(await relayAnswerOp("conversation_chain_fixture", { format: "rich_markdown", buttons })).toMatchObject({ format: "rich_markdown", buttons });
      return { state: "ended", finalText: text };
    }, stop: async () => {}, pollMs: 1,
  };
  try {
    for (const n of [1, 2, 3]) {
      const request = make(n, n === 1 ? null : "bot-1", n < 3); current = request.request_id;
      expect(await runClaimedRequest(paired, request, undefined, { ownerPorts: ports })).toMatchObject({ outcome: "answered", answer: { text, ...(rich ? { format: "rich_markdown", buttons } : {}) } });
      if (n === 1) {
        const initial = readConversations()[0];
        expect(initial).toMatchObject({ conversationId: "conversation_chain_fixture",
          seen: expect.arrayContaining(request.input.conversation.map(message => message.id)), staticDigest: expect.any(String) });
        expect(initial?.pendingCursor).toBeUndefined();
      }
      expect(liveOwnerRelayConversation("conversation_chain_fixture")).toBe(false);
      expect(await relayServiceToolsOp("conversation_chain_fixture", { op: "list" })).toBeNull();
      expect(ownerRelayPayload("context", "conversation_chain_fixture")).toBeNull();
      expect(await relayAnswerOp("conversation_chain_fixture", { format: "plain" })).toBeNull();
    }
    expect(launches).toBe(1); expect(readConversations()).toHaveLength(1);
    expect(prompts[1]).not.toContain("<service_instructions>"); expect(prompts[1]).not.toContain("[You work for the owner");
    expect(prompts[1]).not.toContain('"id":"turn-1"');
    expect(Buffer.byteLength(prompts[1]!)).toBeLessThan(Buffer.byteLength(prompts[0]!) / 10);
    expect(readAnswerRecord(paired.id, "target_1", current)?.chain).toMatchObject({ continued: true, promptBytes: Buffer.byteLength(prompts[2]!) });
  } finally { await server.close(); }
});

test("owner continuation refusal revokes the old service-tool binding before fallback", async () => {
  const { productionDomainDependencies, viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const posts: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/tool-calls")) {
      const call = body as { call_id: string; tool: string };
      if ("describe" in (body as object)) {
        const lookupResults = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/service-wire/lookup_results.json"), "utf8"));
        return { body: { ...lookupResults.truncated, call_id: call.call_id } };
      }
      posts.push(body);
      return { body: { ...x1Results.action_ok, call_id: call.call_id, tool: call.tool } };
    }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] })); setRelaySwitch("chain_conversations", true);
  let callerConversationId = "";
  const bindings = viewerMcpBindings(undefined, { get: async () => ({}), post: async () => ({}) }, {
    ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "agent", conversationId: callerConversationId, role: null }),
  });
  const conversations = (turn: number) => {
    const message = (id: string, reply_to: string | null, self = false) => ({ ...contextRequest.input.conversation[0]!, id, reply_to,
      author: { key: self ? "fixture-bot" : contextRequest.input.requester.key, name: self ? "Assistant" : "Owner", self }, text: `Fixture turn ${id}` });
    const prior = turn > 1 ? [message("turn-1", null), message("bot-1", "turn-1", true)] : [];
    const beforeCurrent = turn > 2 ? [message("turn-2", "bot-1"), message("bot-2", "turn-2", true)] : [];
    return [...prior, ...beforeCurrent, message(`turn-${turn}`, turn === 1 ? null : `bot-${turn - 1}`)];
  };
  const make = (turn: number) => ({ ...contextRequest, request_id: `owner-binding-turn-${turn}`, chat: { key: "fixture-owner-binding-chain" },
    answer: { max_chars: 1000, progress: "none" as const }, input: { ...contextRequest.input, tools: ownerRequest().input.tools,
      requester: { ...contextRequest.input.requester, is_owner: true }, respond_to: `turn-${turn}`, conversation: conversations(turn) } });
  let launches = 0, continuationAttempts = 0, observeTurn = 0, staleRefused = false, staleWireCalls = 0;
  const accessMedia = async (id: string) => {
    callerConversationId = id;
    await bindings.relay_service_tools({ op: "describe", names: ["get_media"] });
    await bindings.relay_service_tools({ op: "call", calls: [{ tool: "get_media", arguments: {} }] });
  };
  const ports: import("./ownerRun").OwnerRunPorts = {
    launch: async () => ({ status: 202, body: { conversationId: `conversation_binding_${++launches}` } }),
    continue: async turn => {
      continuationAttempts++;
      if (continuationAttempts === 1) return { ok: false, structured: true, outcome: "failed", status: 409, admission: "refused",
        error: "the conversation cannot be resumed" };
      expect(turn.conversationId).toBe("conversation_binding_2");
      return { ok: true, structured: true, target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId };
    },
    observe: async () => {
      observeTurn++;
      if (observeTurn === 2) {
        callerConversationId = "conversation_binding_1";
        const postsBeforeStaleCall = posts.length;
        try {
          await bindings.relay_service_tools({ op: "describe", names: ["get_media"] });
          await bindings.relay_service_tools({ op: "call", calls: [{ tool: "get_media", arguments: {} }] });
        }
        catch (error) { staleRefused = (error as { details?: { code?: string } }).details?.code === "relay_tools_unavailable"; }
        staleWireCalls = posts.length - postsBeforeStaleCall;
        await accessMedia("conversation_binding_2");
      } else if (observeTurn === 3) {
        await accessMedia("conversation_binding_2");
      }
      return { state: "ended", finalText: "Done" };
    },
    stop: async () => {}, pollMs: 1,
  };
  try {
    expect((await runClaimedRequest(paired, make(1), undefined, { ownerPorts: ports }))?.outcome).toBe("answered");
    expect((await runClaimedRequest(paired, make(2), undefined, { ownerPorts: ports }))?.outcome).toBe("answered");
    expect(staleWireCalls).toBe(0); expect(staleRefused).toBe(true);
    expect((await runClaimedRequest(paired, make(3), undefined, { ownerPorts: ports }))?.outcome).toBe("answered");
    expect(launches).toBe(2); expect(continuationAttempts).toBe(2); expect(posts).toHaveLength(2);
  } finally { await server.close(); }
});

for (const refusal of ["busy", "unavailable", "accepted-failure"] as const) test(`owner chain continuation ${refusal} has no duplicate execution`, async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] })); setRelaySwitch("chain_conversations", true);
  let launches = 0, sends = 0;
  const first = { ...contextRequest, request_id: `chain-${refusal}-first`, chat: { key: "fixture-refusal-chain" },
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } };
  const ports: import("./ownerRun").OwnerRunPorts = {
    launch: async () => { launches++; return { status: 202, body: { conversationId: `conversation_${refusal}` } }; },
    continue: async turn => { sends++;
      if (refusal === "accepted-failure") return { ok: true, structured: true, target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId };
      return { ok: false, structured: true, outcome: "failed", status: 409, admission: "refused",
        error: refusal === "busy" ? "recipient is not ready for an idle continuation" : "the conversation cannot be resumed" };
    },
    observe: async turn => turn.continuation && refusal === "accepted-failure" ? { state: "failed" } : { state: "ended", finalText: "Done" },
    stop: async () => {}, pollMs: 1,
  };
  try {
    expect((await runClaimedRequest(paired, first, undefined, { ownerPorts: ports }))?.outcome).toBe("answered");
    const next = { ...first, request_id: `chain-${refusal}-next`, claimed_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 10200).toISOString(),
      input: { ...first.input, respond_to: "next", conversation: [{ ...first.input.conversation[0]!, id: "next", reply_to: first.input.respond_to }] } };
    const result = await runClaimedRequest(paired, next, undefined, { ownerPorts: ports });
    expect(result?.outcome).toBe(refusal === "busy" ? "declined" : refusal === "unavailable" ? "answered" : "failed");
    if (refusal === "busy") expect(result).toMatchObject({ reason: "busy", detail: "chat busy" });
    expect(launches).toBe(refusal === "unavailable" ? 2 : 1); expect(sends).toBe(1);
  } finally { await server.close(); }
});


test.each([0, 10000])("continued owner latency: five identical-input pairs (%s hashing passes)", async passes => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const fixture = requestSchema.parse(JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/service-wire/claimed_rc_owner.json"), "utf8")).request);
  const trigger = fixture.input.conversation.find(m => m.id === fixture.input.respond_to)!;
  const samples: { mode: string; promptBytes: number; deliveredMs: number; answerMs: number }[] = [];
  let promptBytes = 0, deliveredAt = 0, launches = 0, sends = 0;
  const engine = (prompt: string) => {
    promptBytes = Buffer.byteLength(prompt);
    // Same CPU work per prompt byte on both paths; no network/model or sleep.
    for (let i = 0; i < passes; i++) createHash("sha256").update(prompt).digest();
    deliveredAt = performance.now();
  };
  const ports: import("./ownerRun").OwnerRunPorts = {
    launch: async body => { launches++; engine(String(body.prompt)); return { status: 202, body: { conversationId: `conversation_latency_${launches}` } }; },
    continue: async (turn, prompt) => { sends++; engine(prompt); return { ok: true, structured: true, target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId }; },
    observe: async () => ({ state: "ended", finalText: "Done" }), stop: async () => {}, pollMs: 1,
  };
  try {
    for (let pair = 0; pair < 5; pair++) {
      const first = { ...fixture, request_id: `latency-prime-${pair}`, target_id: "target_1", chat: { key: `fixture-latency-chain-${pair}` }, answer: { max_chars: 1000, progress: "none" as const } };
      setRelaySwitch("chain_conversations", true);
      expect((await runClaimedRequest(paired, first, undefined, { ownerPorts: ports }))?.outcome).toBe("answered");
      const input = { ...first.input, respond_to: "latency-reply", conversation: [...first.input.conversation,
        { ...trigger, id: "latency-bot", author: { key: "fixture-bot", name: "Assistant", self: true }, reply_to: first.input.respond_to, text: "Done" },
        { ...trigger, id: "latency-reply", reply_to: "latency-bot", text: "Continue the fixture" }] };
      for (const mode of pair % 2 ? ["continued", "fresh"] : ["fresh", "continued"]) {
        setRelaySwitch("chain_conversations", mode === "continued");
        const started = performance.now();
        const completion = await runClaimedRequest(paired, { ...first, request_id: `latency-${pair}-${mode}`, input }, undefined, { ownerPorts: ports });
        const answerMs = performance.now() - started;
        expect(completion?.outcome).toBe("answered");
        samples.push({ mode, promptBytes, deliveredMs: deliveredAt - started, answerMs });
      }
    }
    expect(launches).toBe(10); expect(sends).toBe(5);
    const median = (values: number[]) => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)]!;
    const variability = (values: number[]) => ({ rangeMs: Math.max(...values) - Math.min(...values),
      medianAbsoluteDeviationMs: median(values.map(value => Math.abs(value - median(values)))) });
    const fresh = samples.filter(s => s.mode === "fresh"), continued = samples.filter(s => s.mode === "continued");
    expect(median(continued.map(s => s.promptBytes))).toBeLessThan(median(fresh.map(s => s.promptBytes)) / 10);
    const measurement = { engine: `SHA256 ${passes} passes per prompt; alternating pair order`, load: os.loadavg(), samples,
      medians: { freshMs: median(fresh.map(s => s.answerMs)), continuedMs: median(continued.map(s => s.answerMs)) },
      variability: { fresh: variability(fresh.map(s => s.answerMs)), continued: variability(continued.map(s => s.answerMs)) } };
    console.log("RELAY_LATENCY", JSON.stringify(measurement));
    if (process.env.LLV_RELAY_LATENCY_OUTPUT) fs.writeFileSync(`${process.env.LLV_RELAY_LATENCY_OUTPUT}-${passes}.json`, JSON.stringify(measurement, null, 2) + "\n");
  } finally { setRelaySwitch("chain_conversations", true); await server.close(); }
}, 30000);


test("a chain tool loop resumes its session and sends only each new result batch", async () => {
  const run = await runLoopCase({ chainConversations: true, role: "actions_admin",
    plan: `return round<=2?{action:'call',text:'',reply_to:null,calls:[call('react_to_message',{}),call('react_to_message',{})]}:reply;`,
    response: body => actionResponse("action_ok", body) });
  expect(run.completion).toMatchObject({ outcome: "answered" });
  expect(run.calls).toHaveLength(1); expect(run.rounds).toHaveLength(3);
  expect(run.record?.chain).toMatchObject({ continued: false, promptBytes: run.rounds.reduce((sum: number, round: { prompt: string }) => sum + Buffer.byteLength(round.prompt), 0) });
  expect(run.rounds[1].prompt).not.toContain("<conversation>\n");
  expect(run.rounds[2].prompt).not.toContain("<service_instructions>");
  expect(projectionsOf(run, 1)).toHaveLength(1); expect(projectionsOf(run, 2)).toHaveLength(0);
});


test("owner pins survive member subthreads and refuse another chat or requester", async () => {
  const { readConversations } = await import("./conversations");
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  paired.targets[0]!.memberLimitPerHour = null;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  let launches = 0; const deliveries: string[] = [];
  const ports: import("./ownerRun").OwnerRunPorts = {
    launch: async () => ({ status: 202, body: { conversationId: `conversation_scope_${++launches}` } }),
    continue: async turn => { deliveries.push(turn.conversationId!); return { ok: true, structured: true,
      target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId }; },
    observe: async () => ({ state: "ended", finalText: "Done" }), stop: async () => {}, pollMs: 1,
  };
  const command = stub(`const args=process.argv.slice(2);await Bun.stdin.text();await Bun.write(args[args.indexOf('--output-last-message')+1],JSON.stringify({action:"reply",text:"Done",reply_to:null}));`);
  const make = (id: string, parent: string | null, owner: boolean, key = "fixture-owner") => ({ ...contextRequest,
    request_id: `scope-${id}`, chat: { key: "fixture-scope-chat" }, answer: { max_chars: 1000, progress: "none" as const },
    input: { ...contextRequest.input, tools: [], respond_to: id,
      requester: { ...contextRequest.input.requester, key, is_owner: owner, is_admin: false },
      conversation: [{ ...contextRequest.input.conversation[0]!, id, reply_to: parent, text: "Fixture request", author: { key, name: "Requester", self: false } }] } });
  try {
    const first = make("owner-root", null, true);
    expect((await runClaimedRequest(paired, first, undefined, { ownerPorts: ports, command }))?.outcome).toBe("answered");
    const bot = { ...first.input.conversation[0]!, id: "owner-bot", reply_to: "owner-root", author: { key: "fixture-bot", name: "Assistant", self: true } };
    const member = make("member-reply", "owner-bot", false, "fixture-member");
    member.input.conversation.unshift(...first.input.conversation, bot);
    expect((await runClaimedRequest(paired, member, undefined, { ownerPorts: ports, command }))?.outcome).toBe("answered");
    expect(deliveries).toEqual([]); expect(launches).toBe(1);
    expect(readConversations().map(row => row.authority).sort()).toEqual(["member", "owner-tier"]);
    const next = make("owner-reply", "member-reply", true);
    next.input.conversation.unshift(...member.input.conversation);
    expect((await runClaimedRequest(paired, next, undefined, { ownerPorts: ports, command }))?.outcome).toBe("answered");
    expect(deliveries).toEqual(["conversation_scope_1"]); expect(launches).toBe(1);
    const otherChat = make("other-chat", "owner-root", true); otherChat.chat.key = "fixture-other-chat";
    const otherRequester = make("other-requester", "owner-root", true, "fixture-another-owner");
    for (const request of [otherChat, otherRequester])
      expect((await runClaimedRequest(paired, request, undefined, { ownerPorts: ports, command }))?.outcome).toBe("answered");
    expect(deliveries).toEqual(["conversation_scope_1"]); expect(launches).toBe(3);
  } finally { await server.close(); }
});

test("a member on-demand claim is filled before the first round and still calls its read", async () => {
  const full = x1Request("member");
  const request = structuredClone(full);
  request.request_id = "member_on_demand";
  request.input.tools = request.input.tools!.map(tool => tool.mode === "direct" ? { ...tool, parameters: undefined, spec: "0123456789abcdef" } : tool);
  request.input.tool_guidance = null;
  const run = await runLoopCase({ request, features: ["relay_tool_calls", "relay_tools_on_demand"], response: body => {
    if ("describe" in body) return { body: { ...x1Results.ok, call_id: body.call_id, tool: "", tools: full.input.tools!.filter(tool => tool.mode === "direct"),
      guidance: [{ tools: ["search_docs"], text: "Search the advertised documents." }] } };
    return { body: { ...x1Results.ok, call_id: body.call_id } };
  } });
  expect(run.completion).toMatchObject({ outcome: "answered" });
  expect(run.calls).toHaveLength(2);
  expect(run.calls[0]).toHaveProperty("describe");
  expect(run.calls[1]).toHaveProperty("tool", "search_docs");
  expect(run.rounds[0].prompt).toContain("parameters");
  expect(run.rounds[0].prompt).toContain("Search the advertised documents.");
});


test("owner tool lease loss interrupts the owner and completes nothing", async () => {
  const { productionDomainDependencies, viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const request = requestSchema.parse(contextRequest);
  request.request_id = "owner_tool_lease_loss"; request.input.requester!.is_owner = true;
  request.input.tools = ownerRequest().input.tools;
  const stops: string[] = []; let posts = 0, observed = false;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/tool-calls")) { posts++; return { status: 409, body: { error: { code: "lease_lost" } } }; }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.ownerTier = true;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const bindings = viewerMcpBindings(undefined, { get: async () => ({}), post: async () => ({}) }, {
    ...productionDomainDependencies, callerAttribution: () => ({ kind: "agent", conversationId: "conversation_owner_lease_loss", role: null }),
  });
  try {
    const result = await runClaimedRequest(paired, request, undefined, { command: "/missing-owner-cli", timeoutMs: 5000, ownerPorts: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_owner_lease_loss" } }),
      observe: async () => {
        if (!observed) { observed = true; await bindings.relay_service_tools({ op: "call", calls: [{ tool: "get_media", arguments: {} }] }); }
        return { state: stops.length ? "ended" : "running" };
      }, stop: async (_id, action) => { stops.push(action); }, pollMs: 1,
    } });
    expect(result).toBeNull(); expect(stops).toEqual(["interrupt"]); expect(posts).toBe(1);
    await expect(bindings.relay_service_tools({ op: "list" })).rejects.toMatchObject({ details: { code: "relay_tools_unavailable" } });
    expect(posts).toBe(1);
  } finally { await server.close(); }
});

test("typed mentions cross the restricted runner without source rewriting", async () => {
  const { richRequest } = await import("./rich.fixture");
  const request = richRequest(); request.request_id = "request_typed_mentions";
  const key = request.input.conversation[0]!.author.key;
  const answer = { action: "reply", text: "😀 Person", reply_to: null, format: "rich_markdown", buttons: [], mentions: [{ author_key: key, offset: 2, length: 6 }] };
  const captures: unknown[] = [];
  const server = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) captures.push(body); return { body: { status: "ok" } }; });
  const fake = stub(`const a=process.argv.slice(2);await Bun.stdin.text();await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify(${JSON.stringify(answer)}));`);
  try {
    const result = await runClaimedRequest(relay(`${server.origin}/v1`), request, undefined, { command: fake });
    expect(result).toMatchObject({ outcome: "answered", answer }); expect(captures).toEqual([result]);
  } finally { await server.close(); }
});

test("inbound lease loss stops the runner without completion or agent launch", async () => {
  const { richRequest } = await import("./rich.fixture");
  const request = richRequest(true); request.request_id = "inbound_lease_lost";
  request.features!.push("requester_context", "relay_media_in");
  request.input.conversation[0]!.media = [{ ref: "lost_media", kind: "document", availability: "ready", mime_type: "text/plain", byte_size: 5,
    filename: "input.txt", expires_at: "2099-01-01T00:00:00Z" }];
  const completions: unknown[] = [];
  const server = await startTestRelay(req => {
    if (req.url?.endsWith("/media/lost_media")) return { status: 409, body: { error: { code: "lease_lost", message: "gone" } } };
    if (req.url?.endsWith("/complete")) completions.push(req);
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`);
  const marker = path.join(root, "inbound-agent-launched");
  const fake = stub(`await Bun.stdin.text(); await Bun.write(${JSON.stringify(marker)}, "launched");`);
  try {
    const result = await runClaimedRequest(paired, request, undefined, { command: fake });
    expect(result).toBeNull();
    expect(completions).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readAnswerRecord(paired.id, "target_1", request.request_id)).toMatchObject({ state: "finished", outcome: "lease_lost", delivery: null });
  } finally { await server.close(); }
});

test("lease loss during an active inbound stream stops consumption before agent launch", async () => {
  const { richRequest } = await import("./rich.fixture");
  const request = richRequest(true); request.request_id = "inbound_stream_lease_lost";
  request.features!.push("requester_context", "relay_media_in");
  request.liveness.heartbeat_interval_s = 2;
  request.input.conversation[0]!.media = [{ ref: "stream_media", kind: "document", availability: "ready", mime_type: "text/plain", byte_size: 20 * 1024 * 1024,
    filename: "input.txt", expires_at: "2099-01-01T00:00:00Z" }];
  let partialWritten!: () => void, lostLease!: () => void;
  const partial = new Promise<void>(resolve => { partialWritten = resolve; });
  const heartbeatLost = new Promise<void>(resolve => { lostLease = resolve; });
  let completions = 0, bytesSent = 0;
  const nativeServer = http.createServer(async (req, response) => {
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) bodyChunks.push(Buffer.from(chunk));
    const body = Buffer.concat(bodyChunks).toString("utf8");
    if (req.url?.endsWith("/heartbeat") && (JSON.parse(body) as { seq: number }).seq > 1) {
      lostLease(); response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "lease_lost", message: "gone" } })); return;
    }
    if (req.url?.endsWith("/media/stream_media")) {
      response.writeHead(200, { "content-type": "text/plain", "content-length": String(20 * 1024 * 1024) });
      const first = Buffer.alloc(65536, 120); response.write(first); bytesSent += first.length; partialWritten();
      await heartbeatLost;
      if (!response.destroyed) response.end(Buffer.alloc(65536, 120));
      return;
    }
    if (req.url?.endsWith("/complete")) completions++;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>(resolve => nativeServer.listen(0, "127.0.0.1", resolve));
  const address = nativeServer.address(); if (!address || typeof address === "string") throw new Error("missing port");
  const marker = path.join(root, "inbound-stream-agent-launched");
  const fake = stub(`await Bun.stdin.text(); await Bun.write(${JSON.stringify(marker)}, "launched");`);
  try {
    const running = runClaimedRequest(relay(`http://127.0.0.1:${address.port}/v1`), request, undefined, { command: fake });
    await partial;
    const result = await running;
    expect(result).toBeNull();
    expect(bytesSent).toBeLessThan(20 * 1024 * 1024);
    expect(completions).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readAnswerRecord(relay(`http://127.0.0.1:${address.port}/v1`).id, "target_1", request.request_id)).toMatchObject({ state: "finished", outcome: "lease_lost", delivery: null });
  } finally {
    lostLease(); nativeServer.closeAllConnections(); await new Promise<void>(resolve => nativeServer.close(() => resolve()));
  }
});

test.each(["codex", "claude"])("inbound originals reach the %s native image input and are removed after the answer", async engine => {
  const { richRequest } = await import("./rich.fixture");
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const request = richRequest(true); request.request_id = `inbound_original_${engine}`;
  const { RELAY_MEDIA_ANY_DOCUMENT } = await import("./mediaInputValidation");
  request.features!.push("requester_context", "relay_media_in", RELAY_MEDIA_ANY_DOCUMENT);
  request.input.conversation[0]!.media = [{ ref: "inbound_photo", kind: "photo", availability: "ready", mime_type: "image/png", byte_size: bytes.length, expires_at: "2099-01-01T00:00:00Z" }];
  let downloads = 0;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/media/inbound_photo")) {
      downloads++; expect(req.headers["delegatus-relay-lease"]).toBe(request.lease_id);
      return { raw: bytes, headers: { "content-type": "image/png", "content-length": String(bytes.length) } };
    }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.engine = engine;
  const marker = path.join(root, `inbound-path-${engine}`);
  const fake = stub(`const a=process.argv.slice(2), input=await Bun.stdin.text();
    const prompt=${engine === "claude" ? "JSON.parse(input).message.content.find(p=>p.type==='text').text" : "input"};
    const media=JSON.parse(prompt.split('<inbound_media>')[1].split('</inbound_media>')[0]);
    if(await Bun.file(media[0].local_path).size!==${bytes.length})process.exit(2);
    await Bun.write(${JSON.stringify(marker)},media[0].local_path);
    const answer={action:'reply',text:'Photo received',reply_to:null,format:'plain',buttons:[],mentions:[],attachments:[]};
    if(a.includes('--output-last-message')) {
      if(!a.includes('--image')||!a.includes(media[0].local_path))process.exit(3);
      await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify(answer));
    }else{
      const frame=JSON.parse(input); if(frame.message.content.find(p=>p.type==='image').source.data!==${JSON.stringify(bytes.toString("base64"))})process.exit(4);
      console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput','WebSearch'],mcp_servers:[]}));
      console.log(JSON.stringify({type:'result',subtype:'success',structured_output:answer}));
    }`);
  try {
    const result = await runClaimedRequest(paired, request, undefined, { command: fake });
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "Photo received" } });
    expect(downloads).toBe(1); expect(fs.existsSync(fs.readFileSync(marker, "utf8"))).toBe(false);
  } finally { await server.close(); }
});
test.each([["codex", false], ["claude", false], ["codex", true], ["claude", true]] as const)("any-document originals reach the %s agent and are removed at run end (agent failure=%s)", async (engine, failAgent) => {
  const { richRequest } = await import("./rich.fixture");
  const { RELAY_MEDIA_ANY_DOCUMENT } = await import("./mediaInputValidation");
  const bytes = Buffer.from([80, 75, 0, 255]);
  const request = richRequest(true); request.request_id = `inbound_document_${engine}_${failAgent}`;
  request.features!.push("requester_context", "relay_media_in", RELAY_MEDIA_ANY_DOCUMENT);
  const items = [
    { ref: "sheet", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "budget.xlsx" },
    { ref: "drawing", mime_type: "image/svg+xml", filename: "drawing.svg" },
  ];
  request.input.conversation[0]!.media = items.map(item => ({ ...item, kind: "document", availability: "ready", byte_size: bytes.length, expires_at: "2099-01-01T00:00:00Z" }));
  let downloads = 0;
  const server = await startTestRelay(req => {
    const item = items.find(item => req.url?.endsWith(`/media/${item.ref}`));
    if (item) {
      downloads++; expect(req.headers["delegatus-relay-lease"]).toBe(request.lease_id);
      return { raw: bytes, headers: { "content-type": item.mime_type, "content-length": String(bytes.length) } };
    }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${server.origin}/v1`); paired.targets[0]!.engine = engine;
  const marker = path.join(root, `inbound-document-path-${engine}-${failAgent}`);
  const fake = stub(`const {basename}=await import('node:path'); const a=process.argv.slice(2), prompt=await Bun.stdin.text();
    const media=JSON.parse(prompt.split('<inbound_media>')[1].split('</inbound_media>')[0]);
    if(a.includes('--image')||(a.includes('--input-format')&&a[a.indexOf('--input-format')+1]==='stream-json'))process.exit(2);
    for(const file of media){
      if(basename(file.local_path)!==file.filename||file.byte_size!==4)process.exit(3);
      if(Buffer.from(await Bun.file(file.local_path).arrayBuffer()).toString('hex')!=='504b00ff')process.exit(4);
    }
    await Bun.write(${JSON.stringify(marker)},JSON.stringify(media));
    if(${failAgent})process.exit(1);
    const answer={action:'reply',text:'Documents received',reply_to:null,format:'plain',buttons:[],mentions:[],attachments:[]};
    if(a.includes('--output-last-message'))await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify(answer));
    else{
      console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput','WebSearch'],mcp_servers:[]}));
      console.log(JSON.stringify({type:'result',subtype:'success',structured_output:answer}));
    }`);
  try {
    const result = await runClaimedRequest(paired, request, undefined, { command: fake });
    expect(result).toMatchObject(failAgent ? { outcome: "failed" } : { outcome: "answered", answer: { text: "Documents received" } });
    expect(downloads).toBe(2);
    const media = JSON.parse(fs.readFileSync(marker, "utf8")) as { local_path: string; filename: string; mime_type: string }[];
    expect(media.map(item => ({ filename: item.filename, mime_type: item.mime_type }))).toEqual(items.map(({ filename, mime_type }) => ({ filename, mime_type })));
    for (const item of media) { expect(fs.existsSync(item.local_path)).toBe(false); expect(fs.existsSync(path.dirname(item.local_path))).toBe(false); }
  } finally { await server.close(); }
});
test.each(["mention", "photo"])("v2 %s contract refusal remains decisive without a changed completion", async kind => {
  const bodies: unknown[] = [];
  const server = await startTestRelay((_req, body) => { bodies.push(body); return { status: kind === "mention" ? 400 : 422, body: { error: { code: kind === "mention" ? "malformed" : "attachment_not_ready" } } }; });
  const body = { lease_id: sampleRequest.lease_id, outcome: "answered" as const, duration_ms: 1, answer: { action: "reply" as const, text: "Person", reply_to: null, format: "rich_markdown" as const,
    ...(kind === "mention" ? { mentions: [{ author_key: "foreign", offset: 0, length: 6 }] } : { attachments: [{ attachment_id: "missing", kind: "photo" as const }] }) } };
  try {
    expect(await completeRelayRequest(relay(`${server.origin}/v1`), "refused_composition", body, () => Date.now() + 5000)).toEqual({ body, delivery: "refused" });
    expect(bodies).toEqual([body]);
  } finally { await server.close(); }
});
