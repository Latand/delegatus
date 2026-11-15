import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { requestSchema, checkedAnswer, guestAnswerSchema, offersHandoff, type ExternalRelayRequest } from "./protocol";
import { relayClaimBody } from "./poller";
import { relayCall } from "./client";
import { ownerTierFor } from "./profile";
import { ownerAnswer } from "./ownerRun";
import { answerCapabilities } from "./answerV2";
import { runClaimedRequest } from "./runner";
import { callableTools, createToolLoop } from "./toolLoop";
import { validateMediaInput } from "./mediaInputValidation";
import { prepareInboundMedia, writeInboundAgentInput } from "./mediaInput";
import { newTargetSettings, updateRelayStore, readRunLedger, dropRun, type PairedRelay } from "./store";
import { readAnswerRecord } from "./answers";
import { startTestRelay } from "./testRelay";
import { richRequest } from "./rich.fixture";

const dir = path.join(import.meta.dir, "fixtures/relay_v1");
const source = fs.readFileSync(path.join(dir, "claimed_guest_owner.json"));
const guest = (): ExternalRelayRequest => requestSchema.parse(JSON.parse(source.toString()).request);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-guest-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const home = path.join(root, "account"); fs.mkdirSync(home);
const account: AccountContext = { engine: "claude", accountId: "fixture", kind: "managed", home, transcriptRoot: home, env: { ...process.env } };
const original = accountManager.resolveHeadlessSpawn;
accountManager.resolveHeadlessSpawn = (() => ({ kind: "available", account })) as typeof original;
beforeEach(() => fs.rmSync(path.join(root, "state"), { recursive: true, force: true }));
afterAll(() => { accountManager.resolveHeadlessSpawn = original; fs.rmSync(root, { recursive: true, force: true }); });
function paired(origin: string, ownerTier = true): PairedRelay {
  return { id: "guest_fixture", origin, api_base: `${origin}/v1`, name: "Fixture", description: "", credential: "x".repeat(43),
    owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null }, pairedAt: "2026-10-06T12:00:00Z", paused: false,
    features: ["progress_steps"], limits: { max_wait_s: 25, max_response_bytes: 1048576, max_answer_chars: 4000 },
    targets: [{ ...newTargetSettings({ target_id: guest().target_id, name: "Fixture", answered_by: "install", fallback: "service" }),
      engine: "claude", model: "fixture", ownerTier, memberLimitPerHour: null }] };
}

test("service guest bytes, additive delivery and existing authority selector", () => {
  expect(source.length).toBe(4721);
  expect(createHash("sha256").update(source).digest("hex")).toBe("61d6d384f956e70d9b0097da80ab855772b4091a5184efa41bf3e1d4df9ca4f5");
  const request = guest(); expect(request.delivery).toBe("guest");
  expect(request).toEqual(JSON.parse(source.toString()).request);
  const ordinary = { ...request }; delete ordinary.delivery;
  expect(ownerTierFor({ ownerTier: true }, request)).toEqual(ownerTierFor({ ownerTier: true }, ordinary));
  expect(ownerTierFor({ ownerTier: false }, request)).toBeNull();
  for (const changed of [{ is_owner: false }, { is_anonymous_admin: true }, { key: "foreign" }]) {
    const hostile = { ...request, input: { ...request.input, requester: { ...request.input.requester!, ...changed } } };
    expect(ownerTierFor({ ownerTier: true }, hostile)).toBeNull();
  }
  expect(relayClaimBody(paired("http://127.0.0.1:1")).features).toContain("relay_guest_answers");
});

test("guest contract refuses direct service tools, progress, destinations and rich output", () => {
  const request = guest(), rich = richRequest(true);
  for (const changed of [
    { delivery: "other" }, { input: { ...request.input, format: rich.input.format } }, { answer: { ...request.answer, progress: "notes" } },
    { owner_delivery: { chat_id: 41, reply_to_message_id: 1, message_thread_id: null } },
    { input: { ...request.input, tools: [{ name: "search_docs", summary: "Read", mode: "direct", effect: "read", parameters: { type: "object" } }] } },
    { input: { ...request.input, requester: { ...request.input.requester!, is_owner: false } } },
    { answer: { ...request.answer, attachments: { max_items: 1, max_total_bytes: 1024, kinds: ["photo"] } } },
  ]) expect(requestSchema.safeParse({ ...request, ...changed }).success).toBe(false);
  expect(answerCapabilities({ ...request, input: { ...request.input, format: rich.input.format },
    answer: { ...request.answer, attachments: rich.answer.attachments }, features: ["relay_rich_messages", "relay_media_out"] }, "codex")).toMatchObject({ rich: false, media: false, generate: false });
});

for (const populated of [false, true]) test(`guest handoff and final text validation with tools=${populated}`, async () => {
  const request = guest(); if (!populated) request.input.tools = [];
  expect(offersHandoff(request)).toBe(true);
  expect(callableTools(request)).toEqual([]);
  const owner = ownerTierFor({ ownerTier: true }, request)!;
  for (const action of ["reply", "handoff", "ignore"] as const) {
    const result = checkedAnswer({ action, text: "Done.", reply_to: request.input.respond_to }, request);
    expect(result?.action ?? null).toBe(action === "ignore" ? null : action);
    if (result) expect(result.reply_to).toBeNull();
  }
  expect(ownerAnswer("[ignore]", request, owner)).toBeNull();
  expect(ownerAnswer("[handoff]", request, owner)?.action).toBe("handoff");
  const max = "😀".repeat(request.answer.max_chars);
  expect(checkedAnswer({ action: "reply", text: max, reply_to: null }, request)?.text).toBe(max);
  expect(checkedAnswer({ action: "reply", text: max + "x", reply_to: null }, request)).toBeNull();
  expect([...ownerAnswer(max + "x", request, owner)!.text]).toHaveLength(request.answer.max_chars);
  expect(ownerAnswer("Done.", request, owner)?.reply_to).toBeNull();
  const server = await startTestRelay(() => { throw Error("handoff tools must stay local"); });
  try {
    const loop = createToolLoop(paired(server.origin), request, { signal: new AbortController().signal, lose: () => {}, ack: async () => true });
    await loop.runCalls([{ tool: "search_docs", arguments: "{}", cursor: null }], 1);
    expect(loop.records[0]?.code).toBe("not_permitted");
  } finally { await server.close(); }
}, 30_000);

for (const ownerTier of [true, false]) for (const populated of [true, false]) for (const handoff of (ownerTier ? [false, true, "late", "timeout"] as const : [false, true] as const))
  test(`real guest runner ownerTier=${ownerTier} tools=${populated} handoff=${handoff}`, async () => {
    const request = guest(); if (!populated) request.input.tools = [];
    const beats: unknown[] = [], completions: unknown[] = [], unexpected: string[] = [];
    const wire: Record<string, unknown> = {};
    const server = await startTestRelay((req, body) => {
      if (req.url?.endsWith("/claim")) { wire.claim = body; return { body: { request } }; }
      if (req.url?.endsWith("/heartbeat")) beats.push(body);
      else if (req.url?.endsWith("/complete")) completions.push(body);
      else unexpected.push(req.url!);
      return { body: { status: "ok" } };
    });
    const relay = paired(server.origin, ownerTier); updateRelayStore(s => ({ ...s, relays: [relay] }));
    let launches = 0, stopped = false;
    const stub = path.join(root, "restricted-agent");
    const schemaFile = path.join(root, "schema.json");
    fs.writeFileSync(stub, `#!/usr/bin/env bun
const a=process.argv.slice(2);await Bun.stdin.text();require('fs').writeFileSync(${JSON.stringify(schemaFile)},a[a.indexOf('--json-schema')+1]);console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput','WebSearch'],mcp_servers:[],session_id:a[a.indexOf(a.includes('--resume')?'--resume':'--session-id')+1]}));console.log(JSON.stringify({type:'result',subtype:'success',structured_output:${JSON.stringify({ action: handoff === true ? "handoff" : "reply", text: handoff === true ? "" : "Done.", reply_to: request.input.respond_to })}}));`);
    fs.chmodSync(stub, 0o700);
    try {
      const claim = await relayCall<{ request: unknown }>(relay.api_base, "/requests/claim", "POST", relayClaimBody(relay), relay.credential);
      let now = Date.parse("2026-10-06T12:00:01Z");
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      let result;
      let record: ReturnType<typeof readAnswerRecord> = null;
      try { result = await runClaimedRequest(relay, claim.body!.request, undefined, { leaseWorker: false, command: stub, ...(handoff === "timeout" ? { timeoutMs: 100 } : {}),
        ownerPorts: { launch: async () => { launches++; return { status: 202, body: { conversationId: "conversation_guest_fixture" } }; },
          observe: async () => { if (handoff === "timeout" && !stopped) return { state: "running" }; if (handoff === "late") now += 601_000; return { state: "ended", finalText: handoff === true ? "[handoff]" : "Done." }; }, stop: async () => { stopped = true; }, pollMs: 1 } });
        record = readAnswerRecord(relay.id, request.target_id, request.request_id);
      }
      finally { clock.mockRestore(); }
      expect(launches).toBe(ownerTier ? 1 : 0);
      if (handoff === "timeout") {
        expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: null } });
        if (result?.outcome !== "answered") throw Error("missing timeout notice");
        expect(Object.keys(result.answer).sort()).toEqual(["action", "reply_to", "text"]);
        expect([...result.answer.text].length).toBeLessThanOrEqual(request.answer.max_chars);
      } else expect(result).toMatchObject(handoff === true ? { outcome: "declined", reason: "handoff" } : { outcome: "answered", answer: { action: "reply", text: "Done.", reply_to: null } });
      if (handoff === "late" && ownerTier) {
        expect(completions).toEqual([]);
        expect(readRunLedger().runs[0]?.ownerTurn?.lateAnswer?.status).toBe("pending-delivery-context");
        dropRun(request.request_id);
      } else expect(completions).toEqual([result]);
      expect(unexpected).toEqual([]);
      expect(beats.length).toBeGreaterThan(0); expect(beats.every(body => !(body as { progress?: unknown }).progress)).toBe(true);
      if (!ownerTier) expect(JSON.parse(fs.readFileSync(schemaFile, "utf8"))).toEqual(guestAnswerSchema);
      expect(record?.profile?.owner ?? false).toBe(ownerTier);
      if (ownerTier && populated && handoff === false) {
        wire.source = { revision: "f27ca4e08746f685f54ea19084c82b5f64403848", file: "claimed_guest_owner.json", bytes: source.length,
          sha256: createHash("sha256").update(source).digest("hex") };
        wire.runner = "owner"; wire.profile = record!.profile; wire.completion = completions[0];
        const output = JSON.stringify(wire, null, 2) + "\n";
        if (process.env.LLV_RELAY_GUEST_LOOP_OUTPUT) fs.writeFileSync(process.env.LLV_RELAY_GUEST_LOOP_OUTPUT, output);
        else expect(output).toBe(fs.readFileSync(path.join(dir, "install_guest_loop.json"), "utf8"));
      }
    } finally { await server.close(); }
  }, 30_000);

for (const ownerTier of [true, false]) test(`Codex Cloud hands guest history photos back to the hosted assistant with ownerTier=${ownerTier}`, async () => {
  const request = guest(); request.features = ["requester_context", "relay_media_in"];
  const message = request.input.conversation[0]!;
  message.media = [{ ref: "media_00000000000000000000000000000001", kind: "photo", availability: "ready",
    mime_type: "image/png", byte_size: 77, expires_at: "2099-01-01T00:00:00Z" }];
  const relay = paired("http://127.0.0.1:1", ownerTier);
  relay.targets[0] = { ...relay.targets[0]!, engine: "codex-cloud", model: "gpt-6.1-sol", project: "fixture-project", cloudEnvironmentId: "fixture-environment" };
  const urls: string[] = [], completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    urls.push(req.url!);
    if (req.url?.endsWith("/claim")) return { body: { request } };
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "ok" } };
  });
  relay.origin = server.origin; relay.api_base = `${server.origin}/v1`;
  updateRelayStore(s => ({ ...s, relays: [relay] }));
  let cloudCalls = 0;
  try {
    const claimed = await relayCall<{ request: unknown }>(relay.api_base, "/requests/claim", "POST", relayClaimBody(relay), relay.credential);
    const result = await runClaimedRequest(relay, claimed.body!.request, undefined, { leaseWorker: false,
      cloudTransport: async () => { cloudCalls++; return JSON.stringify({ action: "reply", text: "Done.", reply_to: null }); } });
    expect(result).toMatchObject({ outcome: "declined", reason: "handoff",
      detail: "This install cannot inspect guest history photos; the service's own assistant will answer." });
    expect(completions).toEqual([result]);
    expect(cloudCalls).toBe(0);
    expect(urls.some(url => url.includes("/media/"))).toBe(false);
  } finally { await server.close(); }
}, 30_000);

test("guest history retains ten photos, downloads every ref and supplies native images", async () => {
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const request = guest(); request.features = ["requester_context", "relay_media_in"];
  const template = request.input.conversation[0]!;
  request.input.conversation = Array.from({ length: 11 }, (_, i) => ({ ...template, id: `history_${i}`, text: `History ${i}`, reply_to: null,
    author: i === 10 ? template.author : { key: "customer", name: "Customer", self: false },
    ...(i < 10 ? { media: [{ ref: `media_${i}`, kind: "photo" as const, availability: "ready" as const, mime_type: "image/png", byte_size: bytes.length, expires_at: "2099-01-01T00:00:00Z" }] } : {}) }));
  request.input.respond_to = "history_10";
  const parsed = requestSchema.parse(request); expect(parsed).toEqual(request);
  expect(validateMediaInput(parsed).map(item => item.ref)).toEqual(Array.from({ length: 10 }, (_, i) => `media_${i}`));
  const extra = structuredClone(request); extra.input.conversation[10]!.media = [{ ...request.input.conversation[0]!.media![0]!, ref: "media_extra" }];
  expect(requestSchema.safeParse(extra).success).toBe(false);
  const doc = structuredClone(request); doc.input.conversation[0]!.media![0]!.kind = "document";
  expect(requestSchema.safeParse(doc).success).toBe(false);
  const noFeature = { ...request, features: [] }; expect(requestSchema.safeParse(noFeature).success).toBe(false);
  const ordinary = { ...request }; delete ordinary.delivery;
  expect(requestSchema.parse(ordinary).input.conversation.every(item => !item.media)).toBe(true);
  const seen: string[] = [];
  const server = await startTestRelay(req => { seen.push(req.url!.split("/").at(-1)!); return { headers: { "content-type": "image/png", "content-length": String(bytes.length) }, raw: bytes }; });
  try {
    const media = await prepareInboundMedia(paired(server.origin), parsed, root, { signal: new AbortController().signal, deadlineAt: Date.parse("2099-01-01T00:00:00Z"), authorize: () => {} });
    try {
      expect(seen).toEqual(validateMediaInput(parsed).map(item => item.ref)); expect(media.files).toHaveLength(10);
      for (const file of media.files) expect(fs.readFileSync(file.path)).toEqual(bytes);
      const native = await writeInboundAgentInput(media.files, media.prompt, root, new AbortController().signal, () => {});
      const frame = JSON.parse(fs.readFileSync(native!, "utf8"));
      expect(frame.message.content.filter((item: { type: string }) => item.type === "image")).toHaveLength(10);
    } finally { await media.dispose(); }
  } finally { await server.close(); }
}, 30_000);
