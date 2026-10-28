import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { conversationAuthority, reserveChainConversation, reserveChainConversationAsync, releaseConversation, readConversations, prepareConversationAccount, sweepConversations, sweepConversationsAsync } from "./conversations";
import { sampleRequest, contextRequest } from "./request.fixture";
import { externalRelayFile, newTargetSettings, readRunLedger, reserveRun, dropRun, withFileLock, writeRelayFile, type PairedRelay, type RunRecord } from "./store";
import { requestSchema, type ExternalRelayRequest } from "./protocol";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conversations-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => { sweepConversations([], []); fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => sweepConversations([], []));
const target = { ...newTargetSettings({ target_id: "t", name: "Target", answered_by: "install", fallback: "service" }), engine: "claude" as const, model: "haiku" };
const relay = { id: "r", targets: [target] } as PairedRelay;
const request = (id = "root", parent: string | null = null): ExternalRelayRequest => requestSchema.parse({ ...contextRequest, request_id: id, chat: { key: "fixture-chat-chain" }, input: { ...contextRequest.input,
  respond_to: id, conversation: [{ ...contextRequest.input.conversation[0]!, id, reply_to: parent }] } });

for (const asyncSweep of [false, true]) for (const state of ["pending", "confirmed", "delivery", "quarantined"] as const)
test(`${asyncSweep ? "async" : "sync"} chain sweep separates ${state} custody from execution`, async () => {
  const record = reserveChainConversation(relay, target, request(), "owner-tier")!;
  const turn: NonNullable<RunRecord["ownerTurn"]> = { clientAttemptId: "relay-owner-root", ...(state !== "delivery" ? { cancel: "kill" as const } : {}), admissionComplete: true,
    ...(state === "confirmed" ? { confirmed: true } : {}),
    ...(state === "quarantined" ? { quarantinedAt: "2026-10-28T12:00:00Z" } : {}) };
  reserveRun({ requestId: "root", relayId: relay.id, targetId: target.id, leaseId: "fixture", childPid: null, childIdentity: null,
    ownerPid: process.pid, ownerIdentity: "fixture", runDir: root, startedAt: record.createdAt, ownerTurn: turn,
    ...(state === "delivery" ? { capacityReleased: true as const } : {}) });
  try {
    if (asyncSweep) await sweepConversationsAsync([relay], Date.parse(record.createdAt), Date.now() + 5000);
    else sweepConversations([relay], readRunLedger().runs, Date.parse(record.createdAt));
    expect(readConversations().find(row => row.id === record.id)).toMatchObject({
      state: state === "pending" ? "running" : state === "quarantined" ? "broken" : "idle",
      runningRequestId: state === "pending" ? "root" : null });
    expect(reserveChainConversation(relay, target, request("next", "root"), "owner-tier") === null).toBe(state === "pending");
    expect(readRunLedger().runs.find(row => row.requestId === "root")?.ownerTurn).toEqual(turn);
  } finally { dropRun("root"); }
});

test("late cleanup and attribution cannot overwrite a successor's chain reservation", async () => {
  const { releaseConversationAsync } = await import("./conversations");
  const first = reserveChainConversation(relay, target, request(), "owner-tier")!;
  releaseConversation(first.id, { state: "broken" });
  const next = reserveChainConversation(relay, target, request("next", "root"), "owner-tier")!;
  expect(next.id).toBe(first.id);
  for (const patch of [{ state: "broken" as const }, { state: "running" as const, runningRequestId: "root", conversationId: "conversation_old" }]) {
    await releaseConversationAsync(first.id, patch, Date.now() + 5000, "root");
    expect(readConversations().find(row => row.id === next.id)).toMatchObject({ state: "running", runningRequestId: "next", conversationId: null });
  }
});
test("a requester and their authority scope every chain", () => {
  expect(conversationAuthority()).toBeNull();
  expect(conversationAuthority(contextRequest.input.requester)).toBe("admin");
  const first = reserveChainConversation(relay, target, request(), "owner-tier")!;
  releaseConversation(first.id);
  const reply = request("reply", "root");
  expect(reserveChainConversation(relay, target, reply, "member")!.id).not.toBe(first.id);
  expect(reserveChainConversation(relay, target, { ...reply, chat: { key: "other-chat" } }, "owner-tier")!.id).not.toBe(first.id);
  expect(reserveChainConversation(relay, target, { ...reply, input: { ...reply.input, requester: { ...reply.input.requester!, key: "another-requester" } } }, "owner-tier")!.id).not.toBe(first.id);
  expect(reserveChainConversation(relay, target, reply, "owner-tier")!.id).toBe(first.id);
});
test("an owner skips a member pin; learned bot anchors survive a truncated window", () => {
  const owner = reserveChainConversation(relay, target, request(), "owner-tier")!; releaseConversation(owner.id);
  const member = reserveChainConversation(relay, target, request("member", "root"), "member")!; releaseConversation(member.id);
  const next = request("next", "member"); next.input.conversation.unshift(request().input.conversation[0]!, request("member", "root").input.conversation[0]!);
  expect(reserveChainConversation(relay, target, next, "owner-tier")!.id).toBe(owner.id); releaseConversation(owner.id);
  const learned = request("third", "bot"); learned.input.conversation.unshift({ ...request("bot", "next").input.conversation[0]!, author: { key: "bot", name: "Assistant", self: true } });
  expect(reserveChainConversation(relay, target, learned, "owner-tier")!.id).toBe(owner.id); releaseConversation(owner.id);
  expect(reserveChainConversation(relay, target, request("fourth", "bot"), "owner-tier")!.id).toBe(owner.id);
});
test("unknown roots, malformed cycles and an engine change start fresh", () => {
  const first = reserveChainConversation(relay, target, request(), "member")!; releaseConversation(first.id);
  for (const reply of [request("unknown", "missing"), request("cycle", "cycle"), request("separate")])
    expect(reserveChainConversation(relay, target, reply, "member")!.id).not.toBe(first.id);
  expect(reserveChainConversation(relay, { ...target, engine: "codex" }, request("engine", "root"), "member")!.id).not.toBe(first.id);
});
test("seen and anchors are bounded, and owner expiry removes no operator files", () => {
  const first = reserveChainConversation(relay, target, request(), "owner-tier")!;
  const sentinel = path.join(root, "operator-transcript"); fs.writeFileSync(sentinel, "preserve");
  releaseConversation(first.id, { conversationId: sentinel, lastTurnAt: "2026-10-01T00:00:00Z" });
  sweepConversations([relay], [], Date.parse("2026-10-04T00:00:00Z") + 1);
  expect(readConversations()).toEqual([]); expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve");
  const record = reserveChainConversation(relay, target, request(), "member")!;
  releaseConversation(record.id, { anchors: Array.from({ length: 200 }, (_, i) => `a${i}`) });
  const reply = reserveChainConversation(relay, target, request("last", "a199"), "member")!;
  expect(reply.anchors).toHaveLength(200); expect(reply.anchors.at(-1)).toBe("last"); expect(reply.anchors).not.toContain("a0");
});
test("300 records evict the oldest idle chain, never a running one", () => {
  const seed = reserveChainConversation(relay, target, request(), "owner-tier")!;
  const rows = Array.from({ length: 300 }, (_, i) => ({ ...seed, id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, anchors: [`root-${i}`],
    state: i === 0 ? "running" : "idle", lastTurnAt: new Date(i * 1000).toISOString() }));
  writeRelayFile(path.join(root, "external-relay/conversations.json"), { v: 2, conversations: rows });
  reserveChainConversation(relay, target, request("new"), "owner-tier");
  expect(readConversations()).toHaveLength(300); expect(readConversations().some(r => r.id === rows[0]!.id)).toBe(true);
  expect(readConversations().some(r => r.id === rows[1]!.id)).toBe(false);
});
test("admission orphan recovery takes the ledger after its lock wait and walks no transcripts", async () => {
  const record = reserveChainConversation(relay, target, request(), "member")!;
  const file = path.join(root, "external-relay/conversations.json"); let pending!: Promise<void>;
  const reads = spyOn(fs, "readdirSync");
  try {
    withFileLock(file, () => {
      pending = sweepConversationsAsync([relay], Date.now(), Date.now() + 5000, relay.id);
      reserveRun({ requestId: "root", leaseId: "fixture-lease", relayId: relay.id, targetId: target.id, childPid: null, childIdentity: null,
        ownerPid: process.pid, ownerIdentity: "fixture", runDir: root, startedAt: new Date().toISOString() });
    });
    await pending;
    expect(readConversations().find(r => r.id === record.id)?.state).toBe("running");
    expect(reads).not.toHaveBeenCalled();
  } finally { reads.mockRestore(); dropRun("root"); releaseConversation(record.id); }
});

test("a run-ledger replacement during a sweep keeps the running chain reserved", async () => {
  const ownerRequest = request("live-run");
  const record = reserveChainConversation(relay, target, ownerRequest, "member")!;
  const runsFile = path.join(root, "external-relay/runs.json");
  writeRelayFile(runsFile, { v: 1, runs: [] });
  const originalStat = fs.promises.stat.bind(fs.promises);
  let ledgerStats = 0;
  const interceptedStat = async (filename: string) => {
    if (String(filename) === runsFile && ++ledgerStats === 2) {
      reserveRun({ requestId: "live-run", leaseId: "fixture-lease", relayId: relay.id, targetId: target.id, childPid: null, childIdentity: null,
        ownerPid: process.pid, ownerIdentity: "fixture", runDir: root, startedAt: new Date().toISOString() });
    }
    return originalStat(filename);
  };
  const stat = spyOn(fs.promises, "stat").mockImplementation(interceptedStat as typeof fs.promises.stat);
  try {
    await sweepConversationsAsync([relay], Date.now(), Date.now() + 5000, relay.id);
    expect(readConversations().find(row => row.id === record.id)?.state).toBe("running");
    expect(reserveChainConversation(relay, target, request("reply", "live-run"), "member")).toBeNull();
  } finally {
    stat.mockRestore();
    dropRun("live-run");
    releaseConversation(record.id);
  }
});

test("a conversation-map replacement during a cold lookup is never cached with the old rows", async () => {
  const api = await import("./conversations");
  const previousState = process.env.LLV_STATE_DIR;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "relay-map-cache-race-"));
  process.env.LLV_STATE_DIR = isolated;
  const filename = externalRelayFile("runs").replace(/runs\.json$/, "conversations.json");
  try {
    const seed = reserveChainConversation(relay, target, request(), "member")!;
    releaseConversation(seed.id);
    const rows = readConversations();
    writeRelayFile(filename, { v: 2, conversations: rows });
    const replacement = rows.map(row => ({ ...row, anchors: ["replacement-root"] }));
    const originalStat = fs.promises.stat.bind(fs.promises);
    let mapStats = 0;
    const interceptedStat = async (pathLike: string) => {
      if (pathLike === filename && ++mapStats === 3)
        writeRelayFile(filename, { v: 2, conversations: replacement });
      return originalStat(pathLike);
    };
    const stat = spyOn(fs.promises, "stat").mockImplementation(interceptedStat as typeof fs.promises.stat);
    try {
      expect(await api.lookupChainConversationAsync(relay, target, request("reply", "root"), "member")).toBeNull();
      expect(mapStats).toBeGreaterThanOrEqual(5);
    } finally { stat.mockRestore(); }
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

test("unchanged held chain resolution does not rewrite retained conversation history", async () => {
  const seed = reserveChainConversation(relay, target, request(), "owner-tier")!;
  releaseConversation(seed.id);
  const rows = Array.from({ length: 299 }, (_, i) => ({ ...seed,
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`, anchors: [`unrelated-${i}`],
    seen: Array.from({ length: 200 }, (_, j) => `seen-${i}-${j}`) }));
  writeRelayFile(path.join(root, "external-relay/conversations.json"), { v: 2, conversations: [seed, ...rows] });
  const filename = path.join(root, "external-relay/conversations.json");
  const before = fs.statSync(filename);
  const unrelated = request("unknown-root", null);
  for (let i = 0; i < 3; i++) await (await import("./conversations")).resolveChainConversationAsync(relay, target, unrelated, "owner-tier", Date.now() + 5000);
  const after = fs.statSync(filename);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.size).toBe(before.size);
});

test("large chain admission yields to the Viewer loop and avoids unchanged cursor rewrites", async () => {
  const seed = reserveChainConversation(relay, target, request(), "owner-tier")!;
  releaseConversation(seed.id);
  const rows = Array.from({ length: 299 }, (_, i) => ({ ...seed,
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`, anchors: [`large-${i}`],
    seen: Array.from({ length: 200 }, (_, j) => `seen-${i}-${j}-${"x".repeat(42)}`), state: "idle" as const, runningRequestId: null }));
  const filename = path.join(root, "external-relay/conversations.json");
  writeRelayFile(filename, { v: 2, conversations: [seed, ...rows] });
  const inputBytes = fs.statSync(filename).size;
  const admissionMs: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    let timerRan = false;
    const timer = new Promise<boolean>(resolve => setImmediate(() => { timerRan = true; resolve(true); }));
    const started = performance.now();
    const admission = reserveChainConversationAsync(relay, target, request(`async-new-${sample}`), "owner-tier", Date.now() + 5000);
    const first = await Promise.race([timer, admission.then(() => false)]);
    expect(first).toBe(true);
    expect(timerRan).toBe(true);
    expect(await admission).not.toBeNull();
    admissionMs.push(performance.now() - started);
  }
  console.log("RELAY_MAP_ADMISSION", JSON.stringify({ records: 300, bytes: inputBytes, eventLoopResponsiveSamples: 5,
    admissionMs, load: os.loadavg() }));
  const before = fs.statSync(filename);
  await (await import("./conversations")).releaseConversationAsync(rows[0]!.id, { state: "idle", runningRequestId: null }, Date.now() + 5000);
  const after = fs.statSync(filename);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ino).toBe(before.ino);
});

test("async sweeps and already-running admissions skip unchanged conversation writes", async () => {
  const api = await import("./conversations");
  const requestForRun = request("async-running");
  const record = await reserveChainConversationAsync(relay, target, requestForRun, "owner-tier", Date.now() + 5000);
  expect(record?.runningRequestId).toBe("async-running");
  reserveRun({ requestId: "async-running", leaseId: "fixture-lease", relayId: relay.id, targetId: target.id,
    childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: "fixture", runDir: root,
    startedAt: new Date().toISOString() });
  const filename = path.join(root, "external-relay/conversations.json");
  const before = fs.statSync(filename);
  try {
    await api.sweepConversationsAsync([relay], Date.now(), Date.now() + 5000);
    expect(await reserveChainConversationAsync(relay, target, requestForRun, "owner-tier", Date.now() + 5000)).toBeNull();
    const after = fs.statSync(filename);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);
  } finally { dropRun("async-running"); }
});

test("restart reconciles a delivered pending cursor, while proven refusal keeps the prior cursor", async () => {
  const api = await import("./conversations");
  const settlement = await import("@/lib/runtime/sendSettlement");
  const record = reserveChainConversation(relay, target, request(), "owner-tier")!;
  releaseConversation(record.id, { conversationId: "conversation_pinned", seen: ["before"], staticDigest: "old",
    pendingCursor: { operationId: "spawn_message_initial-owner-prompt", seen: ["before", "consumed"], staticDigest: "new" } });
  const lookup = spyOn(settlement, "resolveSendReceipt").mockResolvedValue({
    state: "delivered", conversationId: "conversation_pinned", acceptedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
  } as never);
  try {
    const reply = request("next", "root");
    const recovered = await api.resolveChainConversationAsync(relay, target, reply, "owner-tier", Date.now() + 5000);
    expect(recovered).toMatchObject({ seen: ["before", "consumed"], staticDigest: "new" });
    expect(recovered?.pendingCursor).toBeUndefined();
    lookup.mockResolvedValueOnce({ state: "failed" } as never);
    releaseConversation(record.id, { pendingCursor: { operationId: "spawn_message_refused-owner-prompt", seen: ["lost"], staticDigest: "refused" } });
    const refused = await api.resolveChainConversationAsync(relay, target, reply, "owner-tier", Date.now() + 5000);
    expect(refused).toMatchObject({ seen: ["before", "consumed"], staticDigest: "new" });
    expect(refused?.pendingCursor).toBeUndefined();
    lookup.mockResolvedValueOnce(null as never);
    releaseConversation(record.id, { pendingCursor: { operationId: "spawn_message_unbound-owner-prompt", seen: ["never-sent"], staticDigest: "unbound" } });
    const unbound = await api.resolveChainConversationAsync(relay, target, reply, "owner-tier", Date.now() + 5000);
    expect(unbound).toMatchObject({ seen: ["before", "consumed"], staticDigest: "new" });
    expect(unbound?.pendingCursor).toBeUndefined();
  } finally { lookup.mockRestore(); releaseConversation(record.id); }
});
test("a missing Claude session resets its prompt while preserving anchors and reservation", () => {
  const record = reserveChainConversation(relay, target, request(), "member")!;
  Object.assign(record, { sessionId: "00000000-0000-0000-0000-000000000000", seen: ["old"], staticDigest: "old" });
  prepareConversationAccount(record, { transcriptRoot: path.join(root, "empty-account") } as never);
  expect(record).toMatchObject({ sessionId: null, seen: [], staticDigest: null, state: "running", anchors: ["root"] });
});
test("version 1 expires only reserved files; malformed maps are preserved", () => {
  const record = reserveChainConversation(relay, target, request(), "member")!;
  fs.mkdirSync(record.cwd!, { recursive: true });
  const file = path.join(root, "external-relay/conversations.json");
  writeRelayFile(file, { v: 1, conversations: [{ ...record, context: "member" }] });
  sweepConversations([relay], []); expect(readConversations()).toEqual([]); expect(fs.existsSync(record.cwd!)).toBe(false);
  fs.writeFileSync(file, "broken JSON"); expect(readConversations()).toEqual([]);
  const saved = fs.readdirSync(path.dirname(file)).find(name => name.startsWith("conversations.json.corrupt-"))!;
  expect(fs.readFileSync(path.join(path.dirname(file), saved), "utf8")).toBe("broken JSON");
});
// Reply-chain regressions also run against the pinned base.
test("reply chains reserve independently and survive a process restart", async () => {
  const api = await import("./conversations");
  const request = { ...sampleRequest, chat: { key: "chain-chat" }, input: { ...sampleRequest.input,
    requester: { key: "fixture-member", is_owner: false, is_admin: false }, respond_to: "chain-root",
    conversation: [{ ...sampleRequest.input.conversation[0]!, id: "chain-root" }] } } as unknown as Parameters<typeof api.reserveChainConversation>[2];
  const first = api.reserveChainConversation(relay, target, request, "member")!;
  const other = api.reserveChainConversation(relay, target, { ...request, request_id: "other-chain", input: { ...request.input,
    respond_to: "other-root", conversation: [{ ...request.input.conversation[0]!, id: "other-root" }] } }, "member")!;
  expect(other.id).not.toBe(first.id);
  const reply = { ...request, request_id: "chain-reply", input: { ...request.input, respond_to: "next",
    conversation: [request.input.conversation[0]!, { ...request.input.conversation[0]!, id: "bot-answer", author: { key: "bot", name: "Bot", self: true }, reply_to: "chain-root" },
      { ...request.input.conversation[0]!, id: "next", reply_to: "bot-answer" }] } };
  expect(api.reserveChainConversation(relay, target, reply, "member")).toBeNull();
  releaseConversation(first.id);
  const child = Bun.spawn([process.execPath, "-e", `import { readConversations } from "./src/lib/externalRelay/conversations"; console.log(JSON.stringify(readConversations()))`], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(stdout).find((r: { id: string }) => r.id === first.id).anchors).toContain("chain-root");
  expect(api.reserveChainConversation(relay, target, reply, "member")!.id).toBe(first.id);
  releaseConversation(first.id); releaseConversation(other.id);
});


test("measure conversation map parsing at expected and capped retention", () => {
  const seed = reserveChainConversation(relay, target, request(), "owner-tier")!;
  const samples = [];
  for (const count of [70, 300]) {
    const ids = Array.from({ length: 200 }, (_, i) => `fixture${String(i).padStart(19, "0")}`);
    const rows = Array.from({ length: count }, (_, i) => ({ ...seed, id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      seen: ids, anchors: ids, state: "idle" }));
    const content = JSON.stringify({ v: 2, conversations: rows });
    writeRelayFile(path.join(root, "external-relay/conversations.json"), { v: 2, conversations: rows });
    const ms = [];
    for (let i = 0; i < 5; i++) { const started = performance.now(); expect(readConversations()).toHaveLength(count); ms.push(performance.now() - started); }
    samples.push({ records: count, bytes: Buffer.byteLength(content), readParseValidateMs: ms });
  }
  console.log("RELAY_MAP_PARSE", JSON.stringify(samples));
});


test("both prompt paths retain at most 200 seen ids after another full window", async () => {
  const { conversationTurnPrompt } = await import("./prompt");
  const { ownerContinuationPrompt } = await import("./ownerRun");
  const record = { seen: Array.from({ length: 200 }, (_, i) => `old-${i}`), staticDigest: null } as RelayConversationForPrompt;
  const next = request("current");
  next.input.conversation.unshift(...Array.from({ length: 39 }, (_, i) => ({ ...next.input.conversation[0]!, id: `new-${i}` })));
  for (const turn of [conversationTurnPrompt(next, record, "answer"), ownerContinuationPrompt(next,
    { messageId: "current", text: "Fixture request", requestText: null }, 1, record)]) {
    expect(turn.seen).toHaveLength(200); expect(turn.seen.at(-1)).toBe("current"); expect(turn.seen).not.toContain("old-0");
  }
});
type RelayConversationForPrompt = import("./conversations").RelayConversation;
