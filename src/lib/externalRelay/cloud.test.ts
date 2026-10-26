import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { projectForCwd } from "@/lib/scanner/describe";
import { stateDir } from "@/lib/configDir";
import { resetProjectDirectoryCacheForTests } from "@/lib/scanner/projectDirectories";
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
import { readRunLedger, updateRelayStore, type PairedRelay } from "./store";
import { contextRequest } from "./request.fixture";
import { startTestRelay } from "./testRelay";
import { readAnswerRecord } from "./answers";
import { answerPrompt } from "./prompt";
import { requestSchema } from "./protocol";

// The runner and its timers live in a child. This peer observes cancellation
// with its own real clock, after turn/start proves an execution obligation.
for (const outcome of ["owner-answer", "owner-cap", "member-window", "tool-rounds", "fallback-cap", "tool-cap"] as const)
  test(`Cloud execution deadline in a fresh process: ${outcome}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-budget-"));
    const child = spawn(process.execPath, [path.join(import.meta.dir, "cloudDeadline.fixture.ts"), outcome], {
      env: isolatedEnvironment(root, checkEnvironment(process.env)), stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stdout!.resume(); child.stderr!.on("data", data => { stderr += data; });
    const exit = new Promise<number | null>(resolve => child.once("close", resolve));
    const timers: ReturnType<typeof setTimeout>[] = [];
    let firstTurnAt = 0, round = 0, interruptAt = 0, localAt = 0, closed = 0;
    const budgets: number[] = [];
    const posts: { route: string; body: unknown }[] = [];
    const send = (value: object) => { if (child.connected) child.send(value); };
    const complete = (text: string) => {
      send({ method: "item/completed", params: { threadId: "thread", item: { type: "agentMessage", text } } });
      send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
    };
    let endResolve!: (value: Record<string, unknown>) => void;
    let endReject!: (reason: Error) => void;
    const done = new Promise<Record<string, unknown>>((resolve, reject) => { endResolve = resolve; endReject = reject; });
    child.on("message", (message: Record<string, unknown>) => {
      if (message.type === "budget") { budgets.push(Number(message.timeoutMs)); return; }
      if (message.type === "closed") { closed++; return; }
      if (message.type === "local") { localAt = performance.now(); return; }
      if (message.type === "post") { posts.push(message as typeof posts[number]); return; }
      if (message.type === "done") { endResolve(message); return; }
      if (message.type === "error") { endReject(new Error(String(message.error))); return; }
      if (message.type !== "rpc") return;
      const call = message.call as { id?: number; method: string; params: Record<string, unknown> };
      if (!call.id) return;
      send({ id: call.id, result: call.method === "thread/start" ? { thread: { id: "thread", environments: [
        { environmentConfigId: "repo-env", environmentId: "ccarenv_fixture", cwd: "/workspace/fixture" },
      ] } } : call.method === "turn/start" ? { turn: { id: "turn" } } : {} });
      if (call.method === "turn/interrupt") {
        interruptAt = performance.now();
        send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "interrupted" } } });
      }
      if (call.method !== "turn/start") return;
      round++; firstTurnAt ||= performance.now();
      if (outcome === "owner-answer") timers.push(setTimeout(() => complete("Finished"), 1400));
      if ((outcome === "tool-rounds" || outcome === "tool-cap") && round === 1) timers.push(setTimeout(() => complete(JSON.stringify({
        action: "call", text: "", reply_to: null, calls: [{ tool: "lookup_notes", arguments: "{}", cursor: null }],
      })), 2400));
      if (outcome === "fallback-cap") timers.push(setTimeout(() => send({ method: "turn/completed", params: {
        threadId: "thread", turn: { id: "turn", status: "failed" },
      } }), 2400));
    });
    // This watchdog belongs to the peer, outside the runner's clock/process.
    // The old per-round budget reaches its second interrupt around 6400 ms.
    const watchdog = setTimeout(() => endReject(new Error(`runner exceeded independent deadline; rounds=${round}; ${stderr}`)), 12000);
    try {
      const result = await done;
      expect(result.error).toBeUndefined();
      expect(await exit).toBe(0);
      if (outcome === "owner-answer") {
        expect(result.result).toMatchObject({ outcome: "answered", answer: { text: "Finished" } });
        expect(posts.filter(post => post.route.endsWith("/send"))).toHaveLength(1);
        expect(interruptAt).toBe(0);
      } else if (outcome === "member-window") {
        expect(result.result).toMatchObject({ outcome: "failed", reason: "hard_cap" });
        expect(result.accountCalls).toBe(0);
        expect(interruptAt).toBeGreaterThan(firstTurnAt);
        expect(interruptAt - firstTurnAt).toBeLessThan(1800);
      } else {
        expect(result.result).toMatchObject({ outcome: "answered", answer: { text: "Ran out of time." } });
        expect(Number(result.elapsedMs)).toBeLessThan(5000);
        if (outcome !== "fallback-cap" && outcome !== "tool-cap") {
          expect(interruptAt).toBeGreaterThan(firstTurnAt);
          expect(interruptAt - firstTurnAt).toBeLessThan(5000);
        }
      }
      if (outcome === "tool-rounds") { expect(round).toBe(2); expect(budgets[1]).toBeLessThan(2000); }
      if (outcome === "fallback-cap") {
        expect(localAt).toBeGreaterThan(firstTurnAt);
        expect(result.stops).toBe(1);
      }
      if (outcome === "tool-cap") { expect(result.toolAborted).toBe(true); expect(round).toBe(1); }
      expect(closed).toBe(round);
      expect(posts.filter(post => post.route.endsWith("/complete"))).toHaveLength(outcome === "owner-answer" ? 0 : 1);
    } finally {
      clearTimeout(watchdog); timers.forEach(clearTimeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

test("Cloud answer is delivered through the relay with unchanged protocol steps and history", async () => {
  const beats: Array<{ seq: number; progress: { label: string } | null }> = [];
  let onBeat = () => {};
  const waitForStep = (label: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`heartbeat never acknowledged ${label}`)), 15000);
    onBeat = () => { if (beats.some(beat => beat.progress?.label === label)) { clearTimeout(timer); resolve(); } };
    onBeat();
  });
  const server = await startTestRelay((request, body) => {
    if (request.url?.endsWith("/heartbeat")) { beats.push(body as typeof beats[number]); onBeat(); }
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
      await waitForStep("accepted");
      input.onProgress?.({ queued: true });
      await waitForStep("queued");
      input.onProgress?.({});
      await waitForStep("thinking");
      input.onProgress?.({ writingAnswer: true });
      await waitForStep("writing_answer");
      return JSON.stringify({ action: "reply", text: "Cloud answer", reply_to: "m1" });
    } });
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "Cloud answer" } });
    expect(beats.map(beat => beat.progress?.label)).toEqual(expect.arrayContaining(["accepted", "queued", "thinking", "writing_answer"]));
    for (const beat of beats) expect(Object.keys(beat)).toEqual(["lease_id", "seq", "progress"]);
    expect(beats.map(beat => beat.seq)).toEqual(beats.map((_, i) => i + 1));
    expect(readAnswerRecord(relay.id, "target_1", "cloud_delivery")).toMatchObject({ engine: "codex-cloud", outcome: "answered", delivery: "accepted" });
    expect(readRunLedger().runs.some(row => row.requestId === "cloud_delivery")).toBe(false);
    expect(select).not.toHaveBeenCalled();
  } finally { select.mockRestore(); await server.close(); }
}, 45000);

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
          emit({ id: call.id, result: call.method === "thread/start" ? { thread: { id: "thread", environments: [{ environmentConfigId: "repo-env", environmentId: "ccarenv_fixture", cwd: "/workspace/fixture" }] } } : call.method === "turn/start" ? { turn: { id: "turn" } } : {} });
          if (call.method === "turn/start") {
            emit({ method: "item/completed", params: { threadId: "thread", item: { type: "agentMessage", text: "answer" } } });
            emit({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
          }
        });
      },
    };
  }, async () => "/workspace/fixture");
  try {
    expect(await transport({ prompt: "exact composed input", environmentId: "repo-env", fullAccess: true, timeoutMs: 1000, signal: new AbortController().signal })).toBe("answer");
    expect(sent.find(call => call.method === "thread/start")?.params).toMatchObject({ model: "gpt-6.1-sol", approvalPolicy: "never", serviceTier: "ultrafast", environments: [{ environmentConfigId: "repo-env", cwd: "/workspace/fixture" }], sandbox: "danger-full-access" });
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
  const repository = seedRepository();
  relay.targets[0]!.project = repository.project;
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
      ownerPorts: { launch: async input => { expect(input.cwd).toBe(repository.cwd); localCalls++; return { status: 202, body: { conversationId: "conversation_cloud_fallback", initialMessage: "delivered" } }; },
        observe: async () => ({ state: "ended", finalText: "Local owner answer" }), stop: async () => {}, pollMs: 1 },
    });
    expect(result).toMatchObject({ outcome: "answered", answer: { text: failCloud ? "Local owner answer" : "Cloud owner answer" } });
    expect(cloudCalls).toBe(1); expect(localCalls).toBe(failCloud ? 1 : 0);
    expect(select).toHaveBeenCalledTimes(failCloud ? 1 : 0);
  } finally { select.mockRestore(); repository.close(); await server.close(); }
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

function seedRepository() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cloud-project-")));
  const git = spawnSync("git", ["init", "-q", cwd], { env: checkEnvironment(process.env) });
  if (git.status !== 0) throw new Error("fixture repository init failed");
  const project = projectForCwd(cwd)!;
  const catalog = path.join(stateDir(), "project-catalog.json");
  const previous = fs.existsSync(catalog) ? fs.readFileSync(catalog) : null;
  fs.writeFileSync(catalog, JSON.stringify({ files: { fixture: { cwd } } }));
  resetProjectDirectoryCacheForTests();
  return { cwd, project, close() {
    if (previous) fs.writeFileSync(catalog, previous); else fs.rmSync(catalog, { force: true });
    resetProjectDirectoryCacheForTests(); fs.rmSync(cwd, { recursive: true, force: true });
  } };
}

for (const receipt of ["missing", "wrong-config", "wrong-cwd", "missing-instance", "multiple", "object", "bad-id", "match"] as const)
  test(`Cloud repository receipt: ${receipt}`, async () => {
    const oldUrl = process.env.LLV_CODEX_CLOUD_URL;
    process.env.LLV_CODEX_CLOUD_URL = "wss://example.invalid/app-server";
    const events = new EventEmitter();
    const methods: string[] = [];
    let closed = 0;
    const emit = (value: unknown) => events.emit("message", JSON.stringify(value));
    const environment = { environmentConfigId: receipt === "wrong-config" ? "other-env" : "repo-env",
      cwd: receipt === "wrong-cwd" ? "/workspace/other" : "/workspace/fixture",
      ...(receipt === "missing-instance" ? {} : { environmentId: "ccarenv_fixture" }) };
    const transport = createCloudTransport(() => {
      queueMicrotask(() => events.emit("open"));
      return { on: events.on.bind(events), close() { closed++; }, send(data) {
        const call = JSON.parse(data); methods.push(call.method);
        if (!call.id) return;
        queueMicrotask(() => {
          emit({ id: call.id, result: call.method === "thread/start" ? { thread: { id: receipt === "bad-id" ? 7 : "thread",
            ...(receipt === "missing" ? {} : { environments: receipt === "multiple" ? [environment, environment] : receipt === "object" ? { 0: environment, length: 1 } : [environment] }),
          } } : call.method === "turn/start" ? { turn: { id: "turn" } } : {} });
          if (call.method === "turn/start") {
            emit({ method: "item/completed", params: { threadId: "thread", item: { type: "agentMessage", text: "Done" } } });
            emit({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
          }
        });
      } };
    }, async request => { expect(request.environmentId).toBe("repo-env"); return "/workspace/fixture"; });
    try {
      const pending = transport({ prompt: "Task", environmentId: "repo-env", fullAccess: true, timeoutMs: 1000, signal: new AbortController().signal });
      if (receipt === "match") expect(await pending).toBe("Done");
      else await expect(pending).rejects.toMatchObject({ confirmed: true });
      expect(methods.filter(method => method === "turn/start")).toHaveLength(receipt === "match" ? 1 : 0);
      expect(closed).toBe(1);
    } finally { if (oldUrl === undefined) delete process.env.LLV_CODEX_CLOUD_URL; else process.env.LLV_CODEX_CLOUD_URL = oldUrl; }
  });

import { formatGuide } from "./rich.fixture";
for (const credentialSource of ["relay", "cloud"] as const) for (const rich of [false, true]) for (const encoding of ["raw", "percent", "base64", "path", "identity", "safe"] as const)
  test(`structured owner egress (${credentialSource}, ${rich ? "rich" : "plain"}, ${encoding})`, async () => {
    const secret = ["synthetic", "relay", "credential"].join("-");
    const value = encoding === "percent" ? Array.from(secret, c => `%${c.charCodeAt(0).toString(16)}`).join("")
      : encoding === "base64" ? Buffer.from(secret).toString("base64")
      : encoding === "path" ? ["", "srv", "fixture", "private.txt"].join("/")
        : encoding === "identity" ? ["fixture", "example.test"].join("@") : encoding === "safe" ? "Ready" : secret;
    const previousToken = process.env.LLV_CODEX_CLOUD_TOKEN;
    if (credentialSource === "cloud") process.env.LLV_CODEX_CLOUD_TOKEN = secret;
    const sent: unknown[] = [];
    const server = await startTestRelay((req, body) => {
      if (req.url?.endsWith("/complete")) sent.push(body);
      return { body: { status: "ok", features: rich ? ["relay_rich_messages"] : [] } };
    });
    const relayCredential = credentialSource === "relay" ? secret : "fixture";
    const relay: PairedRelay = { id: "cloud_scrub", origin: server.origin, api_base: server.origin + "/v1", name: "Relay", description: "", credential: relayCredential,
      owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null }, pairedAt: new Date().toISOString(), paused: false,
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 32000 },
      targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, ownerTier: true,
        engine: "codex-cloud", model: "gpt-6.1-sol", effort: null, project: "repository", cloudEnvironmentId: "repo-env", concurrency: 1, hardCapMinutes: 1 }] };
    updateRelayStore(store => ({ ...store, relays: [relay] }));
    const requestId = `scrub_${credentialSource}_${rich}_${encoding}`;
    const answer = { action: "reply", text: `${value} User`, reply_to: "m1", ...(rich ? { format: "rich_markdown", mentions: [
      { author_key: "u1", offset: Array.from(value).length + 1, length: 4 },
    ], buttons: [[{ text: value, url: encoding === "safe" ? "https://example.test/docs" : `https://example.test/?value=${value}` }]] } : {}) };
    try {
      const result = await runClaimedRequest(relay, { ...contextRequest, request_id: requestId,
        ...(rich ? { features: ["relay_rich_messages"] } : {}), answer: { max_chars: 32000, progress: "none" },
        input: { ...contextRequest.input, ...(rich ? { format: formatGuide } : {}), tools: [], requester: { ...contextRequest.input.requester, is_owner: true } },
      }, undefined, { leaseWorker: false, cloudTransport: async () => {
        if (credentialSource === "cloud") process.env.LLV_CODEX_CLOUD_TOKEN = "rotated-cloud-credential";
        return JSON.stringify(answer);
      } });
      expect(result).toMatchObject({ outcome: "answered" });
      expect(sent).toHaveLength(1);
      const history = readAnswerRecord(relay.id, "target_1", requestId);
      if (encoding === "safe") {
        expect(result).toMatchObject({ answer });
        expect(sent[0]).toMatchObject({ answer });
      } else {
        for (const payload of [result, sent[0], history]) {
          expect(JSON.stringify(payload)).not.toContain(secret);
          expect(JSON.stringify(payload)).not.toContain(value);
        }
        if (rich) expect(result).toMatchObject({ answer: { mentions: [] } });
      }
    } finally {
      if (previousToken === undefined) delete process.env.LLV_CODEX_CLOUD_TOKEN; else process.env.LLV_CODEX_CLOUD_TOKEN = previousToken;
      await server.close();
    }
  });

for (const state of ["unresolved", "deleted", "reassigned", "switch-before-launch", "valid"] as const)
  test(`Cloud local owner repository admission: ${state}`, async () => {
    const repository = seedRepository();
    const paired: PairedRelay = { id: "local_cloud", origin: "http://127.0.0.1:1", api_base: "http://127.0.0.1:1/v1", name: "Relay", description: "", credential: "fixture",
      owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null }, pairedAt: new Date().toISOString(), paused: false,
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
      targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, ownerTier: true,
        engine: "codex-cloud", model: "gpt-6.1-sol", effort: null, project: state === "unresolved" ? "unknown" : repository.project,
        cloudEnvironmentId: null, concurrency: 1, hardCapMinutes: 1 }] };
    // Warm the resolver before deleting or changing the checkout identity.
    cloudOwnerDirectory(repository.project);
    if (state === "deleted") fs.rmSync(repository.cwd, { recursive: true });
    if (state === "reassigned") {
      const git = spawnSync("git", ["-C", repository.cwd, "remote", "add", "origin", "https://example.test/fixture/other.git"], { env: checkEnvironment(process.env) });
      expect(git.status).toBe(0);
    }
    updateRelayStore(store => ({ ...store, relays: [paired] }));
    let launches = 0;
    const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
      engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env },
    } });
    const wire = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: { status: "ok" } } as never);
    try {
      const result = await runClaimedRequest(paired, { ...contextRequest, request_id: `local_${state}`, answer: { max_chars: 4000, progress: "none" },
        input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } },
      }, undefined, { leaseWorker: false, ownerPorts: {
        launch: async (input, authorize) => {
          expect(input.cwd).toBe(repository.cwd);
          if (state === "switch-before-launch") {
            expect(spawnSync("git", ["-C", repository.cwd, "remote", "add", "origin", "https://example.test/fixture/replaced.git"], { env: checkEnvironment(process.env) }).status).toBe(0);
          }
          authorize!(); launches++;
          return { status: 202, body: { conversationId: "conversation_local", initialMessage: "delivered" } };
        },
        observe: async () => ({ state: "ended", finalText: "Done" }), stop: async () => {}, noExecution: async () => true, pollMs: 1,
      } });
      expect(launches).toBe(state === "valid" ? 1 : 0);
      if (state !== "valid" && state !== "switch-before-launch") expect(selection).not.toHaveBeenCalled();
      if (state === "valid") expect(result).toMatchObject({ outcome: "answered", answer: { text: "Done" } });
      else if (state === "switch-before-launch") expect(result).toMatchObject({ outcome: "answered", answer: { text: expect.stringContaining("configured project directory") } });
      else expect(result).toMatchObject({ outcome: "failed", reason: "configuration_error", detail: expect.stringContaining("configured project directory") });
    } finally { selection.mockRestore(); wire.mockRestore(); repository.close(); }
  });

import * as client from "./client";
import { cloudOwnerDirectory, runOwnerAgent } from "./ownerRun";
import { relayServiceToolsOp } from "./ownerServiceTools";
import { relayAnswerOp } from "./ownerAnswer";

for (const prior of ["none", "action", "unknown", "reassigned", "rich"] as const)
  test(`confirmed Cloud fallback keeps request-bound service tools and effects: ${prior}`, async () => {
    const repository = seedRepository();
    const priorAction = prior === "action" || prior === "unknown";
    const priorCall = priorAction || prior === "rich";
    const tool = priorAction ? "write_note" : "lookup_notes";
    const effect = priorAction ? "action" : "read";
    const relay: PairedRelay = { id: "cloud_tools", origin: "http://127.0.0.1:1", api_base: "http://127.0.0.1:1/v1", name: "Relay", description: "", credential: "fixture",
      owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null }, pairedAt: "2026-10-20T12:00:00Z", paused: false,
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
      targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, ownerTier: true,
        engine: "codex-cloud", model: "gpt-6.1-sol", effort: null, project: repository.project, cloudEnvironmentId: "repo-env", concurrency: 1, hardCapMinutes: 1 }] };
    updateRelayStore(store => ({ ...store, relays: [relay] }));
    const calls: unknown[] = [];
    const wire = spyOn(client, "relayCall").mockImplementation(async (_base, route, _method, body) => {
      if (route.endsWith("/tool-calls")) {
        calls.push(body);
        return { status: 200, body: { ...(body as object), tool, status: prior === "unknown" ? "outcome_unknown" : "ok", output: "Found", truncated: false,
          effect, delivered: false, replayed: false, calls_remaining: 15 } } as never;
      }
      return { status: 200, body: { status: "ok" } } as never;
    });
    const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
      engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env },
    } });
    const { prepareAgentRegistry } = await import("@/lib/agent/registry");
    const registry = await prepareAgentRegistry();
    const lookup = spyOn(registry, "conversation").mockReturnValue({ id: "conversation_fallback_tools", engine: "codex",
      generations: [{ id: "generation_fallback_tools", launchProfile: { cwd: repository.cwd } }] } as never);
    let cloud = 0, launches = 0;
    let list: unknown, described: unknown, called: unknown, repeated: unknown, parts: unknown;
    try {
      const result = await runClaimedRequest(relay, { ...contextRequest, request_id: `cloud_fallback_tools_${prior}`, answer: { max_chars: 4000, progress: "none" },
        ...(prior === "rich" ? { features: ["relay_rich_messages"] } : {}),
        input: { ...contextRequest.input, ...(prior === "rich" ? { format: formatGuide } : {}), tools: [{ name: tool, summary: "Notes", mode: "direct", effect, parameters: { type: "object", properties: {} } }],
          requester: { ...contextRequest.input.requester, is_owner: true } },
      }, undefined, { leaseWorker: false, cloudTransport: async () => {
        cloud++;
        if (priorCall && cloud === 1) return JSON.stringify({ action: "call", text: "", reply_to: null, calls: [{ tool, arguments: "{}", cursor: null }] });
        throw new CloudFailure(true);
      }, ownerPorts: {
        launch: async () => { launches++; return { status: 202, body: { conversationId: "conversation_fallback_tools", initialMessage: "delivered" } }; },
        observe: async () => {
          if (prior === "reassigned") expect(spawnSync("git", ["-C", repository.cwd, "remote", "add", "origin", "https://example.test/fixture/reassigned.git"], { env: checkEnvironment(process.env) }).status).toBe(0);
          list = await relayServiceToolsOp("conversation_fallback_tools", { op: "list" });
          described = await relayServiceToolsOp("conversation_fallback_tools", { op: "describe", names: [tool] });
          called = await relayServiceToolsOp("conversation_fallback_tools", { op: "call", calls: [{ tool, arguments: {} }] });
          repeated = await relayServiceToolsOp("conversation_fallback_tools", { op: "call", calls: [{ tool, arguments: {} }] });
          if (prior === "rich") parts = await relayAnswerOp("conversation_fallback_tools", {
            format: "rich_markdown", buttons: [[{ text: "Open docs", url: "https://example.test/docs" }]],
          });
          return { state: "ended", finalText: prior === "unknown" ? "[ignore]" : "Done" };
        }, stop: async () => {}, pollMs: 1,
      } });
      expect(launches).toBe(1);
      expect(cloud).toBe(priorCall ? 2 : 1);
      if (prior === "reassigned") {
        expect(list).toBeNull(); expect(described).toBeNull(); expect(called).toBeNull(); expect(calls).toHaveLength(0);
      } else {
        expect(list).toMatchObject({ tools: [{ name: tool }] });
        expect(described).toMatchObject({ tools: [{ name: tool, parameters: expect.any(Object) }] });
        expect(called).toMatchObject({ status: "completed", ...(prior === "none" ? { results: [{ status: "ok" }] } : {}) });
        expect(repeated).toEqual(called);
        expect(calls).toHaveLength(1);
        expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", ...(prior === "unknown" ? {} : { text: "Done" }) } });
        if (prior === "unknown") expect(called).toMatchObject({ callsLeft: 0, actionSent: true });
        if (prior === "rich") {
          expect(parts).toMatchObject({ format: "rich_markdown", buttons: [[{ text: "Open docs" }]] });
          expect(result).toMatchObject({ answer: { format: "rich_markdown", buttons: [[{ text: "Open docs" }]] } });
        }
      }
      expect(await relayServiceToolsOp("conversation_fallback_tools", { op: "list" })).toBeNull();
      expect(readRunLedger().runs.some(row => row.requestId === `cloud_fallback_tools_${prior}`)).toBe(false);
    } finally { lookup.mockRestore(); wire.mockRestore(); selection.mockRestore(); repository.close(); }
  });

for (const tier of ["owner", "member"]) for (const mode of ["disconnect", "crash", "completed", "refused", "acknowledged"])
  test(`uncertain Cloud custody fences redelivery across process restart: ${tier}, ${mode}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-custody-"));
    const env = isolatedEnvironment(root, checkEnvironment(process.env));
    const children: ReturnType<typeof spawn>[] = [];
    const start = (operation: string) => {
      const child = spawn(process.execPath, [path.join(import.meta.dir, "cloudCustody.fixture.ts"), operation, tier], {
        env, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      let output = "", errors = "";
      child.stdout!.on("data", data => { output += data; });
      child.stderr!.on("data", data => { errors += data; });
      const exit = new Promise<number | null>(resolve => child.once("close", resolve));
      return { child, exit, output: () => output, errors: () => errors };
    };
    try {
      const first = start(mode);
      if (mode === "crash" || mode === "completed") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("Cloud dispatch seam not reached")), 10000);
          first.child.once("message", () => { clearTimeout(timer); resolve(); });
          first.child.once("error", reject);
        });
        first.child.kill("SIGKILL"); await first.exit;
      } else {
        expect(await first.exit, first.errors()).toBe(0);
        expect(JSON.parse(first.output().trim().split("\n").at(-1)!)).toMatchObject({ result: mode === "refused" ? { outcome: "answered" } : null, second: null, cloud: 1, local: 0, stops: 0,
          rows: [{ requestId: "uncertain_custody", cloudExecution: mode === "refused" ? "completed" : "uncertain" }] });
      }
      const next = start("redeliver");
      expect(await next.exit, next.errors()).toBe(0);
      expect(JSON.parse(next.output().trim().split("\n").at(-1)!)).toEqual({ result: null, second: null, cloud: 0, local: 0, stops: 0,
        rows: [{ requestId: "uncertain_custody", cloudExecution: mode === "completed" || mode === "refused" ? "completed" : "uncertain" }] });
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve)); }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

for (const failure of ["catalogue-refusal", "cancel-during-resolution"] as const)
  test(`Cloud repository resolution stops before execution: ${failure}`, async () => {
    const previous = process.env.LLV_CODEX_CLOUD_URL;
    process.env.LLV_CODEX_CLOUD_URL = "wss://example.invalid/app-server";
    const events = new EventEmitter(), abort = new AbortController();
    const methods: string[] = [];
    let resolveCwd!: (cwd: string) => void, entered!: () => void;
    let signal: AbortSignal | undefined;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const cwd = new Promise<string>(resolve => { resolveCwd = resolve; });
    const transport = createCloudTransport(() => {
      queueMicrotask(() => events.emit("open"));
      return { on: events.on.bind(events), close() {}, send(data) {
        const call = JSON.parse(data); methods.push(call.method);
        if (call.id) queueMicrotask(() => events.emit("message", JSON.stringify({ id: call.id, result: {} })));
      } };
    }, async request => {
      signal = request.signal; entered();
      if (failure === "catalogue-refusal") throw new Error("configuration unavailable");
      return cwd;
    });
    try {
      const pending = transport({ prompt: "Task", environmentId: "repo-env", fullAccess: true, timeoutMs: 1000, signal: abort.signal });
      const rejected = expect(pending).rejects.toMatchObject({ confirmed: true });
      await ready;
      if (failure === "cancel-during-resolution") abort.abort();
      await rejected;
      expect(signal?.aborted).toBe(true);
      resolveCwd("/workspace/fixture");
      await cwd; await Promise.resolve();
      expect(methods).toEqual(["initialize", "initialized"]);
    } finally {
      abort.abort(); resolveCwd("/workspace/fixture");
      if (previous === undefined) delete process.env.LLV_CODEX_CLOUD_URL; else process.env.LLV_CODEX_CLOUD_URL = previous;
    }
  });

test.each(["toString", "constructor", "__proto__", "unknown"])("unbound project %s gets no inherited Cloud environment", project => {
  const previous = process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS;
  process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS = "{}";
  try { expect(cloudEnvironment({ project }, true)).toBeNull(); }
  finally {
    if (previous === undefined) delete process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS;
    else process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS = previous;
  }
});

test("Cloud rechecks owner authorization after the environment receipt", async () => {
  const previous = process.env.LLV_CODEX_CLOUD_URL;
  process.env.LLV_CODEX_CLOUD_URL = "wss://example.invalid/app-server";
  const events = new EventEmitter();
  const methods: string[] = [];
  let authorized = true;
  const transport = createCloudTransport(() => {
    queueMicrotask(() => events.emit("open"));
    return { on: events.on.bind(events), close() {}, send(data) {
      const call = JSON.parse(data); methods.push(call.method);
      if (!call.id) return;
      queueMicrotask(() => {
        if (call.method === "thread/start") authorized = false;
        events.emit("message", JSON.stringify({ id: call.id, result: call.method === "thread/start" ? {
          thread: { id: "thread", environments: [{ environmentConfigId: "repo-env", environmentId: "ccarenv_fixture", cwd: "/workspace/fixture" }] },
        } : {} }));
      });
    } };
  }, async () => "/workspace/fixture");
  try {
    await expect(transport({ prompt: "Task", environmentId: "repo-env", fullAccess: true, timeoutMs: 1000,
      signal: new AbortController().signal, authorize() { if (!authorized) throw new Error("revoked"); },
    })).rejects.toMatchObject({ confirmed: true });
    expect(methods).toEqual(["initialize", "initialized", "thread/start"]);
  } finally { if (previous === undefined) delete process.env.LLV_CODEX_CLOUD_URL; else process.env.LLV_CODEX_CLOUD_URL = previous; }
});


test("a Cloud target continues its local Codex owner conversation with the local engine", async () => {
  const repository = seedRepository();
  let sends = 0;
  try {
    const run = runOwnerAgent({
      request: requestSchema.parse({ ...contextRequest, request_id: "cloud_local_continuation" }),
      owner: { messageId: "m1", text: "Hello", requestText: null }, accountId: null, hardCapMs: 1000,
      target: { id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, ownerTier: true,
        engine: "codex-cloud", model: "gpt-6.1-sol", effort: null, project: repository.project, concurrency: 1, hardCapMinutes: 1 },
      continuation: { conversationId: "conversation_cloud_local", prompt: "Next task" }, onConversation() {},
      ports: {
        launch: async () => { throw new Error("existing conversation must continue"); },
        continue: async (_turn, _text, target, authorize, repositoryBound) => {
          expect(repositoryBound).toBe(true);
          authorize(); sends++; expect(target.engine).toBe("codex"); expect(target.project).toBe(repository.project);
          return { ok: true, structured: true, target: "conversation_cloud_local", outcome: "held", operationId: "cloud_local_continue" };
        },
        observe: async () => ({ state: "ended", finalText: "Done", firstMessagePending: false }),
        stop: async () => { throw new Error("completed continuation must settle"); }, pollMs: 1,
      },
    });
    expect(await run.done).toMatchObject({ status: "done", answer: { text: "Done" } });
    expect(sends).toBe(1);
  } finally { repository.close(); }
});


test("local owner admission verifies the physical repository after a directory is redirected", () => {
  const repository = seedRepository();
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-foreign-"));
  const nested = path.join(repository.cwd, "nested"), destination = path.join(foreign, "nested");
  try {
    expect(spawnSync("git", ["init", "-q", foreign], { env: checkEnvironment(process.env) }).status).toBe(0);
    fs.mkdirSync(nested); fs.mkdirSync(destination);
    expect(cloudOwnerDirectory(repository.project, nested)).toBe(fs.realpathSync(nested));
    fs.rmdirSync(nested); fs.symlinkSync(destination, nested, "dir");
    expect(() => cloudOwnerDirectory(repository.project, nested)).toThrow("configured project directory");
  } finally { repository.close(); fs.rmSync(foreign, { recursive: true, force: true }); }
});

for (const state of ["matching", "foreign", "deleted", "reassigned", "missing-cwd", "dispatch-reassigned", "dispatch-generation"] as const)
  test(`Cloud local continuation validates its active generation repository: ${state}`, async () => {
    const { sendOwnerContinuation, OwnerContinuationRefused } = await import("./ownerRun");
    const { prepareAgentRegistry } = await import("@/lib/agent/registry");
    const delivery = await import("@/lib/runtime/structuredMessageDelivery");
    const repository = seedRepository();
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-continuation-"));
    expect(spawnSync("git", ["init", "-q", foreign], { env: checkEnvironment(process.env) }).status).toBe(0);
    const transcript = path.join(foreign, "transcript.jsonl"); fs.writeFileSync(transcript, "fixture");
    const record = { id: "conversation_repo", engine: "codex", generations: [{ id: "generation_repo", path: transcript, accountId: "fixture",
      launchProfile: { cwd: state === "foreign" ? foreign : state === "missing-cwd" ? undefined : repository.cwd } }] };
    const registry = await prepareAgentRegistry();
    const lookup = spyOn(registry, "conversation").mockImplementation(() => record as never);
    const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId: "fixture" } as never });
    let admitted = 0, effects = 0;
    const replaceRepository = () => { expect(spawnSync("git", ["-C", repository.cwd, "remote", "add", "origin", "https://example.test/fixture/reassigned.git"], { env: checkEnvironment(process.env) }).status).toBe(0); };
    const dispatch = spyOn(delivery, "enqueueStructuredMessage").mockImplementation(async (request, deps) => {
      admitted++;
      request.admissionGuard?.();
      expect(await deps?.idleContinuationAllowed?.()).toBe(true);
      // This seam represents queued admission followed by the transport callback.
      await Promise.resolve();
      if (state === "dispatch-reassigned") replaceRepository();
      if (state === "dispatch-generation") record.generations.push({ ...record.generations[0]!, id: "generation_peer" });
      if (state.startsWith("dispatch-")) {
        expect(() => deps?.authorizeDispatch?.()).toThrow(OwnerContinuationRefused);
        expect(await deps?.idleContinuationAllowed?.()).toBe(false);
        expect(() => request.recoveryAuthorityGuard?.()).toThrow(OwnerContinuationRefused);
        return { ok: false, structured: true, outcome: "failed", status: 409, admission: "refused", error: "automatic continuation unavailable" };
      }
      await deps?.authorizeDispatch?.(); effects++;
      return { ok: true, structured: true, target: record.id, outcome: "held", operationId: "repo_continue" };
    });
    try {
      if (state === "deleted") fs.rmSync(repository.cwd, { recursive: true });
      if (state === "reassigned") replaceRepository();
      const result = await sendOwnerContinuation({ conversationId: record.id, clientAttemptId: "repo_continue", claimedAt: "2026-10-20T12:00:00Z", continuation: { operationId: "repo_continue" } },
        "Continue", { id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "codex", model: "gpt-6.1-sol", effort: null,
          project: repository.project, concurrency: 1, hardCapMinutes: 1 }, () => {}, true);
      expect(result).toMatchObject(state === "matching" ? { ok: true } : { ok: false, admission: "refused" });
      expect(admitted).toBe(state === "matching" || state.startsWith("dispatch-") ? 1 : 0);
      expect(effects).toBe(state === "matching" ? 1 : 0);
    } finally { lookup.mockRestore(); selection.mockRestore(); dispatch.mockRestore(); repository.close(); fs.rmSync(foreign, { recursive: true, force: true }); }
  });

for (const changed of [false, true])
  test(`Cloud continuation repository guard reaches the runtime journal: changed=${changed}`, async () => {
    const { migrationDeliveryFixture } = await import("@/test-helpers/migrationDelivery");
    const registryModule = await import("@/lib/agent/registry");
    const delivery = await import("@/lib/runtime/structuredMessageDelivery");
    const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
    const { sendOwnerContinuation } = await import("./ownerRun");
    const fixture = migrationDeliveryFixture();
    expect(spawnSync("git", ["init", "-q", fixture.root], { env: checkEnvironment(process.env) }).status).toBe(0);
    const repository = { cwd: fixture.root, project: projectForCwd(fixture.root) };
    const prepare = spyOn(registryModule, "prepareAgentRegistry").mockResolvedValue(fixture.registry);
    const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId: "account-a" } as never });
    const enqueue = delivery.enqueueStructuredMessage;
    const route = spyOn(delivery, "enqueueStructuredMessage").mockImplementation((request, dependencies) => enqueue(request, {
      ...dependencies, enabled: () => true, registry: () => fixture.registry, client: () => fixture.client,
      kick: () => {}, startupFailed: () => false, progress: null,
    }));
    let claims = 0, writes = 0;
    const begin = fixture.registry.beginDeliveryAttemptOffLoop.bind(fixture.registry);
    const claim = spyOn(fixture.registry, "beginDeliveryAttemptOffLoop").mockImplementation(async (...args) => {
      const result = await begin(...args);
      if (result.acquired) {
        claims++;
        if (changed) expect(spawnSync("git", ["-C", repository.cwd, "remote", "add", "origin", "https://example.test/fixture/reassigned.git"], { env: checkEnvironment(process.env) }).status).toBe(0);
      }
      return result;
    });
    fixture.client.readSession = async identity => fixture.journal.snapshot().sessions.find(row => row.conversationId === identity.conversationId) ?? null;
    fixture.client.command = async command => { writes++; return fixture.journal.executeOperation(command); };
    try {
      await bindStructuredDeliveryQueue([{ key: fixture.key, host: fixture.host }], { registry: fixture.registry, client: fixture.client,
        hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
      const result = await sendOwnerContinuation({ conversationId: fixture.conversation.id, clientAttemptId: "repository-journal",
        claimedAt: "2026-10-20T12:00:00Z", continuation: { operationId: "repository-journal" } }, "Continue", {
        id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "codex",
        model: "gpt-6.1-sol", effort: null, project: repository.project, concurrency: 1, hardCapMinutes: 1,
      }, () => {}, true);
      expect(claims, JSON.stringify(result)).toBe(1);
      expect(writes).toBe(changed ? 0 : 1);
      expect(result).toMatchObject({ ok: !changed });
      if (changed) expect(Object.values(fixture.registry.readOnlySnapshot().heldDeliveries)).toMatchObject([{ state: "failed" }]);
    } finally {
      claim.mockRestore(); route.mockRestore(); selection.mockRestore(); prepare.mockRestore();
      await fixture.cleanup();
    }
  });
