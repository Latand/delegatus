import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { runClaimedRequest } from "./runner";
import { ensureExternalRelayPollers, stopExternalRelayPollers, relayClaimCapabilities } from "./poller";
import { readConversations, sweepConversations } from "./conversations";
import { setRelaySwitch } from "./switches";
import { updateRelayStore, newTargetSettings, type PairedRelay } from "./store";
import { startTestRelay } from "./testRelay";
import { x1Request } from "./toolLoop.fixture";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-slice3-loop-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const home = path.join(root, "account"); fs.mkdirSync(home, { recursive: true });
const seenFile = path.join(root, "seen.jsonl");
const account: AccountContext = { engine: "claude", accountId: "fixture", kind: "managed", home, transcriptRoot: home, env: { ...process.env } };
const previous = accountManager.resolveHeadlessSpawn;
accountManager.resolveHeadlessSpawn = (() => ({ kind: "available", account })) as typeof previous;
const stub = path.join(root, "engine");
fs.writeFileSync(stub, `#!/usr/bin/env bun
const a=process.argv.slice(2);const prompt=await Bun.stdin.text();const id=a[a.indexOf(a.includes('--resume')?'--resume':'--session-id')+1];const project=require('path').join(${JSON.stringify(home)},process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));require('fs').mkdirSync(project,{recursive:true});require('fs').writeFileSync(require('path').join(project,id+'.jsonl'),'fixture');const row={prompt,args:a,cwd:process.cwd()};require('fs').appendFileSync(${JSON.stringify(seenFile)},JSON.stringify(row)+'\\n');console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput','WebSearch'],mcp_servers:[],session_id:id}));if(prompt==='/compact')console.log(JSON.stringify({type:'system',subtype:'compact_boundary'}));console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{action:'reply',text:'Done.',reply_to:null,calls:[]},usage:{input_tokens:100}}));
`); fs.chmodSync(stub, 0o700);
afterAll(() => { accountManager.resolveHeadlessSpawn = previous; stopExternalRelayPollers(); sweepConversations([], []); fs.rmSync(root, { recursive: true, force: true }); });
const dir = `${import.meta.dir}/fixtures/relay_v1`;
const fixture = (name: string) => JSON.parse(fs.readFileSync(`${dir}/${name}.json`, "utf8")).request;
const compactOwner = fixture("claimed_compact_owner"); const compactAdmin = fixture("claimed_compact_admin");
function paired(origin: string): PairedRelay { return { id: "slice3_fixture", origin, api_base: `${origin}/v1`, name: "Fixture service", description: "", credential: "x".repeat(43), owner: { namespace: "telegram", id: "41", display_name: "Owner", handle: null }, pairedAt: "2026-10-08T12:00:00Z", paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, targets: [{ ...newTargetSettings({ target_id: compactOwner.target_id, name: "Target", answered_by: "install", fallback: "service" }), engine: "claude", model: "haiku", memberLimitPerHour: null }] }; }
function answer(role: "member" | "owner", id: string) { const request = x1Request(role); return { ...request, request_id: id, target_id: compactOwner.target_id, chat: compactOwner.chat }; }
const rows = () => fs.readFileSync(seenFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
test("dark capabilities, persistent second turn and separated owner sessions", async () => {
  expect(relayClaimCapabilities()).toEqual({ kinds: ["answer"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions"] });
  setRelaySwitch("compact", true);
  expect(relayClaimCapabilities().kinds).toEqual(["answer"]);
  setRelaySwitch("chat_conversations", true);
  const server = await startTestRelay(() => ({ body: { status: "ok" } })); const relay = paired(server.origin);
  try {
    expect((await runClaimedRequest(relay, answer("member", "turn_one"), undefined, { command: stub }))?.outcome).toBe("answered");
    const first = readConversations()[0]!;
    expect(first.turns).toBe(1); expect(first.sessionId).toBeString();
    await runClaimedRequest(relay, answer("member", "turn_two"), undefined, { command: stub });
    expect(rows().at(-1).args).toContain("--resume"); expect(rows().at(-1).prompt).not.toContain("<service_instructions>");
    await runClaimedRequest(relay, answer("owner", "turn_owner"), undefined, { command: stub });
    expect(readConversations().map((r) => r.context).sort()).toEqual(["member", "owner"]);
    expect(readConversations()[1]!.sessionId).not.toBe(first.sessionId);
  } finally { await server.close(); }
});
test("lower token usage preserves history until an admin compacts the member session", async () => {
  setRelaySwitch("chat_conversations", true); setRelaySwitch("compact", true);
  const script = path.join(root, "lower-usage-engine");
  fs.writeFileSync(script, fs.readFileSync(stub, "utf8").replace("input_tokens:100", "input_tokens:a.includes('--resume')?50:100"));
  fs.chmodSync(script, 0o700);
  const server = await startTestRelay(() => ({ body: { status: "ok" } }));
  const relay = paired(server.origin); relay.id = "lower_usage";
  try {
    for (const [role, id] of [["owner", "lower_owner"], ["member", "lower_one"], ["member", "lower_two"]] as const)
      expect((await runClaimedRequest(relay, answer(role, id), undefined, { command: script }))?.outcome).toBe("answered");
    const records = readConversations().filter((r) => r.relayId === relay.id);
    const member = records.find((r) => r.context === "member")!;
    const ownerBefore = JSON.stringify(records.find((r) => r.context === "owner"));
    expect(member).toMatchObject({ turns: 2, turnsSinceCompaction: 2, compactions: 0, lastPromptTokens: 50 });
    const before = rows().length;
    expect(await runClaimedRequest(relay, { ...compactAdmin, request_id: "lower_compact_admin" }, undefined, { command: script }))
      .toMatchObject({ outcome: "compacted", reason: "compacted" });
    const calls = rows().slice(before);
    expect(calls).toHaveLength(1); expect(calls[0].prompt).toBe("/compact");
    expect(calls[0].args).toContain(member.sessionId);
    expect(readConversations().find((r) => r.id === member.id)).toMatchObject({ turnsSinceCompaction: 0, compactions: 1 });
    expect(JSON.stringify(readConversations().find((r) => r.relayId === relay.id && r.context === "owner"))).toBe(ownerBefore);
    expect(await runClaimedRequest(relay, { ...compactOwner, request_id: "lower_compact_owner" }, undefined, { command: script }))
      .toMatchObject({ outcome: "compacted", reason: "compacted" });
  } finally { await server.close(); }
});

test("X3 generated by the real poller and runner against byte-identical service claims", async () => {
  const captures: { claim: string; heartbeats: unknown[]; completion?: unknown }[] = [];
  let claim_body: unknown; let current: typeof captures[number] | null = null;
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [{ target_id: compactOwner.target_id, name: "Target", answered_by: "install", fallback: "service" }] } };
    if (req.url?.endsWith("/claim")) { claim_body = body; stopExternalRelayPollers(); return { status: 204 }; }
    if (req.url?.endsWith("/heartbeat")) current?.heartbeats.push(body);
    if (req.url?.endsWith("/complete")) { if (current) current.completion = { ...(body as object), duration_ms: 0 }; }
    expect(req.url?.endsWith("/tool-calls")).not.toBe(true);
    return { body: { status: "ok" } };
  }); const relay = paired(server.origin); relay.id = "x3_fixture";
  try {
    updateRelayStore((store) => ({ ...store, relays: [relay] })); ensureExternalRelayPollers();
    const deadline = Date.now() + 5000; while (!claim_body && Date.now() < deadline) await Bun.sleep(10);
    expect(claim_body).toMatchObject({ kinds: ["answer", "compact"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "chat_conversations"] });
    for (const role of ["member", "owner"] as const)
      expect((await runClaimedRequest(relay, answer(role, `x3_turn_${role}`), undefined, { command: stub }))?.outcome).toBe("answered");
    for (const [name, request, reason] of [["claimed_compact_owner.json", compactOwner, "compacted"], ["claimed_compact_admin.json", compactAdmin, "nothing_to_compact"]] as const) {
      current = { claim: name, heartbeats: [] }; captures.push(current);
      const completion = await runClaimedRequest(relay, request, undefined, { command: stub });
      expect(completion).toMatchObject({ outcome: "compacted", reason, detail: null });
      expect(current.heartbeats).toEqual([{ lease_id: request.lease_id, seq: 1, progress: null }]);
    }
    const hash = (name: string) => createHash("sha256").update(fs.readFileSync(`${dir}/${name}`)).digest("hex");
    const output = JSON.stringify({ x3: { revision: "c5067f000493ca14e51216cdcac68fd6442fa2f6", claims: Object.fromEntries(["claimed_compact_owner.json", "claimed_compact_admin.json"].map((name) => [name, hash(name)])) }, claim_body, runs: captures }, null, 2) + "\n";
    const destination = path.join(import.meta.dir, "../../../evidence/external-relay/install_compact_loop.json");
    if (process.env.LLV_RELAY_WIRE_OUTPUT_COMPACT_LOOP) fs.writeFileSync(process.env.LLV_RELAY_WIRE_OUTPUT_COMPACT_LOOP, output);
    expect(output).toBe(fs.readFileSync(destination, "utf8"));
  } finally { stopExternalRelayPollers(); await server.close(); }
}, 15000);

test("compact acknowledges before touching sessions, and refuses lost leases, members, disabled and busy chats", async () => {
  setRelaySwitch("chat_conversations", true); setRelaySwitch("compact", true);
  let heartbeatStatus = 200, acknowledged = false; let completions = 0;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/heartbeat")) { expect(readConversations().filter((r) => r.relayId === "compact_guards")).toEqual([]); acknowledged = true; return { status: heartbeatStatus, body: heartbeatStatus === 200 ? { status: "ok" } : { error: { code: "lease_lost" } } }; }
    if (req.url?.endsWith("/complete")) completions++;
    return { body: { status: "ok" } };
  }); const relay = paired(server.origin); relay.id = "compact_guards";
  try {
    heartbeatStatus = 409;
    expect(await runClaimedRequest(relay, compactOwner)).toBeNull(); expect(completions).toBe(0); expect(acknowledged).toBe(true);
    heartbeatStatus = 200;
    expect(await runClaimedRequest({ ...relay, paused: true }, compactOwner)).toMatchObject({ outcome: "declined", reason: "disabled" });
    expect(await runClaimedRequest({ ...relay, targets: [] }, compactOwner)).toMatchObject({ outcome: "declined", reason: "not_configured" });
    const member = { ...compactOwner, input: { requester: { ...compactOwner.input.requester, is_owner: false, is_admin: false } } };
    expect(await runClaimedRequest(relay, member)).toMatchObject({ outcome: "declined", reason: "invalid_request" });
    const { reserveConversations, releaseConversation } = await import("./conversations");
    const reserved = reserveConversations(relay, relay.targets[0]!, compactOwner.chat.key, "live_turn", ["owner"])!;
    expect(await runClaimedRequest(relay, compactAdmin)).toMatchObject({ outcome: "declined", reason: "busy", detail: "chat busy" });
    releaseConversation(reserved[0]!.id);
  } finally { await server.close(); }
});

test("admin compact leaves owner context untouched; Codex resets its session and files", async () => {
  const { reserveConversations, releaseConversation, conversationCodexHome } = await import("./conversations");
  setRelaySwitch("chat_conversations", true); setRelaySwitch("compact", true);
  const server = await startTestRelay(() => ({ body: { status: "ok" } })); const relay = paired(server.origin); relay.id = "codex_compact"; relay.targets[0]!.engine = "codex";
  try {
    const records = reserveConversations(relay, relay.targets[0]!, compactOwner.chat.key, "seed", ["member", "owner"])!;
    for (const record of records) {
      releaseConversation(record.id, { sessionId: "00000000-0000-0000-0000-000000000000", turns: 1, turnsSinceCompaction: 1 });
      fs.mkdirSync(conversationCodexHome(record), { recursive: true }); fs.writeFileSync(path.join(conversationCodexHome(record), "rollout.jsonl"), "fixture");
    }
    const ownerBefore = JSON.stringify(readConversations().find((r) => r.id === records[1]!.id));
    expect(await runClaimedRequest(relay, compactAdmin)).toMatchObject({ outcome: "compacted", reason: "started_fresh" });
    expect(JSON.stringify(readConversations().find((r) => r.id === records[1]!.id))).toBe(ownerBefore);
    expect(fs.existsSync(conversationCodexHome(records[0]!))).toBe(false);
    expect(fs.existsSync(conversationCodexHome(records[1]!))).toBe(true);
    expect(await runClaimedRequest(relay, compactOwner)).toMatchObject({ outcome: "compacted", reason: "started_fresh" });
    expect(fs.existsSync(conversationCodexHome(records[1]!))).toBe(false);
  } finally { await server.close(); }
});

test("Claude compaction without a witnessed boundary starts fresh; unavailable accounts decline", async () => {
  const { reserveConversations, releaseConversation } = await import("./conversations");
  setRelaySwitch("chat_conversations", true); setRelaySwitch("compact", true);
  const server = await startTestRelay(() => ({ body: { status: "ok" } })); const relay = paired(server.origin); relay.id = "claude_compact_fallback";
  const noBoundary = path.join(root, "no-boundary-engine"); fs.writeFileSync(noBoundary, fs.readFileSync(stub, "utf8").replace("if(prompt==='/compact')", "if(false)")); fs.chmodSync(noBoundary, 0o700);
  const seed = () => { const record = reserveConversations(relay, relay.targets[0]!, compactOwner.chat.key, "seed_fallback", ["member"])![0]!; releaseConversation(record.id, { sessionId: "00000000-0000-0000-0000-000000000000", turns: 1, turnsSinceCompaction: 1 });
    const project = path.join(account.transcriptRoot, record.cwd.replace(/[^a-zA-Z0-9]/g, "-")); fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, "00000000-0000-0000-0000-000000000000.jsonl"), "fixture");
    return record; };
  try {
    const record = seed(); fs.mkdirSync(record.cwd, { recursive: true }); fs.writeFileSync(path.join(record.cwd, "fixture"), "owned fixture");
    expect(await runClaimedRequest(relay, compactAdmin, undefined, { command: noBoundary })).toMatchObject({ outcome: "compacted", reason: "started_fresh" });
    expect(readConversations().find((r) => r.id === record.id)?.sessionId).toBeNull(); expect(fs.existsSync(record.cwd)).toBe(false);
    seed(); const prior = accountManager.resolveHeadlessSpawn; accountManager.resolveHeadlessSpawn = (() => ({ kind: "unavailable" })) as typeof prior;
    try { expect(await runClaimedRequest(relay, compactAdmin)).toMatchObject({ outcome: "declined", reason: "no_capacity" }); }
    finally { accountManager.resolveHeadlessSpawn = prior; }
  } finally { await server.close(); }
});
