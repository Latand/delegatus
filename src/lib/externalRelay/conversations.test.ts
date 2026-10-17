import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { conversationAuthority, reserveChainConversation, releaseConversation, readConversations, prepareConversationAccount, sweepConversations, sweepConversationsAsync } from "./conversations";
import { sampleRequest, contextRequest } from "./request.fixture";
import { newTargetSettings, reserveRun, dropRun, withFileLock, writeRelayFile, type PairedRelay } from "./store";
import { requestSchema, type ExternalRelayRequest } from "./protocol";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conversations-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => { sweepConversations([], []); fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => sweepConversations([], []));
const target = { ...newTargetSettings({ target_id: "t", name: "Target", answered_by: "install", fallback: "service" }), engine: "claude" as const, model: "haiku" };
const relay = { id: "r", targets: [target] } as PairedRelay;
const request = (id = "root", parent: string | null = null): ExternalRelayRequest => requestSchema.parse({ ...contextRequest, request_id: id, chat: { key: "fixture-chat-chain" }, input: { ...contextRequest.input,
  respond_to: id, conversation: [{ ...contextRequest.input.conversation[0]!, id, reply_to: parent }] } });
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
