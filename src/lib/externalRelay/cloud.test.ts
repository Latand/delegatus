import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { newTargetSettings } from "./store";

test("new relay targets use Codex Cloud without local account admission", () => {
  expect(newTargetSettings({ target_id: "target", name: "Support", answered_by: "install", fallback: "service" })).toMatchObject({
    engine: "codex-cloud", model: "gpt-6.1-sol",
  });
});

import { createCloudTransport, CloudFailure, cloudEnvironment, runCloudRelay } from "./cloud";
import type { EphemeralAgentRun } from "@/lib/agent/ephemeral";
const localRun = (): EphemeralAgentRun => ({ pid: null, identity: null, cancel() {}, done: Promise.resolve({ status: "done", answer: { action: "reply", text: "local" }, durationMs: 0, code: 0, signal: null }) });

test("Cloud answer uses the composed input and never starts a local agent", async () => {
  let local = 0;
  const prompt = "<requester>rights</requester><short_term_memory>memory</short_term_memory><tools>index</tools>";
  const run = runCloudRelay({ prompt, environmentId: "answer-env", fullAccess: false, timeoutMs: 1000,
    transport: async input => { expect(input.prompt).toBe(prompt); expect(input.fullAccess).toBe(false); return '{"action":"reply","text":"cloud"}'; },
    local: async () => { local++; return localRun(); } });
  expect((await run.done).answer).toEqual({ action: "reply", text: "cloud" });
  expect(local).toBe(0);
});

test("confirmed Cloud limit failure falls back to local exactly once", async () => {
  let cloud = 0, local = 0;
  const run = runCloudRelay({ prompt: "question", environmentId: "answer-env", fullAccess: false, timeoutMs: 1000,
    transport: async () => { cloud++; throw new CloudFailure(true); }, local: async () => { local++; return localRun(); } });
  expect((await run.done).answer).toEqual({ action: "reply", text: "local" });
  expect({ cloud, local }).toEqual({ cloud: 1, local: 1 });
});

test("unconfirmed Cloud execution never duplicates an owner task locally", async () => {
  let local = 0;
  const run = runCloudRelay({ prompt: "task", environmentId: "repo-env", fullAccess: true, timeoutMs: 1000,
    transport: async () => { throw new CloudFailure(false); }, local: async () => { local++; return localRun(); } });
  await expect(run.done).rejects.toThrow("Codex Cloud unavailable");
  expect(local).toBe(0);
});

test("owner full-agent Cloud thread chooses the repository environment", async () => {
  const previous = process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS;
  process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS = JSON.stringify({ repository: "repo-env" });
  try {
    const environmentId = cloudEnvironment({ project: "repository", cloudEnvironmentId: "answer-env" })!;
    const run = runCloudRelay({ prompt: "owner task", environmentId, fullAccess: true, timeoutMs: 1000,
      transport: async input => { expect(input.environmentId).toBe("repo-env"); expect(input.fullAccess).toBe(true); return '{"action":"reply","text":"done"}'; }, local: async () => localRun() });
    expect((await run.done).status).toBe("done");
  } finally {
    if (previous === undefined) delete process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS; else process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS = previous;
  }
});

import { spyOn } from "bun:test";
import { accountManager } from "@/lib/accounts/manager";
import { runClaimedRequest } from "./runner";
import { updateRelayStore, type PairedRelay } from "./store";
import { contextRequest } from "./request.fixture";
import { startTestRelay } from "./testRelay";
import { readAnswerRecord } from "./answers";
import { answerPrompt } from "./prompt";
import { requestSchema } from "./protocol";

test("Cloud answer is delivered through the relay with unchanged protocol steps and history", async () => {
  const beats: Array<{ seq: number; progress: { label: string } | null }> = [];
  const server = await startTestRelay((request, body) => {
    if (request.url?.endsWith("/heartbeat")) beats.push(body as typeof beats[number]);
    return { body: { status: "ok" } };
  });
  const relay: PairedRelay = { id: "cloud_relay", origin: server.origin, api_base: server.origin + "/v1", name: "Relay", description: "Relay", credential: "fixture",
    owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null }, pairedAt: new Date().toISOString(), paused: false,
    features: ["progress_steps"], limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "codex-cloud", model: "gpt-6.1-sol", effort: null,
      project: null, cloudEnvironmentId: "answer-env", concurrency: 1, hardCapMinutes: 1 }] };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const select = spyOn(accountManager, "resolveHeadlessSpawn").mockImplementation(() => { throw new Error("local admission must not run"); });
  const raw = { ...contextRequest, request_id: "cloud_delivery", input: { ...contextRequest.input, tools: [] } };
  try {
    const result = await runClaimedRequest(relay, raw, undefined, { leaseWorker: false, cloudTransport: async input => {
      expect(input.prompt).toBe(answerPrompt(requestSchema.parse(raw), "codex"));
      await new Promise(resolve => setTimeout(resolve, 3400));
      input.onProgress?.({ queued: true });
      await new Promise(resolve => setTimeout(resolve, 3400));
      input.onProgress?.({});
      await new Promise(resolve => setTimeout(resolve, 3400));
      input.onProgress?.({ writingAnswer: true });
      await new Promise(resolve => setTimeout(resolve, 3400));
      return JSON.stringify({ action: "reply", text: "Cloud answer", reply_to: "m1" });
    } });
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "Cloud answer" } });
    expect(beats.map(beat => beat.progress?.label)).toEqual(expect.arrayContaining(["accepted", "queued", "thinking", "writing_answer"]));
    for (const beat of beats) expect(Object.keys(beat)).toEqual(["lease_id", "seq", "progress"]);
    expect(beats.map(beat => beat.seq)).toEqual(beats.map((_, i) => i + 1));
    expect(readAnswerRecord(relay.id, "target_1", "cloud_delivery")).toMatchObject({ engine: "codex-cloud", outcome: "answered", delivery: "accepted" });
    expect(select).not.toHaveBeenCalled();
  } finally { select.mockRestore(); await server.close(); }
}, 20000);

test("Cloud WebSocket starts a current thread and sends the exact text", async () => {
  const oldUrl = process.env.LLV_CODEX_CLOUD_URL;
  process.env.LLV_CODEX_CLOUD_URL = "wss://example.invalid/app-server";
  const events = new EventEmitter();
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const emit = (value: unknown) => events.emit("message", JSON.stringify(value));
  const transport = createCloudTransport(() => {
    queueMicrotask(() => events.emit("open"));
    return {
      on: events.on.bind(events), close() {},
      send(data) {
        const call = JSON.parse(String(data)); sent.push(call);
        if (!call.id) return;
        queueMicrotask(() => {
          emit({ id: call.id, result: call.method === "thread/start" ? { thread: { id: "thread" } } : call.method === "turn/start" ? { turn: { id: "turn" } } : {} });
          if (call.method === "turn/start") {
            emit({ method: "item/completed", params: { threadId: "thread", item: { type: "agentMessage", text: "answer" } } });
            emit({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
          }
        });
      },
    };
  });
  try {
    expect(await transport({ prompt: "exact composed input", environmentId: "repo-env", fullAccess: true, timeoutMs: 1000, signal: new AbortController().signal })).toBe("answer");
    expect(sent.find(call => call.method === "thread/start")?.params).toMatchObject({ model: "gpt-6.1-sol", approvalPolicy: "never", serviceTier: "ultrafast", environmentConfigId: "repo-env", sandbox: "danger-full-access" });
    expect(sent.find(call => call.method === "turn/start")?.params).toEqual({ threadId: "thread", input: [{ type: "text", text: "exact composed input" }] });
  } finally { if (oldUrl === undefined) delete process.env.LLV_CODEX_CLOUD_URL; else process.env.LLV_CODEX_CLOUD_URL = oldUrl; }
});

for (const failCloud of [false, true]) test(`owner relay routes through repo Cloud environment${failCloud ? " and falls back locally once on confirmed failure" : ""}`, async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const relay: PairedRelay = { id: "owner_cloud", origin: server.origin, api_base: server.origin + "/v1", name: "Relay", description: "Relay", credential: "fixture",
    owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null }, pairedAt: new Date().toISOString(), paused: false,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, ownerTier: true, engine: "codex-cloud", model: "gpt-6.1-sol", effort: null,
      project: "repository", cloudEnvironmentId: "repo-env", concurrency: 1, hardCapMinutes: 1 }] };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  let cloudCalls = 0, localCalls = 0;
  const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env },
  } });
  const raw = { ...contextRequest, request_id: `owner_cloud_${failCloud}`, input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } };
  try {
    const result = await runClaimedRequest(relay, raw, undefined, { leaseWorker: false,
      cloudTransport: async input => {
        cloudCalls++;
        expect(input).toMatchObject({ environmentId: "repo-env", fullAccess: true });
        expect(input.prompt).toContain("<owner_request>");
        if (failCloud) throw new CloudFailure(true);
        return JSON.stringify({ action: "reply", text: "Cloud owner answer", reply_to: "m1" });
      },
      ownerPorts: { launch: async () => { localCalls++; return { status: 202, body: { conversationId: "conversation_cloud_fallback", initialMessage: "delivered" } }; },
        observe: async () => ({ state: "ended", finalText: "Local owner answer" }), stop: async () => {}, pollMs: 1 },
    });
    expect(result).toMatchObject({ outcome: "answered", answer: { text: failCloud ? "Local owner answer" : "Cloud owner answer" } });
    expect(cloudCalls).toBe(1); expect(localCalls).toBe(failCloud ? 1 : 0);
    expect(select).toHaveBeenCalledTimes(failCloud ? 1 : 0);
  } finally { select.mockRestore(); await server.close(); }
});

test("an answer environment never grants owner access to an unrelated repository", () => {
  const previous = process.env.LLV_CODEX_CLOUD_ENVIRONMENT_ID;
  process.env.LLV_CODEX_CLOUD_ENVIRONMENT_ID = "answer-env";
  try {
    expect(cloudEnvironment({ project: "unbound" }, true)).toBeNull();
    expect(cloudEnvironment({ project: null, cloudEnvironmentId: "answer-env" }, true)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.LLV_CODEX_CLOUD_ENVIRONMENT_ID; else process.env.LLV_CODEX_CLOUD_ENVIRONMENT_ID = previous;
  }
});
