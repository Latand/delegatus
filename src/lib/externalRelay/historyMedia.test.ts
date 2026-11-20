import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { requestSchema, type ExternalRelayRequest } from "./protocol";
import { validateMediaInput, admittedSeedMedia } from "./mediaInputValidation";
import { ownerTierFor } from "./profile";
import { callableTools } from "./toolLoop";
import { runClaimedRequest } from "./runner";
import type { OwnerRunPorts } from "./ownerRun";
import { newTargetSettings, updateRelayStore, type PairedRelay } from "./store";
import { readConversations, resetConversation } from "./conversations";
import { setRelaySwitch } from "./switches";
import { startTestRelay } from "./testRelay";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-history-media-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const home = path.join(root, "account"); fs.mkdirSync(home);
fs.writeFileSync(path.join(home, "auth.json"), "{}");
fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "fixture" }] }));
const resolve = accountManager.resolveHeadlessSpawn;
accountManager.resolveHeadlessSpawn = ((engine: string) => ({ kind: "available", account: {
  engine, accountId: "fixture", kind: "managed", home, transcriptRoot: home, env: { ...process.env },
} as AccountContext })) as typeof resolve;
beforeEach(() => fs.rmSync(path.join(root, "state"), { recursive: true, force: true }));
afterAll(() => { accountManager.resolveHeadlessSpawn = resolve; fs.rmSync(root, { recursive: true, force: true }); });
type Role = "owner" | "group" | "guest";
const photo = (ref: string, size = 77) => ({ ref, kind: "photo" as const, availability: "ready" as const,
  mime_type: "image/png", byte_size: size, expires_at: "2099-01-01T00:00:00Z" });
function request(role: Role, size = 77): ExternalRelayRequest {
  const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/relay_v1/claimed_guest_owner.json"), "utf8")).request;
  if (role !== "guest") delete raw.delivery;
  raw.features = ["requester_context", "relay_media_in", ...(role === "guest" ? [] : ["relay_history_media"])];
  raw.request_id = `history_${role}`;
  raw.target_id = "target";
  raw.input.requester.is_owner = role !== "group";
  raw.input.tools = [];
  const template = raw.input.conversation[0];
  raw.input.conversation = Array.from({ length: 4 }, (_, i) => ({ ...template, id: `message_${i}`, reply_to: i === 3 ? "message_0" : null,
    sent_at: `2026-10-06T12:00:0${i}Z`, text: `History ${i} [Media attached; description unavailable]`, media: [photo(`photo_${i}`, size)],
    author: i === 3 ? template.author : { key: "other", name: "Participant", self: false },
  }));
  raw.input.respond_to = "message_3";
  return raw;
}
function paired(origin: string, engine = "claude", ownerTier = true): PairedRelay {
  return { id: "history_fixture", origin, api_base: `${origin}/api/relay/v1`, name: "Fixture", description: "", credential: "x".repeat(43),
    owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null }, pairedAt: "2026-10-06T12:00:00Z", paused: false,
    features: ["relay_media_in", "relay_history_media"], limits: { max_wait_s: 25, max_response_bytes: 1048576, max_answer_chars: 4000 },
    targets: [{ ...newTargetSettings({ target_id: "target", name: "Fixture", answered_by: "install", fallback: "service" }),
      engine, model: "fixture", ownerTier, memberLimitPerHour: null }] } as PairedRelay;
}

for (const role of ["owner", "group", "guest"] as const) {
  test(`${role}: history normalization preserves anchors, markers, budgets and authority`, () => {
    const raw = request(role), before = structuredClone(raw);
    const parsed = requestSchema.parse(raw);
    expect(raw).toEqual(before);
    expect(validateMediaInput(parsed).map(media => media.ref)).toEqual(["photo_3", "photo_0", "photo_2", "photo_1"]);
    expect(requestSchema.parse(parsed)).toEqual(parsed);
    expect(admittedSeedMedia(parsed, { seed_media_refs: ["photo_1"] })).toBe(true);
    expect(ownerTierFor({ ownerTier: true }, parsed) !== null).toBe(role !== "group");
    expect(callableTools(parsed)).toEqual([]);
    const hostile = structuredClone(parsed); hostile.input.conversation[3]!.author.key = "other";
    expect(ownerTierFor({ ownerTier: true }, hostile)).toBeNull();
    const missing = structuredClone(raw); delete missing.input.conversation[1]!.media;
    expect(requestSchema.parse(missing).input.conversation[1]!.text).toBe(raw.input.conversation[1]!.text);
    for (const count of [10, 11]) {
      const album = structuredClone(raw); album.input.conversation[3]!.media = Array.from({ length: count - 3 }, (_, i) => photo(`extra_${i}`));
      expect(requestSchema.safeParse(album).success).toBe(count === 10);
    }
    for (const features of [["requester_context", "relay_history_media"], ["requester_context", "relay_media_in"]]) {
      const unnegotiated = { ...raw, features };
      if (role === "guest" && !features.includes("relay_media_in")) expect(requestSchema.safeParse(unnegotiated).success).toBe(false);
      else {
        const result = requestSchema.parse(unnegotiated);
        expect(result.input.conversation[1]!.media !== undefined).toBe(role === "guest");
        expect(result.input.conversation[1]!.text).toBe(raw.input.conversation[1]!.text);
        expect(admittedSeedMedia(result, { seed_media_refs: ["photo_1"] })).toBe(role === "guest");
      }
    }
  });

  test(`${role}: invalid history descriptors are dropped individually with bounded diagnostics`, () => {
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      for (const invalid of [null, {}, "invalid", { ...photo("bad"), ref: "../escape" }, { ...photo("bad"), filename: "../escape" },
        { ...photo("bad"), mime_type: "image/svg+xml" }, { ...photo("bad"), byte_size: 20971521 },
        { ...photo("bad"), expires_at: undefined }, { ...photo("bad"), extra: true },
        { ...photo("bad"), kind: "document" }, { ...photo("photo_3"), byte_size: 12 }]) {
        log.mockClear();
        const raw = request(role);
        Object.assign(raw.input.conversation[1]!, { media: [photo("valid_history"), invalid] });
        const parsed = requestSchema.parse(raw);
        expect(parsed.input.conversation[1]!.media).toEqual([photo("valid_history")]);
        expect(log.mock.calls).toEqual([["External relay history media dropped", JSON.stringify({ request: raw.request_id, entryIndex: 1, count: 1 })]]);
        expect(requestSchema.parse(parsed)).toEqual(parsed);
        const anchor = request(role); Object.assign(anchor.input.conversation[3]!, { media: [invalid] });
        if (invalid && typeof invalid === "object" && ("mime_type" in invalid && invalid.mime_type === "image/svg+xml" || "byte_size" in invalid && invalid.byte_size === 20971521)) {
          const refused = requestSchema.parse(anchor).input.conversation[3]!.media![0]!;
          expect(refused.availability).toBe("mime_type" in invalid && invalid.mime_type === "image/svg+xml" ? "unsupported_type" : "too_large");
        } else if (!(invalid && typeof invalid === "object" && "kind" in invalid && invalid.kind === "document" || invalid && typeof invalid === "object" && "ref" in invalid && invalid.ref === "photo_3"))
          expect(requestSchema.safeParse(anchor).success).toBe(false);
      }
    } finally { log.mockRestore(); }
  });
}

async function runnerCase(role: Role, engine: "claude" | "codex" | "codex-cloud", mode: "valid" | "overflow" | "unnegotiated" | "no_history_feature" | "lease_lost" | "bad_bytes" = "valid", chain = false) {
  const bytes = await (await import("sharp")).default({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const raw = request(role, bytes.length);
  const downloads: string[] = [], completions: unknown[] = [], prompts: string[] = [];
  const paths: string[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.includes("/media/")) {
      expect(req.method).toBe("GET"); expect(req.headers["delegatus-relay-lease"]).toBe(raw.lease_id);
      expect(req.headers.authorization).toBe(`Bearer ${"x".repeat(43)}`);
      downloads.push(req.url.split("/").at(-1)!);
      if (mode === "lease_lost") return { status: 409, body: { error: { code: "lease_lost", message: "gone" } } };
      return { raw: mode === "bad_bytes" ? Buffer.alloc(bytes.length) : bytes, headers: { "content-type": "image/png", "content-length": String(bytes.length) } };
    }
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "ok" } };
  });
  const relay = paired(server.origin, engine);
  if (engine === "codex-cloud") Object.assign(relay.targets[0]!, { project: "fixture-project", cloudEnvironmentId: "fixture-environment" });
  updateRelayStore(s => ({ ...s, relays: [relay] })); setRelaySwitch("chain_conversations", chain);
  const capture = path.join(root, "native-capture.json");
  fs.rmSync(capture, { force: true });
  const command = path.join(root, "agent");
  fs.writeFileSync(command, `#!/usr/bin/env bun
const a=process.argv.slice(2), input=await Bun.stdin.text();
const frame=a.includes('--input-format')?JSON.parse(input):null;
const prompt=frame?frame.message.content.filter(x=>x.type==='text').map(x=>x.text).join(''):input;
const media=prompt.includes('<inbound_media>')?JSON.parse(prompt.split('<inbound_media>')[1].split('</inbound_media>')[0]):[];
for(const item of media)if(item.local_path&&Buffer.from(await Bun.file(item.local_path).arrayBuffer()).toString('hex')!==${JSON.stringify(bytes.toString('hex'))})process.exit(3);
const images=a.flatMap((v,i)=>v==='--image'?[a[i+1]]:[]);
await Bun.write(${JSON.stringify(capture)},JSON.stringify({prompt,media,images,blocks:frame?.message.content.filter(x=>x.type==='image').length??0}));
const answer={action:'reply',text:'Done.',reply_to:null};
if(a.includes('--output-last-message')) {if(process.env.CODEX_HOME)await Bun.write(process.env.CODEX_HOME+'/sessions/rollout-fixture-fixture-thread.jsonl','fixture');console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify(answer));}
else {const sid=a[a.indexOf(a.includes('--resume')?'--resume':'--session-id')+1];if(sid)await Bun.write(${JSON.stringify(home)}+'/'+process.cwd().replace(/[^a-zA-Z0-9]/g,'-')+'/'+sid+'.jsonl','fixture');console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput','WebSearch'],mcp_servers:[],session_id:a[a.indexOf(a.includes('--resume')?'--resume':'--session-id')+1]}));console.log(JSON.stringify({type:'result',subtype:'success',structured_output:answer}));}
`); fs.chmodSync(command, 0o700);
  const inspect = (prompt: string, live = true) => {
    prompts.push(prompt);
    if (!prompt.includes("<inbound_media>")) return;
    const media = JSON.parse(prompt.split("<inbound_media>")[1]!.split("</inbound_media>")[0]!) as { ref: string; local_path?: string }[];
    for (const item of media) if (item.local_path) { paths.push(item.local_path); if (live) expect(fs.readFileSync(item.local_path)).toEqual(bytes); }
  };
  let ownerLaunches = 0;
  const ports: OwnerRunPorts = {
    launch: async body => {
      ownerLaunches++;
      inspect(String(body.prompt));
      return { status: 202, body: { conversationId: "conversation_history" } };
    },
    continue: async (turn, prompt) => { inspect(prompt); return { ok: true, structured: true, target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId }; },
    observe: async () => ({ state: "ended", finalText: "Done." }), stop: async () => {}, pollMs: 1,
  };
  let cloudCalls = 0;
  const run = async (input: ExternalRelayRequest) => {
    const result = await runClaimedRequest(relay, input, undefined, { leaseWorker: false, command, ownerPorts: ports,
      cloudTransport: async input => { cloudCalls++; inspect(input.prompt); return JSON.stringify({ action: "reply", text: "Done.", reply_to: null }); } });
    if (fs.existsSync(capture)) {
      const frame = JSON.parse(fs.readFileSync(capture, "utf8")); fs.rmSync(capture);
      inspect(frame.prompt, false);
      expect(engine === "claude" ? frame.blocks : frame.images.length).toBe(frame.media.filter((item: { local_path?: string }) => item.local_path).length);
    }
    return result;
  };
  return { raw, downloads, completions, prompts, paths, run, cloudCalls: () => cloudCalls, ownerLaunches: () => ownerLaunches, close: server.close };
}

for (const role of ["group", "owner"] as const) for (const invocation of ["mention", "reply"] as const)
  test(`${role}: a photo on a group ${invocation} reaches the relay model`, async () => {
    const f = await runnerCase(role, "claude");
    const request = f.raw, parent = request.input.conversation[0]!, trigger = request.input.conversation[3]!;
    request.features = ["requester_context", "relay_media_in", "relay_owner_tools"];
    request.input.request_text = invocation === "mention" ? "@fixturebot" : null;
    trigger.text = request.input.request_text ?? "";
    trigger.reply_to = invocation === "reply" ? parent.id : null;
    request.input.conversation = [trigger];
    if (invocation === "reply") {
      delete parent.media;
      parent.author = { key: "assistant", name: "Fixture", self: true };
      request.input.conversation.unshift(parent);
    }
    if (role === "group") request.input.tools = [{
      name: "owner_history_lookup", summary: "Read owner history", audience: "owner", mode: "direct",
      effect: "read", parameters: { type: "object" },
    }];

    try {
      const result = await f.run(request);
      expect(result).toMatchObject({ outcome: "answered" });
      expect(f.completions).toEqual([result]);
      expect(f.downloads).toEqual(["photo_3"]);
      expect(f.paths).toHaveLength(1);
      expect(f.ownerLaunches()).toBe(role === "owner" ? 1 : 0);
      if (role === "group") expect(f.prompts.join()).not.toContain("owner_history_lookup");
    } finally { await f.close(); }
  }, 30_000);

for (const role of ["owner", "group", "guest"] as const) for (const engine of ["claude", "codex", "codex-cloud"] as const)
  test(`${role}/${engine}: real runner preserves item refs, markers and download authority`, async () => {
    const f = await runnerCase(role, engine);
    Object.assign(f.raw.input.conversation[1]!, { media: [...f.raw.input.conversation[1]!.media!, { ref: "../invalid" }] });
    try {
      const result = await f.run(f.raw);
      expect(result).toMatchObject(engine === "codex-cloud" ? { outcome: "declined", reason: "handoff" } : { outcome: "answered" });
      expect(f.completions).toEqual([result]);
      expect(f.cloudCalls()).toBe(0);
      expect(f.downloads).toEqual(engine === "codex-cloud" ? [] : ["photo_3", "photo_0", "photo_2", "photo_1"]);
      if (engine !== "codex-cloud") {
        expect(f.prompts.join()).toContain("[Media attached; description unavailable]");
        expect(f.prompts.join()).toContain('"id":"message_1"');
        expect(f.prompts.join()).toContain('"ref":"photo_1"');
        for (const file of f.paths) expect(fs.existsSync(file)).toBe(false);
      }
    } finally { await f.close(); }
  }, 30_000);

for (const role of ["owner", "group", "guest"] as const) for (const mode of ["overflow", "unnegotiated", "no_history_feature", "lease_lost", "bad_bytes"] as const)
  test(`${role}: real runner ${mode} never bypasses admission or download validation`, async () => {
    const f = await runnerCase(role, "claude", mode);
    if (mode === "overflow") f.raw.input.conversation[1]!.media = Array.from({ length: 8 }, (_, i) => photo(`extra_${i}`));
    if (mode === "unnegotiated") f.raw.features = ["requester_context", "relay_history_media"];
    if (mode === "no_history_feature") f.raw.features = ["requester_context", "relay_media_in"];
    try {
      const result = await f.run(f.raw);
      if (mode === "overflow" || mode === "unnegotiated" && role === "guest") expect(result).toMatchObject({ outcome: "declined", reason: "invalid_request" });
      else if (mode === "unnegotiated" || mode === "no_history_feature" || mode === "bad_bytes") expect(result).toMatchObject({ outcome: "answered", answer: { text: "Done." } });
      else if (role === "owner") {
        // Only persistent owner turns deliver owner-tier failure notices.
        expect(result).toMatchObject({ outcome: "answered", answer: { text: "Your request could not be completed. Please try again." } });
      } else if (mode === "lease_lost") expect(result).toBeNull();
      else expect(result).toMatchObject({ outcome: "failed" });
      expect(f.downloads.length).toBe(mode === "no_history_feature" ? role === "guest" ? 4 : 2 : mode === "bad_bytes" ? 4 : mode === "lease_lost" ? 1 : 0);
      if (mode === "no_history_feature") {
        expect(f.downloads).toEqual(role === "guest" ? ["photo_3", "photo_0", "photo_2", "photo_1"] : ["photo_3", "photo_0"]);
        expect(f.prompts.join().includes('"ref":"photo_1"')).toBe(role === "guest");
      } else if (mode === "bad_bytes") {
        expect(f.paths).toEqual([]);
        const media = JSON.parse(f.prompts[0]!.split("<inbound_media>")[1]!.split("</inbound_media>")[0]!);
        expect(media).toHaveLength(4);
        expect(media.every((item: { readable: boolean; reason: string }) => item.readable === false && item.reason === "unsupported_media_type")).toBe(true);
      } else if (mode !== "unnegotiated" || role === "guest") expect(f.prompts).toEqual([]);
      else { expect(f.prompts.join()).toContain("[Media attached; description unavailable]"); expect(f.paths).toEqual([]); }
    } finally { await f.close(); }
  }, 30_000);

for (const role of ["owner", "group"] as const) for (const engine of ["claude", "codex"] as const)
  test(`${role}/${engine}: a continued thread downloads only unseen items and refetches after reset`, async () => {
    const f = await runnerCase(role, engine, "valid", true);
    try {
      expect((await f.run(f.raw))?.outcome).toBe("answered");
      expect(f.downloads).toEqual(["photo_3", "photo_0", "photo_2", "photo_1"]);
      expect(readConversations()[0]?.seen).toContain("message_3");
      const next = structuredClone(f.raw); next.request_id = "history_next";
      next.input.conversation.push(...[4, 5].map(i => ({ ...next.input.conversation[3]!, id: `message_${i}`, reply_to: "message_3", media: [photo(`photo_${i}`, next.input.conversation[3]!.media![0]!.byte_size)] })));
      next.input.respond_to = "message_5";
      expect((await f.run(next))?.outcome).toBe("answered");
      expect(f.downloads).toEqual(["photo_3", "photo_0", "photo_2", "photo_1", "photo_5", "photo_4"]);
      expect(f.prompts[1]).not.toContain('"id":"message_1"');
      expect(f.prompts[1]).not.toContain('"ref":"photo_1"');
      const record = readConversations()[0]!; expect(record.seen).toContain("message_5"); resetConversation(record);
      next.request_id = "history_after_reset";
      expect((await f.run(next))?.outcome).toBe("answered");
      expect(f.downloads.slice(6)).toEqual(["photo_5", "photo_3", "photo_4", "photo_2", "photo_1", "photo_0"]);
      next.request_id = "history_after_reset_again";
      expect((await f.run(next))?.outcome).toBe("answered");
      expect(f.downloads).toHaveLength(12);
    } finally { await f.close(); }
  }, 30_000);

for (const engine of ["claude", "codex"] as const) for (const contextFile of [false, true])
  test(`owner/${engine}: trimmed ${contextFile ? "file" : "inline"} history retains photo rows and cursor through reset`, async () => {
    const f = await runnerCase("owner", engine, "valid", true);
    f.raw.input.conversation[1]!.text = "A".repeat(15000);
    f.raw.input.conversation[2]!.text = "B".repeat(15000);
    if (contextFile) {
      f.raw.input.instructions = "C".repeat(16000);
      f.raw.input.owner_instructions = "D".repeat(16000);
    }
    const rows = (prompt: string) => JSON.parse(prompt.split("<conversation>\n")[1]!.split("\n</conversation>")[0]!) as ExternalRelayRequest["input"]["conversation"];
    const assertLinks = (prompt: string) => {
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES);
      expect(prompt.includes("<relay_context_file>")).toBe(contextFile);
      const sent = rows(prompt);
      for (const message of f.raw.input.conversation) {
        const row = sent.find(row => row.id === message.id)!;
        expect(row).toBeDefined();
        expect(row.media).toEqual(message.media);
        expect(row.author).toEqual(message.author);
        expect(row.sent_at).toBe(message.sent_at);
        expect(row.reply_to).toBe(message.reply_to);
      }
      expect(sent.find(row => row.id === "message_1")!.text).toBe("[Earlier text omitted; attachments retained]");
    };
    try {
      requestSchema.parse(f.raw);
      expect((await f.run(f.raw))?.outcome).toBe("answered");
      const first = [...f.downloads];
      expect(first).toEqual(["photo_3", "photo_0", "photo_2", "photo_1"]);
      const firstSeen = readConversations()[0]!.seen;
      const next = structuredClone(f.raw); next.request_id = "history_trim_next";
      next.input.conversation.push({ ...next.input.conversation[3]!, id: "message_4", reply_to: "message_3", media: undefined, text: "Continue." });
      next.input.respond_to = "message_4";
      expect((await f.run(next))?.outcome).toBe("answered");
      expect(f.downloads.slice(first.length).filter(ref => first.includes(ref))).toEqual([]);
      expect(f.downloads).toEqual(first);
      assertLinks(f.prompts[0]!);
      expect(firstSeen).toEqual(expect.arrayContaining(f.raw.input.conversation.map(message => message.id)));
      next.request_id = "history_trim_third";
      expect((await f.run(next))?.outcome).toBe("answered");
      expect(f.downloads).toEqual(first);
      resetConversation(readConversations()[0]!);
      next.request_id = "history_trim_reset";
      expect((await f.run(next))?.outcome).toBe("answered");
      expect(f.downloads.slice(first.length)).toHaveLength(4);
      expect(new Set(f.downloads.slice(first.length))).toEqual(new Set(first));
      assertLinks(f.prompts[3]!);
      next.request_id = "history_trim_reset_again";
      expect((await f.run(next))?.outcome).toBe("answered");
      expect(f.downloads).toHaveLength(8);
      next.request_id = "history_trim_reset_third";
      expect((await f.run(next))?.outcome).toBe("answered");
      expect(f.downloads).toHaveLength(8);
    } finally { await f.close(); }
  }, 30_000);

for (const role of ["owner", "group", "guest"] as const) for (const mediaOnly of [false, true])
  test(`${role}/codex-cloud: refused media ${mediaOnly ? "gets a reason" : "preserves the text answer"}`, async () => {
    const f = await runnerCase(role, "codex-cloud");
    for (const message of f.raw.input.conversation) {
      message.media = message.media?.map(media => ({ ...media, availability: "unsupported_type", mime_type: "image/gif" }));
      if (message.id === f.raw.input.respond_to) message.text = mediaOnly ? "" : "Answer this text";
    }
    f.raw.input.request_text = null;
    try {
      const result = await f.run(f.raw);
      expect(result).toMatchObject({ outcome: "answered", answer: { text: mediaOnly
        ? "Media could not be read: unsupported media type. Send a JPEG/PNG image or a text request." : "Done." } });
      expect(f.downloads).toEqual([]); expect(f.paths).toEqual([]);
      expect(f.cloudCalls()).toBe(mediaOnly ? 0 : 1);
      if (!mediaOnly) {
        const media = JSON.parse(f.prompts[0]!.split("<inbound_media>")[1]!.split("</inbound_media>")[0]!);
        expect(media.every((item: { readable: boolean }) => item.readable === false)).toBe(true);
      }
    } finally { await f.close(); }
  });
