import { beforeEach, afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { runClaimedRequest } from "./runner";
import { stopExternalRelayPollers, relayClaimCapabilities } from "./poller";
import { readConversations, sweepConversations, reserveChainConversation, releaseConversation } from "./conversations";
import { setRelaySwitch } from "./switches";
import { newTargetSettings, type PairedRelay } from "./store";
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
beforeEach(() => { sweepConversations([], []); setRelaySwitch("chain_conversations", true); setRelaySwitch("compact", false); });
function paired(origin: string): PairedRelay { return { id: "slice3_fixture", origin, api_base: `${origin}/v1`, name: "Fixture service", description: "", credential: "x".repeat(43), owner: { namespace: "telegram", id: "41", display_name: "Owner", handle: null }, pairedAt: "2026-10-08T12:00:00Z", paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, targets: [{ ...newTargetSettings({ target_id: compactOwner.target_id, name: "Target", answered_by: "install", fallback: "service" }), engine: "claude", model: "haiku", memberLimitPerHour: null }] }; }
function answer(role: "member" | "owner", id: string) { const request = x1Request(role); return { ...request, request_id: id, target_id: compactOwner.target_id, chat: compactOwner.chat }; }
const rows = () => fs.readFileSync(seenFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("claims list no conversation feature, including when the legacy key is stored true", () => {
  fs.mkdirSync(path.join(root, "state/external-relay"), { recursive: true });
  fs.writeFileSync(path.join(root, "state/external-relay/switches.json"), JSON.stringify({ v: 1, chat_conversations: true, chain_conversations: true, compact: true }));
  expect(relayClaimCapabilities()).toEqual({ kinds: ["answer", "compact"], features: ["requester_context", "relay_tool_calls", "relay_tool_actions", "request_deadline"] });
  setRelaySwitch("compact", false); expect(relayClaimCapabilities().kinds).toEqual(["answer"]);
});

test("member, admin and owner chain sessions resume only their own explicit replies", async () => {
  const server = await startTestRelay(() => ({ body: { status: "ok" } })); const relay = paired(server.origin);
  try {
    for (const role of ["member", "owner"] as const) {
      const first = answer(role, `chain-${role}-one`);
      expect((await runClaimedRequest(relay, first, undefined, { command: stub }))?.outcome).toBe("answered");
      const id = `second-${role}`;
      const second = { ...first, request_id: `chain-${role}-two`, input: { ...first.input, respond_to: id,
        conversation: [...first.input.conversation, { ...first.input.conversation.at(-1)!, id, reply_to: first.input.respond_to }] } };
      expect((await runClaimedRequest(relay, second, undefined, { command: stub }))?.outcome).toBe("answered");
      expect(rows().at(-1).args).toContain("--resume"); expect(rows().at(-1).prompt).not.toContain("<service_instructions>");
    }
    const admin = answer("member", "chain-admin"); admin.input.requester!.is_admin = true;
    expect((await runClaimedRequest(relay, admin, undefined, { command: stub }))?.outcome).toBe("answered");
    expect(readConversations().map(r => r.authority).sort()).toEqual(["admin", "member", "owner"]);
    expect(new Set(readConversations().map(r => r.sessionId)).size).toBe(3);
    const newRoot = answer("member", "unrelated-root"); newRoot.input = { ...newRoot.input, respond_to: "unrelated", conversation: [{ ...newRoot.input.conversation[0]!, id: "unrelated", reply_to: null }] };
    expect((await runClaimedRequest(relay, newRoot, undefined, { command: stub }))?.outcome).toBe("answered");
    expect(readConversations()).toHaveLength(4); expect(rows().at(-1).args).not.toContain("--resume");
  } finally { await server.close(); }
});

for (const exists of [true, false]) test(`compact cannot choose a conversation without a reply chain (store exists: ${exists})`, async () => {
  setRelaySwitch("compact", true);
  const server = await startTestRelay(() => ({ body: { status: "ok" } })); const relay = paired(server.origin);
  const file = path.join(root, "state/external-relay/conversations.json");
  const sentinels: string[] = [];
  try {
    if (exists) {
      for (const authority of ["owner", "owner-tier"] as const) {
        const request = answer("owner", `compact-seed-${authority}`);
        const record = reserveChainConversation(relay, relay.targets[0]!, request, authority)!;
        releaseConversation(record.id, { turns: 1, turnsSinceCompaction: 1 });
        if (record.cwd) { fs.mkdirSync(record.cwd, { recursive: true }); const sentinel = path.join(record.cwd, "sentinel"); fs.writeFileSync(sentinel, "preserve"); sentinels.push(sentinel); }
      }
    } else fs.rmSync(file, { force: true });
    const before = exists ? fs.readFileSync(file, "utf8") : null;
    const engineRuns = fs.existsSync(seenFile) ? rows().length : 0;
    for (const request of [compactOwner, compactAdmin]) expect(await runClaimedRequest(relay, request, undefined, { command: "/missing-compact-cli" }))
      .toMatchObject({ outcome: "compacted", reason: "nothing_to_compact" });
    expect(exists ? fs.readFileSync(file, "utf8") : fs.existsSync(file)).toBe(before ?? false);
    expect(fs.existsSync(seenFile) ? rows().length : 0).toBe(engineRuns);
    for (const file of sentinels) expect(fs.readFileSync(file, "utf8")).toBe("preserve");
    expect(await runClaimedRequest(relay, { ...compactOwner, input: { requester: { ...compactOwner.input.requester, is_owner: false, is_admin: false } } }))
      .toMatchObject({ outcome: "declined", reason: "invalid_request" });
    expect(await runClaimedRequest({ ...relay, paused: true }, compactOwner)).toMatchObject({ outcome: "declined", reason: "disabled" });
  } finally { await server.close(); }
});

test("compact acknowledges and loses a revoked lease without changing any conversation", async () => {
  setRelaySwitch("compact", true); let completions = 0, beats = 0;
  const server = await startTestRelay(req => {
    if (req.url?.endsWith("/heartbeat")) { beats++; return { status: 409, body: { error: { code: "lease_lost" } } }; }
    if (req.url?.endsWith("/complete")) completions++;
    return { body: { status: "ok" } };
  });
  try { expect(await runClaimedRequest(paired(server.origin), compactOwner)).toBeNull(); expect(beats).toBe(1); expect(completions).toBe(0); }
  finally { await server.close(); }
});


test.each([0, 10000])("engine-session latency: five identical-input pairs (%s hashing passes)", async passes => {
  const inputFixture = fixture("../service-wire/claimed_rc_owner");
  const trigger = inputFixture.input.conversation.find((m: { id: string }) => m.id === inputFixture.input.respond_to);
  const command = passes ? path.join(root, "session-cost-engine") : stub;
  if (passes) {
    fs.writeFileSync(command, fs.readFileSync(stub, "utf8").replace("const row={prompt,args:a,cwd:process.cwd()};",
      `for(let i=0;i<${passes};i++)require('node:crypto').createHash('sha256').update(prompt).digest();const row={prompt,args:a,cwd:process.cwd()};`));
    fs.chmodSync(command, 0o700);
  }
  const server = await startTestRelay(() => ({ body: { status: "ok" } })); const relay = paired(server.origin);
  const samples: { mode: string; promptBytes: number; answerMs: number }[] = [];
  try {
    for (let pair = 0; pair < 5; pair++) {
      const first = { ...inputFixture, request_id: `session-prime-${passes}-${pair}`, target_id: relay.targets[0]!.id,
        chat: { key: `fixture-session-pinned-${pair}` } };
      expect((await runClaimedRequest(relay, first, undefined, { command }))?.outcome).toBe("answered");
      const input = { ...first.input, respond_to: "session-reply", conversation: [...first.input.conversation,
        { ...trigger, id: "session-bot", author: { key: "fixture-bot", name: "Assistant", self: true }, reply_to: first.input.respond_to, text: "Done" },
        { ...trigger, id: "session-reply", reply_to: "session-bot", text: "Continue the fixture" }] };
      for (const mode of pair % 2 ? ["continued", "fresh"] : ["fresh", "continued"]) {
        const started = performance.now();
        const result = await runClaimedRequest(relay, { ...first, request_id: `session-${passes}-${pair}-${mode}`, input,
          chat: mode === "fresh" ? { key: `fixture-session-fresh-${pair}` } : first.chat }, undefined, { command });
        const answerMs = performance.now() - started;
        expect(result?.outcome).toBe("answered");
        const row = rows().at(-1); expect(row.args.includes("--resume")).toBe(mode === "continued");
        samples.push({ mode, promptBytes: Buffer.byteLength(row.prompt), answerMs });
      }
    }
    const median = (values: number[]) => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)]!;
    const variability = (values: number[]) => ({ rangeMs: Math.max(...values) - Math.min(...values),
      medianAbsoluteDeviationMs: median(values.map(value => Math.abs(value - median(values)))) });
    const fresh = samples.filter(s => s.mode === "fresh"), continued = samples.filter(s => s.mode === "continued");
    expect(median(continued.map(s => s.promptBytes))).toBeLessThan(median(fresh.map(s => s.promptBytes)) / 10);
    console.log("RELAY_SESSION_LATENCY", JSON.stringify({ engine: `Claude CLI fixture; SHA256 ${passes} passes per prompt; alternating pair order`, load: os.loadavg(), samples,
      medians: { freshMs: median(fresh.map(s => s.answerMs)), continuedMs: median(continued.map(s => s.answerMs)) },
      variability: { fresh: variability(fresh.map(s => s.answerMs)), continued: variability(continued.map(s => s.answerMs)) } }));
  } finally { await server.close(); }
}, 60000);
