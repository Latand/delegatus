import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { StructuredMessageRequest } from "@/lib/runtime/structuredMessageDelivery";
import type { BoardTask } from "@/lib/tasks/types";
import type { ExternalRelayAnswer, ExternalRelayCompletion } from "./protocol";
import type { PairedRelay } from "./store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dm-task-"));
const originalState = process.env.LLV_STATE_DIR;
const taskState = path.join(root, "initial");
process.env.LLV_STATE_DIR = taskState;
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { selfFile } = await import("@/lib/links/self");
const { persistProjectAliases } = await import("@/lib/projects/aliases");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const structured = await import("@/lib/runtime/structuredMessageDelivery");
const { loadTasks, saveTasksFile } = await import("@/lib/tasks/store");
const { runClaimedRequest } = await import("./runner");
const { dmTaskTrigger } = await import("./dmTask");
const { relayClaimCapabilities } = await import("./poller");
const { RELAY_DM_TASK_CHOICES, requestSchema, relayChoiceButtonsSchema } = await import("./protocol");
const { updateRelayStore, writeRelayFile } = await import("./store");
const { startTestRelay } = await import("./testRelay");
const { sampleRequest } = await import("./request.fixture");
const { formatGuide } = await import("./rich.fixture");

const atlas = "project-atlas";
const beacon = "project-beacon";
const stamp = "2026-05-01T12:00:00.000Z";
const publicAddress = "https://board.example.invalid";
const chatKey = "private".repeat(3);
const secondChat = "another".repeat(3);
const feature = RELAY_DM_TASK_CHOICES;
const owner = { key: "owner", is_admin: false, can_restrict_members: false, can_delete_messages: false, is_owner: true, is_anonymous_admin: false };
const trusted = { ...owner, key: "trusted", is_owner: false };
const guest = { ...trusted, key: "visitor" };
const grant = { id: "grant", kind: "requester" as const, key: trusted.key, project: atlas, label: "Trusted requester", addedAt: stamp, source: "board" as const };
let registry: InstanceType<typeof AgentRegistry>;
let index = 0;
let now = Date.parse(stamp);
let claims: number;
let directives: StructuredMessageRequest[];
let completions: ExternalRelayCompletion[];
let heartbeat: () => void;
let service: Awaited<ReturnType<typeof startTestRelay>>;
let paired: PairedRelay;
let startingTasks: BoardTask[];
let send: ReturnType<typeof spyOn<typeof structured, "enqueueStructuredMessage">>;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;

function designate(project: string, conversationId: `conversation_${string}`) {
  const spawn = registry.beginSpawnRequest({ engine: "codex", cwd: root, explicitProject: project, conversationId,
    launchProfile: { cwd: root, title: "Test seat", role: "root" } });
  if (spawn.kind !== "created") throw new Error("fixture launch was refused");
  registry.completeSpawn(spawn.receipt.launchId, {
    key: { engine: "codex", sessionId: project }, artifactPath: path.join(root, `${project}.jsonl`),
    cwd: root, accountId: null, status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
  });
  const key = `designate-${project}`;
  beginOrchestratorSeatIntent({ project, mandate: "Fixture mandate", clientRequestId: key, mode: "spawn" });
  completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId, path: null });
}

beforeEach(async () => {
  process.env.LLV_STATE_DIR = path.join(root, `test-${++index}`);
  registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR, "registry.json"));
  setAgentRegistryForTests(registry);
  saveTasksFile({ tasks: [], recentCreates: [] });
  expect(persistProjectAliases([
    { source: atlas, target: atlas, displayName: "Atlas" },
    { source: beacon, target: beacon, displayName: "Beacon" },
  ])).toBe(true);
  designate(atlas, "conversation_atlas");
  designate(beacon, "conversation_beacon");
  startingTasks = loadTasks();
  writeRelayFile(selfFile(), { v: 1, installId: "fixture", label: "Test board", publicUrl: publicAddress, check: null });
  now = Date.parse(stamp);
  clock = spyOn(Date, "now").mockImplementation(() => now);
  claims = 0;
  directives = [];
  completions = [];
  heartbeat = () => {};
  send = spyOn(structured, "enqueueStructuredMessage").mockImplementation(async message => {
    message.admissionGuard?.();
    directives.push(message);
    return { ok: true, structured: true, target: message.conversationId ?? null, outcome: "held", operationId: "fixture-operation" };
  });
  service = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) {
      heartbeat();
      return { body: { status: "ok" } };
    }
    if (req.url?.endsWith("/complete")) {
      completions.push(body as ExternalRelayCompletion);
      return { body: { status: "accepted" } };
    }
    return { status: 404 };
  });
  paired = {
    id: "relay", origin: service.origin, api_base: `${service.origin}/v1`, credential: "x".repeat(43),
    name: "Test relay", description: "", paused: false, pairedAt: stamp,
    owner: { namespace: "telegram", id: String(100 + 1), display_name: "Test owner", handle: null },
    limits: { max_response_bytes: 65536, max_wait_s: 5, max_answer_chars: 4000 },
    features: [feature, "relay_rich_messages"],
    targets: [{ id: sampleRequest.target_id, name: "Test target", answered_by: "install", fallback: "none",
      enabled: true, engine: "codex", model: "test-model", effort: "low", project: atlas, concurrency: 1, hardCapMinutes: 1,
      requesters: { revision: 1, entries: [grant] } }],
  };
  updateRelayStore(store => ({ ...store, relays: [paired] }));
});

afterEach(async () => {
  clock.mockRestore();
  send.mockRestore();
  await service.close();
  registry.close();
  setAgentRegistryForTests(null);
});

afterAll(() => {
  if (originalState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalState;
  fs.rmSync(root, { recursive: true, force: true });
});

function claim(author = owner, text = "Fix Atlas build output", message = "trigger") {
  return {
    ...sampleRequest, request_id: `request-${++claims}`, claimed_at: stamp,
    chat: { key: chatKey, type: "private" }, features: [feature, "relay_rich_messages"],
    input: {
      ...sampleRequest.input, format: formatGuide, requester: author, respond_to: message,
      conversation: [{ ...sampleRequest.input.conversation[0], id: message, author: { key: author.key, name: "Fixture", self: false }, text }],
    },
    answer: { max_chars: 4000, progress: "none" },
  };
}

async function reply(request: unknown) {
  const result = await runClaimedRequest(paired, request, undefined, { leaseWorker: false });
  expect(result).toMatchObject({ outcome: "answered" });
  if (result?.outcome !== "answered") throw new Error("fixture expected a reply");
  expect(completions.at(-1)).toEqual(result);
  return result.answer;
}

function button(answer: ExternalRelayAnswer, label: string) {
  const { rows, message_id, expires_at } = relayChoiceButtonsSchema.parse(answer.choice_buttons);
  const value = rows.flat().find(button => button.text === label)?.value;
  if (!value) throw new Error("fixture project choice is absent");
  return { sender_key: owner.key, chat_key: chatKey, message_id, value, expires_at };
}

function newTasks() {
  const tasks = loadTasks();
  expect(tasks.filter(task => startingTasks.some(row => row.id === task.id))).toEqual(startingTasks);
  return tasks.filter(task => !startingTasks.some(row => row.id === task.id));
}

test("an owner gets one assigned card and one owner directive on the inferred project across claim IDs and a process restart", async () => {
  const first = claim(owner, "Fix Beacon build output");
  const duplicates = [{ ...first, request_id: "replay-one" }, { ...first, request_id: "replay-two" }];
  const answers = await Promise.all([first, ...duplicates].map(request =>
    runClaimedRequest(paired, request, undefined, { leaseWorker: false })));
  const tasks = newTasks();
  const [task] = tasks;
  expect(tasks).toHaveLength(1);
  expect(task).toMatchObject({ project: beacon, status: "assigned", text: "Fix Beacon build output\n\nFix Beacon build output" });
  const expectedLink = `${publicAddress}/#task=${task!.id}`;
  for (const result of answers) expect(result).toMatchObject({ outcome: "answered", answer: { buttons: [[{ url: expectedLink }]] } });
  expect(directives).toHaveLength(1);
  expect(directives[0]).toMatchObject({ conversationId: "conversation_beacon", origin: { kind: "operator" },
    policy: "steer-or-queue" });
  expect(directives[0]!.text).toContain(task!.id);
  expect(directives[0]!.text).toContain(first.input.conversation[0]!.text);

  const request = { ...first, request_id: "replay-after-restart" };
  const child = Bun.spawn([process.execPath, "-e", `
    const { paired, request, now, taskState } = await Bun.stdin.json();
    const state = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = taskState;
    const { runClaimedRequest } = await import("./src/lib/externalRelay/runner");
    process.env.LLV_STATE_DIR = state;
    Date.now = () => now;
    const result = await runClaimedRequest(paired, request, undefined, { leaseWorker: false });
    if (result?.outcome !== "answered" || !result.answer.buttons?.length) process.exitCode = 1;
  `], { stdin: new Blob([JSON.stringify({ paired, request, now, taskState })]), stdout: "pipe", stderr: "pipe" });
  const [exit, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`Restarted relay exited with ${exit}\n${stderr}`);
  expect(completions.at(-1)).toMatchObject({ answer: { buttons: [[{ url: expectedLink }]] } });
  expect(newTasks()).toHaveLength(1);
});

test("a live trusted requester reaches only the granted project as an owner request", async () => {
  const denied = await reply(claim(trusted, "Fix Beacon build output", "outside"));
  expect(denied.buttons).toEqual([]);
  expect(newTasks()).toEqual([]);
  const allowed = await reply(claim(trusted));
  expect(allowed.buttons?.[0]?.[0]?.url).toContain("#task=");
  expect(newTasks()).toMatchObject([{ project: atlas, status: "assigned" }]);
  expect(directives).toMatchObject([{ conversationId: "conversation_atlas", origin: { kind: "operator" } }]);
});

test("seat delivery refusal leaves one card and a new claim retries the same directive", async () => {
  let initial: StructuredMessageRequest | undefined;
  send.mockImplementationOnce(async message => {
    initial = message;
    return { ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" };
  });
  const original = claim();
  const pending = await reply(original);
  expect(pending.text).toContain("unconfirmed");
  expect(newTasks()).toHaveLength(1);
  const completed = await reply({ ...original, request_id: "retry-directive" });
  expect(completed.buttons).toEqual(pending.buttons);
  expect(newTasks()).toHaveLength(1);
  expect(directives).toHaveLength(1);
  expect(directives[0]?.clientMessageId).toBe(initial?.clientMessageId);
  expect(directives[0]?.text).toBe(initial?.text);
});

test("a claimed private task consumes live authorization after the heartbeat, with no access for a guest or anonymous author", async () => {
  for (const author of [guest, { ...trusted, is_anonymous_admin: true }]) {
    const answer = await reply(claim(author, "Fix Atlas build output", author.key));
    expect(answer.buttons).toEqual([]);
  }
  heartbeat = () => updateRelayStore(store => ({ ...store, relays: [{ ...paired,
    targets: [{ ...paired.targets[0]!, requesters: { revision: 2, entries: [] } }],
  }] }));
  const revoked = await reply(claim(trusted, "Fix Atlas build output", "revoked"));
  expect(revoked.buttons).toEqual([]);
  expect(newTasks()).toEqual([]);
  expect(directives).toEqual([]);
});

test("ambiguity offers project choices and spends only a matching sender, chat, message, value and expiry", async () => {
  const original = claim(owner, "Fix the build output");
  const offered = await reply(original);
  expect(offered.choice_buttons?.rows.map(row => row[0]?.text)).toEqual(["Atlas", "Beacon"]);
  const choice = button(offered, "Beacon");
  expect(newTasks()).toEqual([]);
  const request = (event = choice) => ({ ...original, request_id: `callback-${++claims}`, button_choice: event });
  const foreignSender = { ...claim(trusted, original.input.conversation[0]!.text), button_choice: { ...choice, sender_key: trusted.key } };
  const foreignChat = { ...request({ ...choice, chat_key: secondChat }), chat: { key: secondChat, type: "private" } };
  for (const wrong of [foreignSender, foreignChat, request({ ...choice, message_id: "another-message" }),
    request({ ...choice, value: "wrong".repeat(8) }), request({ ...choice, expires_at: stamp })]) {
    expect((await reply(wrong)).buttons).toEqual([]);
    expect(newTasks()).toEqual([]);
  }
  expect((await reply(request())).buttons?.[0]?.[0]?.url).toContain("#task=");
  await reply(request());
  expect(newTasks()).toMatchObject([{ project: beacon }]);
  expect(directives).toHaveLength(1);
});

test("an expired or revoked choice leaves the board and seat untouched", async () => {
  const ownerClaim = claim(owner, "Fix the build output", "stale");
  const stale = button(await reply(ownerClaim), "Atlas");
  now = Date.parse(stale.expires_at);
  expect((await reply({ ...ownerClaim, request_id: "expired", button_choice: stale })).buttons).toEqual([]);
  const trustedClaim = claim(trusted, "Fix the build output", "revoke");
  const live = { ...button(await reply(trustedClaim), "Atlas"), sender_key: trusted.key };
  updateRelayStore(store => ({ ...store, relays: [{ ...paired,
    targets: [{ ...paired.targets[0]!, requesters: { revision: 2, entries: [] } }],
  }] }));
  expect((await reply({ ...trustedClaim, request_id: "revoked-choice", button_choice: live })).buttons).toEqual([]);
  expect(newTasks()).toEqual([]);
  expect(directives).toEqual([]);
});

test("legacy, group, guest and ordinary chat claims keep the existing path, and unnegotiated ambiguity asks in plain text", async () => {
  const original = claim(owner, "Fix the build output");
  const { type: _type, ...legacyChat } = original.chat;
  for (const ordinary of [
    { ...original, chat: legacyChat },
    { ...original, chat: { ...original.chat, type: "group" } },
    { ...original, delivery: "guest", input: { ...original.input, format: undefined } },
    claim(owner, "How are things with Atlas?"),
  ]) expect(dmTaskTrigger(requestSchema.parse(ordinary))).toBeNull();
  expect(relayClaimCapabilities(paired).features).toContain(feature);
  expect(relayClaimCapabilities({ features: [] }).features).not.toContain(feature);
  const withoutFeature = await reply({ ...original, features: ["relay_rich_messages"] });
  expect(withoutFeature.text).toContain("project");
  expect(withoutFeature.choice_buttons).toBeUndefined();
  expect(withoutFeature.buttons).toEqual([]);
  expect(newTasks()).toEqual([]);
  paired = { ...paired, features: ["relay_rich_messages"] };
  const unsupported = await reply({ ...original, request_id: "claim-feature-only" });
  expect(unsupported.choice_buttons).toBeUndefined();
  expect(newTasks()).toEqual([]);
  const direct = await reply({ ...claim(owner, "Fix Atlas build output", "confident"), features: ["relay_rich_messages"] });
  expect(direct.buttons?.[0]?.[0]?.url).toContain("#task=");
});

test("the wire rejects malformed opt-in and callback claims and leaves legacy tolerant parsing intact", () => {
  const original = claim();
  const event = { sender_key: owner.key, chat_key: chatKey, message_id: "prompt", value: "choice".repeat(4), expires_at: stamp };
  expect(requestSchema.safeParse({ ...original, button_choice: event }).success).toBe(true);
  for (const bad of [
    { ...original, chat: { ...original.chat, type: true } },
    { ...original, chat: { type: "private" } },
    { ...original, chat: { ...original.chat, type: "group" }, button_choice: event },
    { ...original, features: [], button_choice: event },
    { ...original, button_choice: { ...event, expires_at: "later" } },
    { ...original, button_choice: { ...event, sender_key: trusted.key } },
    { ...original, button_choice: { ...event, chat_key: secondChat } },
    { ...original, button_choice: { ...event, extra: true } },
  ]) expect(requestSchema.safeParse(bad).success).toBe(false);
  expect(requestSchema.parse({ ...original, chat: { key: "invalid" } }).chat).toBeUndefined();
  expect(relayChoiceButtonsSchema.safeParse({ message_id: "prompt", expires_at: stamp, rows: [[{ text: "Atlas", url: publicAddress }]] }).success).toBe(false);
});
