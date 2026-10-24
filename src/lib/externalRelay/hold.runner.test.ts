import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { procBackend } from "@/lib/proc";
import { drainFile, writeDrain, releaseDrain } from "@/lib/selfUpdate/drain";
import { runClaimedRequest, runningCount, advertisedSlots } from "./runner";
import { reserveRun, dropRun, readRunLedger, externalRelayFile, updateRelayStore, type PairedRelay } from "./store";
import { reserveChainConversation, releaseConversation } from "./conversations";
import { declineHeldRelayRequests } from "./hold";
import { setRelaySwitch } from "./switches";
import { requestSchema } from "./protocol";
import { contextRequest } from "./request.fixture";
import { readAnswerRecord } from "./answers";
import { startTestRelay } from "./testRelay";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hold-test-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const home = path.join(root, "account"); fs.mkdirSync(home);
fs.writeFileSync(path.join(home, "auth.json"), "{}");
fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-sol" }] }));
const account: AccountContext = { engine: "codex", accountId: "fixture", kind: "managed", home, transcriptRoot: home, env: { ...process.env } };
const restoreFeatures = setCodexFeatureReaderForTest(() => [{ name: "multi_agent", stage: "stable", enabled: false }]);
const original = accountManager.resolveHeadlessSpawn;
accountManager.resolveHeadlessSpawn = (() => ({ kind: "available", account })) as typeof original;
afterAll(() => { restoreFeatures(); accountManager.resolveHeadlessSpawn = original; fs.rmSync(root, { recursive: true, force: true }); });
const command = path.join(root, "answer-stub");
fs.writeFileSync(command, `#!/usr/bin/env bun\nconst a=process.argv;await Bun.stdin.text();console.log(JSON.stringify({type:'thread.started',thread_id:crypto.randomUUID()}));await Bun.write(a[a.indexOf('--output-last-message')+1], JSON.stringify({action:'reply',text:'Done',reply_to:'m1'}));`); fs.chmodSync(command, 0o700);
function paired(api_base: string): PairedRelay {
  return { id: "hold-relay", origin: api_base.replace(/\/v1$/, ""), api_base, name: "Test", description: "Test", credential: "x".repeat(43),
    features: ["progress_steps"], owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null }, pairedAt: new Date().toISOString(),
    paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "none", enabled: true, engine: "codex", model: "gpt-6-sol", effort: "low", project: null, concurrency: 1, hardCapMinutes: 1, memberLimitPerHour: 0 }] };
}
const claim = (id: string, budget = 14000) => ({ ...contextRequest, request_id: id, claimed_at: new Date(Date.now() - 500).toISOString(),
  deadline_at: new Date(Date.now() + budget).toISOString(), chat: { key: "ck_3Rw9TtYqL0pZx7VbN2mD4e" },
  input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, key: String(contextRequest.input.requester.key), is_admin: false, is_owner: false } } });
function blocker(relay: PairedRelay, id: string) {
  return { requestId: id, leaseId: "fixture-lease", relayId: relay.id, targetId: "target_1", childPid: null, childIdentity: null,
    ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), runDir: root, startedAt: new Date().toISOString() };
}
test("two owner chains in one chat run together; a reply waits for only its chain", async () => {
  setRelaySwitch("chain_conversations", true);
  let queued = false, queuedBot = false;
  const server = await startTestRelay((req, body) => {
    if (req.url?.includes("/reply-a/heartbeat") && (body as { progress?: { label?: string } }).progress?.label === "queued") queued = true;
    if (req.url?.includes("/reply-bot/heartbeat") && (body as { progress?: { label?: string } }).progress?.label === "queued") queuedBot = true;
    return { body: { status: "ok" } };
  });
  const relay = paired(`${server.origin}/v1`); relay.id = "independent-owner-chains";
  relay.targets[0]!.ownerTier = true; relay.targets[0]!.concurrency = 3;
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  let launches = 0, sends = 0; const observed = new Set<string>();
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const make = (id: string, parent: string | null) => ({ ...claim(id, 20000), input: { ...claim(id).input,
    requester: { ...contextRequest.input.requester, is_owner: true }, respond_to: id,
    conversation: [{ ...contextRequest.input.conversation[0]!, id, reply_to: parent }] } });
  const ports: import("./ownerRun").OwnerRunPorts = {
    launch: async () => { launches++; return { status: 202, body: { conversationId: `conversation_parallel_${launches}` } }; },
    continue: async turn => { sends++; return { ok: true, structured: true, target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId }; },
    observe: async turn => { observed.add(turn.conversationId!); await gate; return { state: "ended", finalText: "Done" }; },
    stop: async () => {}, pollMs: 1,
  };
  const wait = async (predicate: () => boolean) => { const until = Date.now() + 5000; while (!predicate() && Date.now() < until) await Bun.sleep(10); expect(predicate()).toBe(true); };
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(runClaimedRequest(relay, make("root-a", null), undefined, { ownerPorts: ports }));
    await wait(() => observed.size === 1);
    pending.push(runClaimedRequest(relay, make("root-b", null), undefined, { ownerPorts: ports }));
    await wait(() => observed.size === 2);
    expect(launches).toBe(2); expect(runningCount(relay.id, "target_1")).toBe(2);
    const reply = make("reply-a", "bot-a");
    const bot = { ...reply.input.conversation[0]!, id: "bot-a", author: { key: "fixture-bot", name: "Assistant", self: true }, reply_to: "root-a" };
    reply.input.conversation.unshift(make("root-a", null).input.conversation[0]!, bot as never);
    pending.push(runClaimedRequest(relay, reply, undefined, { ownerPorts: ports }));
    // The reply cannot reserve a third conversation while its parent is live.
    await wait(() => queued);
    expect(launches).toBe(2); expect(sends).toBe(0);
    // This window lost the ancestor. Learning the bot anchor while the first
    // reply is held must already be durable, before either turn can resume.
    const truncated = make("reply-bot", "bot-a");
    truncated.input.conversation.unshift({ ...bot, reply_to: null } as never);
    pending.push(runClaimedRequest(relay, truncated, undefined, { ownerPorts: ports }));
    await wait(() => queuedBot || launches > 2);
    expect(launches).toBe(2); expect(queuedBot).toBe(true);
    release();
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ outcome: "answered" });
    expect(launches).toBe(2); expect(sends).toBe(2);
  } finally { release(); await Promise.allSettled(pending); await server.close(); }
}, 15000);

for (const cause of ["drain", "capacity", "chat"] as const) for (const release of [true, false])
  test(`${cause} hold acknowledges, queues, then ${release ? "serves" : "declines busy at the bound"} without taking execution capacity`, async () => {
    const beats: { progress: { label: string } | null }[] = [];
    const completions: { outcome: string; reason?: string; detail?: string | null }[] = [];
    const server = await startTestRelay((req, body) => {
      if (req.url?.endsWith("/heartbeat")) beats.push(body as typeof beats[number]);
      if (req.url?.endsWith("/complete")) completions.push(body as typeof completions[number]);
      return { body: { status: "ok" } };
    });
    const relay = paired(`${server.origin}/v1`); if (cause === "chat") relay.targets[0]!.concurrency = 2;
    const held = { ...claim(`${cause}-${release}`, release ? 15000 : 14000), liveness: { ...contextRequest.liveness, heartbeat_interval_s: cause === "drain" && release ? 2 : 10 } };
    setRelaySwitch("chain_conversations", cause === "chat");
    let conversationId: string | undefined;
    const clear = () => { releaseDrain(drainFile(), "hold-test"); if (conversationId) releaseConversation(conversationId); dropRun("blocker"); };
    if (cause === "drain") writeDrain(drainFile(), { id: "hold-test", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    else { reserveRun(blocker(relay, "blocker")); if (cause === "chat") conversationId = reserveChainConversation(relay, relay.targets[0]!, requestSchema.parse({ ...held, request_id: "blocker" }), "member")!.id; }
    const start = performance.now();
    const pending = runClaimedRequest(relay, held, undefined, { command });
    try {
      await Bun.sleep(3300);
      expect(completions).toEqual([]);
      expect(beats[0]?.progress?.label).toBe("accepted");
      expect(beats.some(b => b.progress?.label === "queued")).toBe(true);
      expect(readRunLedger().runs.filter(r => r.requestId === held.request_id)).toEqual([]);
      expect(runningCount(relay.id, "target_1")).toBe(0);
      expect(await runClaimedRequest(relay, held, undefined, { command })).toBeNull();
      if (release) clear();
      const result = await pending;
      if (release) expect(result).toMatchObject({ outcome: "answered", answer: { text: "Done" } });
      else { expect(result).toMatchObject({ outcome: "declined", reason: "busy", detail: cause === "chat" ? "chat busy" : null });
        expect(performance.now() - start).toBeGreaterThanOrEqual(3900); expect(performance.now() - start).toBeLessThan(5000); }
      expect(completions).toHaveLength(1);
      expect(readRunLedger().runs.length).toBeLessThanOrEqual(relay.targets[0]!.concurrency);
    } finally { clear(); await pending; setRelaySwitch("chain_conversations", false); await server.close(); }
  }, 12000);

test("capacity waiters take released slots in order within the configured limit", async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const relay = paired(`${server.origin}/v1`);
  const orderFile = path.join(root, "admission-order");
  const live = path.join(root, "live-children"); fs.mkdirSync(live);
  const releaseFiles: string[] = [];
  function controlled(id: string) {
    const file = path.join(root, `controlled-${id}`), release = path.join(root, `release-${id}`); releaseFiles.push(release);
    fs.writeFileSync(file, `#!/usr/bin/env bun\nimport fs from 'node:fs';const a=process.argv;await Bun.stdin.text();
fs.writeFileSync(${JSON.stringify(path.join(live, id))}, 'live');fs.appendFileSync(${JSON.stringify(orderFile)}, ${JSON.stringify(id + "\n")});
while(!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
fs.rmSync(${JSON.stringify(path.join(live, id))});await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:'m1'}));`); fs.chmodSync(file, 0o700); return file;
  }
  const pending: Promise<unknown>[] = [];
  let largestLedger = 0, largestChildren = 0, largestActive = 0;
  const probe = setInterval(() => {
    largestLedger = Math.max(largestLedger, readRunLedger().runs.filter(r => r.relayId === relay.id).length);
    largestChildren = Math.max(largestChildren, fs.readdirSync(live).length);
    largestActive = Math.max(largestActive, runningCount(relay.id, "target_1"));
  }, 10);
  async function waitOrder(expected: string) {
    for (let i = 0; i < 300 && (!fs.existsSync(orderFile) || !fs.readFileSync(orderFile, "utf8").includes(expected)); i++) await Bun.sleep(10);
    expect(fs.readFileSync(orderFile, "utf8")).toContain(expected);
  }
  try {
    pending.push(runClaimedRequest(relay, claim("order-a", 60000), undefined, { command: controlled("a") }));
    await waitOrder("a\n");
    pending.push(runClaimedRequest(relay, claim("order-b", 60000), undefined, { command: controlled("b") }));
    await Bun.sleep(100);
    pending.push(runClaimedRequest(relay, claim("order-c", 60000), undefined, { command: controlled("c") }));
    await Bun.sleep(100); fs.writeFileSync(releaseFiles[0]!, "go");
    await pending[0]; expect(advertisedSlots(relay)).toEqual([{ target_id: "target_1", free: 0 }]);
    await waitOrder("b\n"); fs.writeFileSync(releaseFiles[1]!, "go"); await pending[1];
    await waitOrder("c\n"); fs.writeFileSync(releaseFiles[2]!, "go"); await pending[2];
    expect(fs.readFileSync(orderFile, "utf8")).toBe("a\nb\nc\n");
    expect(largestLedger).toBe(1); expect(largestChildren).toBe(1); expect(largestActive).toBe(1);
  } finally { for (const file of releaseFiles) fs.writeFileSync(file, "go"); await Promise.all(pending); clearInterval(probe); await server.close(); }
}, 15000);

for (const value of ["unparseable", "past", "absent", "valid-late"] as const) test(`raw deadline ${value} and shrinking service stall windows`, async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const request = claim(`raw-${value}`);
  const raw = { ...request, deadline_at: value === "unparseable" ? "tomorrow" : value === "past" ? request.claimed_at : value === "absent" ? undefined : request.deadline_at,
    liveness: { ...request.liveness, claim_window_s: 120, stall_window_s: value === "valid-late" ? 14 : 120 } };
  try {
    const start = performance.now();
    expect(await runClaimedRequest(paired(`${server.origin}/v1`), raw, undefined, { command })).toMatchObject(
      value === "past" ? { outcome: "declined", reason: "busy" } : { outcome: "answered" });
    if (value === "past") { expect(performance.now() - start).toBeLessThan(500); expect(readRunLedger().runs.some(r => r.requestId === raw.request_id)).toBe(false); }
  }
  finally { await server.close(); }
});

for (const stallSeconds of [14, 10]) test(`shrinking stall window ${stallSeconds}s bounds unacknowledged admission`, async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let completions = 0;
  const server = await startTestRelay(req => {
    if (req.url?.endsWith("/heartbeat")) {
      now += 11000;
      return { status: 503, body: { error: { code: "unavailable" } } };
    }
    completions++;
    return { body: { status: "ok" } };
  });
  const relay = paired(`${server.origin}/v1`);
  reserveRun(blocker(relay, "stall-blocker"));
  try {
    const result = await runClaimedRequest(relay, { ...claim(`stall-${stallSeconds}`),
      liveness: { ...contextRequest.liveness, stall_window_s: stallSeconds } }, undefined, { command });
    if (stallSeconds === 10) { expect(result).toBeNull(); expect(completions).toBe(0); }
    else { expect(result).toMatchObject({ outcome: "declined", reason: "busy" }); expect(completions).toBe(1); }
    expect(runningCount(relay.id, "target_1")).toBe(0);
  } finally { dropRun("stall-blocker"); clock.mockRestore(); await server.close(); }
});

for (const outcome of ["no_capacity", "member_limit"] as const) test(`${outcome} is explicit before a drain hold and after capacity returns`, async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const relay = paired(`${server.origin}/v1`); relay.id = `early-${outcome}`;
  relay.targets[0]!.memberLimitPerHour = 1;
  const previous = accountManager.resolveHeadlessSpawn;
  try {
    if (outcome === "member_limit") expect(await runClaimedRequest(relay, claim(`${outcome}-used`), undefined, { command })).toMatchObject({ outcome: "answered" });
    else accountManager.resolveHeadlessSpawn = (() => ({ kind: "exhausted", resetsAt: Math.floor(Date.now() / 1000) + 60 })) as typeof previous;
    writeDrain(drainFile(), { id: "early-outcome", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    const started = performance.now();
    expect(await runClaimedRequest(relay, claim(`${outcome}-early`), undefined, { command })).toMatchObject({ outcome: "declined", reason: outcome });
    expect(performance.now() - started).toBeLessThan(500);
    releaseDrain(drainFile(), "early-outcome"); accountManager.resolveHeadlessSpawn = previous;
    reserveRun(blocker(relay, "recheck-blocker"));
    const held = claim(`${outcome}-recheck`, 20000);
    if (outcome === "member_limit") held.input.requester.key = "another-member";
    const pending = runClaimedRequest(relay, held, undefined, { command });
    await Bun.sleep(200);
    if (outcome === "no_capacity") accountManager.resolveHeadlessSpawn = (() => ({ kind: "unavailable" })) as typeof previous;
    else {
      const { answerRecorder } = await import("./answers");
      const answer = answerRecorder({ requestId: "companion-answer", relayId: relay.id, targetId: "target_1", targetName: "Target", claimedAt: held.claimed_at,
        chatKey: held.chat.key, requester: held.input.requester, input: held.input })!;
      answer.begin("codex", "gpt-6-sol", { webSearch: false });
      answer.finish({ outcome: "answered", answer: { action: "reply", text: "Other", reply_to: null }, delivery: "accepted" });
    }
    dropRun("recheck-blocker");
    expect(await pending).toMatchObject({ outcome: "declined", reason: outcome });
  } finally { accountManager.resolveHeadlessSpawn = previous; releaseDrain(drainFile(), "early-outcome"); dropRun("recheck-blocker"); await server.close(); }
});

test("acknowledgements, lock waits, reentry after a drain and completion failures never renew the deadline", async () => {
  const sends: number[] = [], completions: number[] = [];
  const server = await startTestRelay(req => {
    if (req.url?.endsWith("/heartbeat")) { sends.push(performance.now()); return { body: { status: "ok" } }; }
    completions.push(performance.now()); return { status: 503, body: { error: { code: "unavailable" } } };
  });
  const relay = paired(`${server.origin}/v1`);
  const previous = accountManager.resolveHeadlessSpawn; let selections = 0;
  accountManager.resolveHeadlessSpawn = (() => {
    if (++selections === 2) writeDrain(drainFile(), { id: "reentry", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    return { kind: "available", account };
  }) as typeof previous;
  reserveRun(blocker(relay, "nonrenew-blocker"));
  const start = performance.now();
  const pending = runClaimedRequest(relay, claim("nonrenew", 15000), undefined, { command });
  let unlock: ReturnType<typeof setTimeout> | undefined;
  const lock = `${externalRelayFile("runs")}.lock`;
  try {
    await Bun.sleep(3300); dropRun("nonrenew-blocker");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, identity: procBackend.processIdentity(process.pid) }), { flag: "wx" });
    unlock = setTimeout(() => fs.rmSync(lock, { force: true }), 1000);
    expect(await pending).toMatchObject({ outcome: "declined", reason: "busy" });
    expect(selections).toBeGreaterThanOrEqual(2);
    expect(completions[0]! - start).toBeGreaterThanOrEqual(4900);
    expect(completions[0]! - start).toBeLessThan(6100);
    expect(performance.now() - start).toBeLessThan(15500);
    expect(sends.length).toBeGreaterThanOrEqual(3);
    expect(completions.every(at => at - start < 15000)).toBe(true);
  } finally { clearTimeout(unlock); fs.rmSync(lock, { force: true }); releaseDrain(drainFile(), "reentry"); dropRun("nonrenew-blocker"); accountManager.resolveHeadlessSpawn = previous; await pending; await server.close(); }
}, 20000);

for (const recovery of [true, false]) test(`owner first-message hold ${recovery ? "recovers" : "reaches the target cap"} with queued progress`, async () => {
  const beats: { progress: { label: string } | null }[] = [], stops: string[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) beats.push(body as typeof beats[number]);
    return { body: { status: "ok" } };
  });
  const relay = paired(`${server.origin}/v1`); relay.targets[0]!.ownerTier = true;
  relay.targets[0]!.hardCapMinutes = 5000 / 60_000;
  updateRelayStore(s => ({ ...s, relays: [relay] }));
  const request = { ...claim(`owner-hold-${recovery}`), liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2 } };
  request.input.requester.is_owner = true;
  const start = performance.now();
  try {
    const result = await runClaimedRequest(relay, request, undefined, { ownerPorts: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_first_message", initialMessage: "queued" } }),
      observe: async () => recovery && performance.now() - start >= 3300 ? { state: "ended", firstMessagePending: false, finalText: "Done" } : { state: "running", firstMessagePending: true },
      stop: async (_id, action) => { stops.push(action); }, pollMs: 10,
    } });
    expect(beats[0]?.progress?.label).toBe("accepted");
    expect(beats.some(b => b.progress?.label === "queued")).toBe(true);
    expect(result).toMatchObject(recovery ? { outcome: "answered", answer: { text: "Done" } } : { outcome: "answered", answer: { text: expect.stringMatching(/ran out of time/i) } });
    expect(stops).toEqual(recovery ? [] : ["kill"]);
    expect(performance.now() - start).toBeLessThan(6500);
  } finally { await server.close(); }
}, 10000);

test("capacity returning at the admission cutoff cannot start expired waiting work", async () => {
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const relay = paired(`${server.origin}/v1`); reserveRun(blocker(relay, "cutoff-blocker"));
  // Keep the service timestamp on the same clock as the mocked local cutoff.
  const pending = runClaimedRequest(relay, { ...claim("cutoff-return", 11000),
    deadline_at: new Date(now + 11000).toISOString() }, undefined, { command });
  try {
    await Bun.sleep(150); now += 1000; dropRun("cutoff-blocker");
    expect(await pending).toMatchObject({ outcome: "declined", reason: "busy" });
  } finally { dropRun("cutoff-blocker"); await pending; clock.mockRestore(); await server.close(); }
}, 5000);

test("an orphan conversation has free chat capacity and is recovered before admission", async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const relay = paired(`${server.origin}/v1`);
  const request = claim("orphan-chat", 11000);
  setRelaySwitch("chain_conversations", true);
  const record = reserveChainConversation(relay, relay.targets[0]!, requestSchema.parse({ ...request, request_id: "absent-owner" }), "member")!;
  try {
    expect(await runClaimedRequest(relay, request, undefined, { command })).toMatchObject({ outcome: "answered" });
  } finally { releaseConversation(record.id); setRelaySwitch("chain_conversations", false); await server.close(); }
});

test("lease loss during an asynchronous admission wait starts no agent and consumes no allowance", async () => {
  let completions = 0;
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat") && (body as { seq: number }).seq > 1)
      return { status: 409, body: { error: { code: "lease_lost" } } };
    if (req.url?.endsWith("/complete")) completions++;
    return { body: { status: "ok" } };
  });
  const relay = paired(`${server.origin}/v1`);
  const lock = `${externalRelayFile("runs")}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, identity: procBackend.processIdentity(process.pid) }), { flag: "wx" });
  const request = { ...claim("lost-during-admission", 20000), liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2 } };
  const unlock = setTimeout(() => fs.rmSync(lock, { force: true }), 2600);
  try {
    expect(await runClaimedRequest(relay, request, undefined, { command })).toBeNull();
    expect(completions).toBe(0);
    expect(readAnswerRecord(relay.id, "target_1", request.request_id)?.admitted).toBe(false);
    expect(readRunLedger().runs).toEqual([]);
  } finally { clearTimeout(unlock); fs.rmSync(lock, { force: true }); await server.close(); }
}, 10000);

test("member allowance is rechecked after a store admission wait", async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const relay = paired(`${server.origin}/v1`); relay.id = "member-store-wait"; relay.targets[0]!.memberLimitPerHour = 1;
  const request = claim("member-after-lock", 20000);
  const lock = `${externalRelayFile("runs")}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, identity: procBackend.processIdentity(process.pid) }), { flag: "wx" });
  const pending = runClaimedRequest(relay, request, undefined, { command });
  try {
    await Bun.sleep(100);
    const { answerRecorder } = await import("./answers");
    const answer = answerRecorder({ requestId: "member-lock-companion", relayId: relay.id, targetId: "target_1", targetName: "Target",
      claimedAt: request.claimed_at, chatKey: request.chat.key, requester: request.input.requester, input: request.input })!;
    answer.begin("codex", "gpt-6-sol", { webSearch: false });
    answer.finish({ outcome: "answered", answer: { action: "reply", text: "Other", reply_to: null }, delivery: "accepted" });
    fs.rmSync(lock, { force: true });
    expect(await pending).toMatchObject({ outcome: "declined", reason: "member_limit" });
    expect(readAnswerRecord(relay.id, "target_1", request.request_id)?.admitted).toBe(false);
  } finally { fs.rmSync(lock, { force: true }); await pending; await server.close(); }
});

test("demotion sends one explicit busy attempt and respects its own bounded exit", async () => {
  let attempts = 0;
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.includes("slow-demotion") && req.url.endsWith("/heartbeat") && (body as { seq: number }).seq > 1) await Bun.sleep(1000);
    if (req.url?.endsWith("/complete")) { attempts++; await Bun.sleep(800); return { status: 503, body: { error: { code: "unavailable" } } }; }
    return { body: { status: "ok" } };
  });
  const relay = paired(`${server.origin}/v1`);
  writeDrain(drainFile(), { id: "demotion", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
  const pending = Promise.all([
    runClaimedRequest(relay, claim("demotion", 30000), undefined, { command }),
    runClaimedRequest(relay, claim("slow-demotion", 30000), undefined, { command }),
  ]);
  try {
    await Bun.sleep(3300);
    const start = performance.now(); await declineHeldRelayRequests(500);
    expect(performance.now() - start).toBeLessThan(600);
    expect(attempts).toBe(2);
    expect(await pending).toMatchObject([{ outcome: "declined", reason: "busy" }, { outcome: "declined", reason: "busy" }]);
  } finally { releaseDrain(drainFile(), "demotion"); await pending; await server.close(); }
}, 10000);
