import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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
const { accountManager } = await import("@/lib/accounts/manager");
const { selfFile } = await import("@/lib/links/self");
const { persistProjectAliases } = await import("@/lib/projects/aliases");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const structured = await import("@/lib/runtime/structuredMessageDelivery");
const taskStore = await import("@/lib/tasks/store");
const { loadTasks, loadTasksFile, saveTasksFile } = taskStore;
const { runClaimedRequest } = await import("./runner");
const { DmTaskDeliveryRecovery, dmTaskTrigger } = await import("./dmTask");
const { ensureExternalRelayPollers, relayClaimCapabilities, stopExternalRelayPollers } = await import("./poller");
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
let emptyClaim: (() => Promise<void>) | undefined;
let completionRefusal: 415 | 422 | null;
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
  emptyClaim = undefined;
  completionRefusal = null;
  send = spyOn(structured, "enqueueStructuredMessage").mockImplementation(async message => {
    message.admissionGuard?.();
    directives.push(message);
    return { ok: true, structured: true, target: message.conversationId ?? null, outcome: "held", operationId: "fixture-operation" };
  });
  service = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/requests/claim") && emptyClaim) return emptyClaim().then(() => ({ status: 204 }));
    if (req.url?.endsWith("/heartbeat")) {
      heartbeat();
      return { body: { status: "ok" } };
    }
    if (req.url?.endsWith("/complete")) {
      completions.push(body as ExternalRelayCompletion);
      if (completionRefusal !== null) {
        const status = completionRefusal;
        completionRefusal = null;
        return { status, body: { error: { code: status === 422 ? "invalid_format" : "unsupported_media_type" } } };
      }
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

function dmFiles(directory: "dm-tasks" | "dm-task-pending") {
  const dir = path.join(process.env.LLV_STATE_DIR!, "external-relay", directory);
  try { return fs.readdirSync(dir).filter(name => name.endsWith(".json")).sort().map(name => path.join(dir, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
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
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`Restarted relay exited with ${exit}\n${stdout}\n${stderr}`);
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

test("seat delivery retries a temporary refusal with one durable directive identity", async () => {
  let initial: StructuredMessageRequest | undefined;
  send.mockImplementationOnce(async message => {
    initial = message;
    return { ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" };
  });
  const original = claim();
  const pending = await reply(original);
  expect(pending.text).toContain("submitted");
  expect(newTasks()).toHaveLength(1);
  if (!initial) throw new Error("Expected the first directive delivery attempt");
  const completed = await reply({ ...original, request_id: "duplicate-after-delivery" });
  expect(completed.text).toContain("submitted");
  expect(newTasks()).toHaveLength(1);
  expect(directives).toHaveLength(1);
  expect(directives[0]?.clientMessageId).toBe(initial.clientMessageId);
  expect(directives[0]?.text).toBe(initial.text);
});

test("a receipt-only replay requires durable intent and can recover after a post-commit receipt failure", async () => {
  const original = claim(owner, "Fix Atlas build output", "receipt-only-replay");
  const rename = fs.renameSync;
  const write = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (path.basename(path.dirname(String(destination))) === "dm-task-pending") throw new Error("Fixture outbox refusal");
    return rename(source, destination);
  });
  try {
    for (const request_id of [original.request_id, "outbox-still-unavailable"]) {
      expect(await runClaimedRequest(paired, { ...original, request_id }, undefined, { leaseWorker: false }))
        .toMatchObject({ outcome: "failed" });
      const [receipt] = dmFiles("dm-tasks");
      expect(JSON.parse(fs.readFileSync(receipt!, "utf8"))).toMatchObject({ phase: "creating" });
      expect(dmFiles("dm-task-pending")).toEqual([]);
      expect(newTasks()).toEqual([]);
      expect(directives).toEqual([]);
    }
    write.mockImplementation((source, destination) => {
      if (path.basename(path.dirname(String(destination))) === "dm-tasks"
        && JSON.parse(fs.readFileSync(source, "utf8")).phase === "created") throw new Error("Fixture receipt refusal after commit");
      return rename(source, destination);
    });
    expect(await runClaimedRequest(paired, { ...original, request_id: "commit-without-receipt-update" }, undefined, { leaseWorker: false }))
      .toMatchObject({ outcome: "failed" });
    expect(newTasks()).toMatchObject([{ project: atlas, status: "assigned" }]);
    const [pending] = dmFiles("dm-task-pending");
    expect(JSON.parse(fs.readFileSync(pending!, "utf8"))).toMatchObject({ receipt: { phase: "creating" } });
    expect(directives).toEqual([]);
  } finally { write.mockRestore(); }

  const recovery = new DmTaskDeliveryRecovery(() => true);
  try {
    await recovery.run();
    await recovery.run();
    expect(newTasks()).toHaveLength(1);
    expect(directives).toHaveLength(1);
    expect(directives[0]?.text).toContain(newTasks()[0]!.id);
    expect(dmFiles("dm-task-pending")).toEqual([]);
  } finally { await recovery.close(); }
});

test("the bounded worker retires four refused board writes and delivers the fifth intent once", async () => {
  const messages = ["attempt-one", "attempt-two", "attempt-three", "attempt-four", "attempt-five"]
    .map(message => ({ message, hash: createHash("sha256").update(JSON.stringify([paired.id, sampleRequest.target_id, chatKey, message])).digest("hex") }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
  const refuseBoard = spyOn(taskStore, "mutateTasksFile").mockImplementation(() => { throw new Error("Fixture board refusal"); });
  try {
    for (const { message } of messages.slice(0, 4)) {
      const request = claim(owner, "Fix Atlas build output", message);
      expect(await runClaimedRequest(paired, request, undefined, { leaseWorker: false })).toMatchObject({ outcome: "failed" });
    }
    expect(refuseBoard).toHaveBeenCalledTimes(4);
    expect(newTasks()).toEqual([]);
    expect(directives).toEqual([]);
  } finally { refuseBoard.mockRestore(); }

  const [eligible] = messages.slice(4);
  send.mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }))
    .mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }));
  expect((await reply(claim(owner, "Fix Beacon build output", eligible!.message))).text).toContain("unconfirmed");
  const cards = newTasks();
  expect(cards).toMatchObject([{ project: beacon, status: "assigned" }]);
  expect(dmFiles("dm-task-pending").map(file => path.basename(file, ".json"))).toEqual(messages.map(row => row.hash));
  expect(directives).toEqual([]);

  const recovery = new DmTaskDeliveryRecovery(() => true);
  try {
    await recovery.run();
    expect(dmFiles("dm-task-pending")).toHaveLength(1);
    await recovery.run();
    expect(dmFiles("dm-task-pending")).toEqual([]);
    await recovery.run();
    expect(newTasks()).toEqual(cards);
    expect(directives).toHaveLength(1);
    expect(directives[0]).toMatchObject({ conversationId: "conversation_beacon" });
    expect(directives[0]?.text).toContain(cards[0]!.id);
  } finally { await recovery.close(); }
});

test("pending owner delivery recovers after restart without Telegram replay and rechecks live authorization", async () => {
  let first: StructuredMessageRequest | undefined;
  send.mockImplementation(async message => {
    first ??= message;
    return { ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" };
  });
  send.mockImplementationOnce(async message => {
    first = message;
    return { ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" };
  }).mockImplementationOnce(async message => {
    first = message;
    return { ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" };
  });
  const incoming = claim(trusted, "Fix Atlas build output", "durable-pending");
  expect((await reply(incoming)).text).toContain("unconfirmed");
  expect(newTasks()).toHaveLength(1);
  expect(directives).toEqual([]);

  // Model interruption after the board commit and receipt write, while the
  // outbox still contains the pre-commit creating phase.
  const receiptDirectory = path.join(process.env.LLV_STATE_DIR!, "external-relay", "dm-tasks");
  const receiptFile = fs.readdirSync(receiptDirectory).map(name => path.join(receiptDirectory, name))
    .find(file => JSON.parse(fs.readFileSync(file, "utf8")).phase === "created");
  if (!receiptFile) throw new Error("Expected a durable task receipt");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, phase: "creating" }));
  const pendingFile = path.join(process.env.LLV_STATE_DIR!, "external-relay", "dm-task-pending", path.basename(receiptFile));
  const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  fs.writeFileSync(pendingFile, JSON.stringify({ ...pending, receipt: { ...pending.receipt, phase: "creating" } }));
  // This test module captured the shared task-store path before beforeEach
  // selects its per-case relay state; mirror the persisted snapshot into the
  // child process's isolated state root for restart recovery.
  saveTasksFile(loadTasksFile(), path.join(process.env.LLV_STATE_DIR!, "tasks.json"));

  updateRelayStore(store => ({ ...store, relays: [{ ...paired,
    targets: [{ ...paired.targets[0]!, requesters: { revision: 2, entries: [] } }],
  }] }));
  const recoveryOutput = path.join(root, `recovery-${index}.jsonl`);
  const recoverInNewProcess = async () => {
    const child = Bun.spawn([process.execPath, "-e", `
      const { state, output } = await Bun.stdin.json();
      process.env.LLV_STATE_DIR = state;
      const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry");
      setAgentRegistryForTests(new AgentRegistry(state + "/registry.json"));
      const { DmTaskDeliveryRecovery } = await import("./src/lib/externalRelay/dmTask");
      const recovery = new DmTaskDeliveryRecovery(() => true);
      try {
        await recovery.run(async (project, key, text, allowed) => {
          if (!allowed()) return false;
          await Bun.write(output, JSON.stringify({ project, key, text }) + "\\n");
          return true;
        });
      } finally { await recovery.close(); }
    `], { stdin: new Blob([JSON.stringify({ state: process.env.LLV_STATE_DIR, output: recoveryOutput })]), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Recovery process exited with ${exit}\n${stdout}\n${stderr}`);
  };
  await recoverInNewProcess();
  expect(fs.existsSync(recoveryOutput)).toBe(false);

  updateRelayStore(store => ({ ...store, relays: [paired] }));
  await recoverInNewProcess();
  const recovered = fs.readFileSync(recoveryOutput, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ project: atlas, key: first?.clientMessageId, text: first?.text });
  expect(newTasks()).toHaveLength(1);
  await recoverInNewProcess();
  expect(fs.readFileSync(recoveryOutput, "utf8").trim().split("\n")).toHaveLength(1);
});

test("committed delivery resumes after choice expiry with its original directive identity", async () => {
  let originalDirective: StructuredMessageRequest | undefined;
  send.mockImplementationOnce(async message => {
    originalDirective = message;
    return { ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" };
  }).mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }));
  const original = claim(owner, "Fix the build output", "expired-delivery");
  const offered = await reply(original);
  const selection = button(offered, "Atlas");
  const selected = await reply({ ...original, request_id: "select-atlas", button_choice: selection });
  expect(selected.text).toContain("unconfirmed");
  expect(newTasks()).toMatchObject([{ project: atlas }]);
  expect(directives).toEqual([]);
  if (!originalDirective) throw new Error("Expected the refused directive to be recorded");
  now = Date.parse(selection.expires_at);
  const retried = await reply({ ...original, request_id: "retry-after-expiry", button_choice: selection });
  expect(retried.text).toContain("https://board.example.invalid/#task=");
  expect(newTasks()).toHaveLength(1);
  expect(directives).toHaveLength(1);
  expect(directives[0]?.clientMessageId).toBe(originalDirective.clientMessageId);
  expect(directives[0]?.text).toBe(originalDirective.text);
});

test("an expired callback reconciles an existing board card before expiry and rejects foreign keyboard references", async () => {
  send.mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }))
    .mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }));
  const original = claim(owner, "Fix the build output", "commit-before-receipt");
  const offered = await reply(original);
  const selection = button(offered, "Atlas");
  const chosen = { ...original, request_id: "create-then-interrupt", button_choice: selection };
  expect((await reply(chosen)).text).toContain("unconfirmed");
  expect(newTasks()).toHaveLength(1);

  const receipts = path.join(process.env.LLV_STATE_DIR!, "external-relay", "dm-tasks");
  const receiptFile = fs.readdirSync(receipts).map(name => path.join(receipts, name)).find(file => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")).phase === "created"; } catch { return false; }
  });
  if (!receiptFile) throw new Error("Expected the committed task receipt");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, phase: "creating" }));
  fs.unlinkSync(path.join(process.env.LLV_STATE_DIR!, "external-relay", "dm-task-pending", path.basename(receiptFile)));
  now = Date.parse(selection.expires_at);
  const recovered = await reply({ ...chosen, request_id: "expired-replay" });
  expect(recovered.text).toContain("https://board.example.invalid/#task=");
  expect(newTasks()).toHaveLength(1);
  expect(directives).toHaveLength(1);
  expect((await reply({ ...chosen, request_id: "foreign-keyboard", button_choice: { ...selection, message_id: "foreign" } })).buttons).toEqual([]);
  expect(directives).toHaveLength(1);
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

test("a foreign callback has no pending-delivery recovery effects; independent recovery still delivers", async () => {
  send.mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }))
    .mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }));
  const original = claim(owner, "Fix Atlas build output", "callback-pending-delivery");
  expect((await reply(original)).text).toContain("unconfirmed");
  expect(newTasks()).toHaveLength(1);
  expect(directives).toEqual([]);

  const invalid = { sender_key: owner.key, chat_key: chatKey, message_id: "foreign-keyboard",
    value: "v".repeat(32), expires_at: new Date(now + 60_000).toISOString() };
  expect((await reply({ ...original, request_id: "foreign-press", button_choice: invalid })).buttons).toEqual([]);
  expect(directives).toEqual([]);

  const recovery = new DmTaskDeliveryRecovery(() => true);
  try { await recovery.run(); }
  finally { await recovery.close(); }
  expect(directives).toHaveLength(1);
  expect(directives[0]?.text).toContain(newTasks()[0]!.id);
});

test("an accepted DM retries on the release poller cadence while claims stay empty", async () => {
  send.mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }))
    .mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Fixture refusal" }));
  expect((await reply(claim(owner, "Fix Atlas build output", "idle-recovery-seed"))).text).toContain("unconfirmed");
  const [card] = newTasks();
  expect(card).toMatchObject({ project: atlas, status: "assigned" });
  expect(completions).toHaveLength(1);
  expect(dmFiles("dm-task-pending")).toHaveLength(1);
  expect(directives).toEqual([]);

  let claimCount = 0;
  const emptyPolls = Promise.withResolvers<void>();
  const stopClaiming = Promise.withResolvers<void>();
  emptyClaim = async () => {
    if (++claimCount === 3) emptyPolls.resolve();
    if (claimCount >= 3) await stopClaiming.promise;
  };
  // The startup pass leaves the original directive pending for the next
  // tick. Drive the registered timer directly with a frozen clock.
  send.mockImplementationOnce(async () => ({ ok: false, structured: true, status: 503, outcome: "failed", error: "Startup refusal" }));
  const realInterval = globalThis.setInterval;
  let retry: (() => void) | undefined;
  const timer = spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
    if (delay === 60_000) retry = () => callback(...args);
    return realInterval(callback, delay, ...args);
  });
  const recovery = spyOn(DmTaskDeliveryRecovery.prototype, "run");
  try {
    ensureExternalRelayPollers();
    expect(recovery).toHaveBeenCalledTimes(1);
    await recovery.mock.results[0]!.value;
    await emptyPolls.promise;
    expect(send).toHaveBeenCalledTimes(3);
    expect(directives).toEqual([]);
    expect(retry).toBeDefined();
    now += 60_000;
    retry!();
    expect(recovery).toHaveBeenCalledTimes(2);
    await recovery.mock.results[1]!.value;
    expect(directives).toHaveLength(1);
    expect(directives[0]?.clientMessageId).toBe(send.mock.calls[0]![0].clientMessageId);
    expect(directives[0]?.text).toContain(card!.id);
    expect(dmFiles("dm-task-pending")).toEqual([]);
    retry!();
    await recovery.mock.results[2]!.value;
    expect(directives).toHaveLength(1);
    expect(completions).toHaveLength(1);
  } finally {
    stopExternalRelayPollers();
    stopClaiming.resolve();
    recovery.mockRestore();
    timer.mockRestore();
  }
});

test("an explicit Ukrainian task directive creates one project card and owner directive", async () => {
  const explicit = claim(owner, "Постав задачу для Atlas: онови документацію", "uk-task");
  expect(dmTaskTrigger(requestSchema.parse(explicit))?.text).toBe("Постав задачу для Atlas: онови документацію");
  const explicitAnswer = await reply(explicit);
  expect(explicitAnswer.buttons?.[0]?.[0]?.url).toContain("#task=");
  expect(newTasks()).toMatchObject([{ project: atlas }]);
  expect(directives).toHaveLength(1);
});

test("polite explicit task wording enters the claim handler while status requests remain ordinary relay input", async () => {
  const status = claim(owner, "Update us on Atlas", "status-question");
  const explicit = claim(owner, "Could you create a task for Atlas to fix the build?", "polite-task");
  const investigate = claim(owner, "Investigate the failing Atlas build", "investigate");
  expect(dmTaskTrigger(requestSchema.parse(status))).toBeNull();
  expect(dmTaskTrigger(requestSchema.parse(claim(owner, "Перевір статус задачі в Atlas", "uk-status")))).toBeNull();
  expect(dmTaskTrigger(requestSchema.parse(claim(owner, "Проверь статус задачи в Atlas", "ru-status")))).toBeNull();
  expect(dmTaskTrigger(requestSchema.parse(investigate))?.text)
    .toBe("Investigate the failing Atlas build");
  expect(dmTaskTrigger(requestSchema.parse(explicit))?.text).toBe("Could you create a task for Atlas to fix the build?");
  const result = await reply(explicit);
  expect(result.buttons?.[0]?.[0]?.url).toContain("#task=");
  expect(newTasks()).toMatchObject([{ project: atlas, status: "assigned" }]);
  expect(directives).toHaveLength(1);
  const investigation = await reply(investigate);
  expect(investigation.buttons?.[0]?.[0]?.url).toContain("#task=");
  expect(newTasks()).toHaveLength(2);
  expect(directives).toHaveLength(2);
});

test("a task-list request uses ordinary relay routing and explicit card creation still works", async () => {
  const list = claim(owner, "Create a task list for Atlas so I can see what is already open.", "list-open");
  const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "exhausted", resetsAt: null });
  try {
    expect(await runClaimedRequest(paired, list, undefined, { leaseWorker: false }))
      .toMatchObject({ outcome: "declined", reason: "no_capacity" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(completions.at(-1)).toMatchObject({ outcome: "declined", reason: "no_capacity" });
    expect(newTasks()).toEqual([]);
    expect(directives).toEqual([]);
  } finally { select.mockRestore(); }
  for (const text of ["Add a task list for Atlas", "File an issue summary for Atlas", "Створи список задач Atlas"]) {
    expect(dmTaskTrigger(requestSchema.parse(claim(owner, text)))).toBeNull();
  }
  const answer = await reply(claim(owner, "Create a task for Atlas to fix the build", "explicit-create"));
  expect(answer.text).toContain("#task=");
  expect(newTasks()).toMatchObject([{ project: atlas, status: "assigned" }]);
  expect(directives).toHaveLength(1);
});

for (const refusal of [null, 415, 422] as const) test(`the card URL survives tight limits${refusal ? ` after HTTP ${refusal}` : " without URL buttons"}`, async () => {
  const request = claim(owner, "Fix Atlas build output", `tight-url-${refusal}`);
  request.answer.max_chars = 75;
  request.input.format = { ...request.input.format!, formats: { ...request.input.format!.formats, plain: 75 },
    buttons: { ...request.input.format!.buttons, allowed: refusal !== null } };
  if (refusal !== null) completionRefusal = refusal;
  const answer = await reply(request);
  const link = `${publicAddress}/#task=${newTasks()[0]!.id}`;
  expect(answer.text).toBe(link);
  expect(answer.text).toContain("board.example.invalid/#task=");
  expect(answer.buttons).toEqual([]);
  expect(newTasks()).toHaveLength(1);
});

for (const rich of [false, true]) test(`no card is created when a complete link cannot fit the plain fallback${rich ? " after rich downgrade" : " in plain-only mode"}`, async () => {
  const request = claim(owner, "Fix Atlas build output", `unusable-link-${rich}`);
  request.answer.max_chars = 24;
  request.input.format = { ...request.input.format!, formats: { ...request.input.format!.formats, plain: 24 },
    buttons: { ...request.input.format!.buttons, allowed: rich } };
  if (rich) completionRefusal = 415;
  const answer = await reply(request);
  expect(answer.text.length).toBeLessThanOrEqual(24);
  expect(answer.text).not.toContain("#task=");
  expect(newTasks()).toEqual([]);
  expect(directives).toEqual([]);
});

for (const refusal of [415, 422] as const) test(`project clarification keeps resend guidance after HTTP ${refusal} keyboard downgrade`, async () => {
  completionRefusal = refusal;
  const answer = await reply(claim(owner, "Fix the build output", `choice-downgrade-${refusal}`));
  expect(answer.text).toContain("Which project should receive this task?");
  expect(answer.text).toContain("Please resend the full request with the project name.");
  expect(answer.choice_buttons).toBeUndefined();
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
    claim(owner, "Update me on Atlas"),
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
  expect(direct.text).toContain("https://board.example.invalid/#task=");
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
