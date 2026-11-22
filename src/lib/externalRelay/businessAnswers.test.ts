import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { accountManager } from "@/lib/accounts/manager";
import { readAnswerRecord } from "./answers";
import { answerPair, answerText, businessFeature, cases, isolatedRequesterFeature, photoRef } from "./businessAnswers.fixture";
import { readConversations } from "./conversations";
import { completeRelayRequest } from "./relayCompletion";
import { MAX_INPUT_MEDIA_FILE_BYTES, validateMediaInput } from "./mediaInputValidation";
import * as bridge from "./ownerBridgeContext";
import * as outbound from "./ownerOutboundContext";
import { ensureExternalRelayPollers, relayClaimBody, stopExternalRelayPollers, waitForExternalRelayRuns } from "./poller";
import { checkedAnswer, claimedRequestSchema, requestSchema, type ExternalRelayCompletion, type ExternalRelayRequest } from "./protocol";
import { richRequest } from "./rich.fixture";
import { runClaimedRequest } from "./runner";
import { newTargetSettings, readRunLedger, updateRelayStore, type PairedRelay } from "./store";
import { readRelaySwitches, setRelaySwitch } from "./switches";
import { startTestRelay } from "./testRelay";

const switchName = "relay:business_answers:enabled";
const now = Date.parse("2026-01-01T12:00:02Z");
const ownerCanary = "Fixture owner memory stays at home.";
const previousTurn = "A previous request in the same chat.";
const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-business-"));
const state = path.join(suiteRoot, "state");
let root: string;
let stateBefore: string | undefined;

beforeAll(() => {
  stateBefore = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = state;
});
beforeEach(() => {
  fs.rmSync(path.join(state, "external-relay"), { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(suiteRoot, "case-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
afterAll(() => {
  if (stateBefore === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = stateBefore;
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});

function paired(origin: string, engine: "claude" | "codex" | "codex-cloud" = "claude"): PairedRelay {
  return { id: "business_fixture", origin, api_base: `${origin}/v1`, name: "Fixture relay", description: "",
    credential: "fixture".repeat(6), owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: "2026-01-01T12:00:00Z", paused: false, features: [businessFeature, "relay_media_in", "relay_history_media", "progress_steps"],
    limits: { max_wait_s: 25, max_response_bytes: 1048576, max_answer_chars: 240 },
    targets: [{ ...newTargetSettings({ target_id: "target_1", name: "Garden", answered_by: "install", fallback: "service" }),
      engine, model: "fixture", ownerTier: true, memberLimitPerHour: null,
      ...(engine === "codex-cloud" ? { cloudEnvironmentId: "fixture-environment" } : {}) }] };
}

for (const kind of cases) test(`${kind} claim and completion match the paired contract`, () => {
  const pair = answerPair(kind);
  const request = claimedRequestSchema(pair.advertised).parse(pair.request);
  expect(request).toEqual(pair.request);
  expect(requestSchema.safeParse(pair.request).success).toBe(pair.defaultAccepts);
  expect(checkedAnswer({ action: "reply", text: answerText, reply_to: pair.modelReplyTo }, request)).toEqual(pair.expectedAnswer);
  expect(checkedAnswer({ action: "ignore", text: "", reply_to: null }, request) === null).toBe(pair.isolated);
});

test("Business history photos are retained with the production media advertisement", () => {
  const pair = answerPair("business_contact");
  const parsed = claimedRequestSchema(pair.advertised).parse(pair.request);
  expect(validateMediaInput(parsed, true)).toEqual(pair.request.input.conversation[0]!.media!);
  expect(claimedRequestSchema(pair.advertised.filter(feature => feature !== "relay_media_in"))
    .safeParse(pair.request).success).toBe(false);
});

test("enabled Business claims lease history media even when the peer descriptor omits that feature", () => {
  setRelaySwitch("relay:business_answers:enabled", true);
  try {
    const pair = paired("http://127.0.0.1");
    pair.features = ["relay_business_answers", "relay_media_in"];
    updateRelayStore(store => ({ ...store, relays: [pair] }));
    const claim = relayClaimBody(pair);
    expect(claim.features).toContain("relay_history_media");
    const fixture = answerPair("business_contact", 1, true);
    expect(claimedRequestSchema(claim.features).safeParse(fixture.request).success).toBe(true);
    expect(validateMediaInput(fixture.request, true)).toEqual(fixture.request.input.conversation[0]!.media!);
  } finally { setRelaySwitch("relay:business_answers:enabled", false); }
});

test("Business history photo claim matches descriptor without the optional history media feature", () => {
  const pair = answerPair("business_contact", 1, false);
  const parsed = claimedRequestSchema(pair.advertised).parse(pair.request);
  expect(pair.advertised).not.toContain("relay_history_media");
  expect(validateMediaInput(parsed, true, false)).toEqual(pair.request.input.conversation[0]!.media!);
});

test("an oversized Business history photo remains visible as unavailable context", () => {
  const pair = answerPair("business_contact", MAX_INPUT_MEDIA_FILE_BYTES + 1);
  const parsed = claimedRequestSchema(pair.advertised).parse(pair.request);
  expect(validateMediaInput(parsed, true)).toEqual([{
    ref: photoRef, kind: "photo", availability: "too_large", mime_type: "image/png", expires_at: "2099-01-01T00:00:00Z",
  }]);
});

type HostileCase = [string, (request: ExternalRelayRequest) => unknown];
const requesterAttacks: HostileCase[] = [
  ...(["is_admin", "can_restrict_members", "can_delete_messages", "is_anonymous_admin"] as const)
    .map((flag): HostileCase => [flag, req => { req.input.requester![flag] = true; return req; }]),
  ["swapped requester key", req => { req.input.requester!.key = "person_unrelated"; return req; }],
  ["swapped trigger author", req => { req.input.conversation.at(-1)!.author = { key: "person_unrelated", name: "Unrelated", self: false }; return req; }],
  ["duplicate trigger", req => { req.input.conversation.push({ ...req.input.conversation.at(-1)! }); return req; }],
  ["self trigger", req => { req.input.conversation.at(-1)!.author = { ...req.input.conversation.at(-1)!.author, self: true }; return req; }],
];
test("private owner flag is rejected before selecting an account", async () => {
  const privateOwnerFlag = answerPair("private_non_owner");
  privateOwnerFlag.request.input.requester!.is_owner = true;
  const server = await startTestRelay(() => ({ body: { status: "accepted", duplicate: false } }));
  const selection = spyOn(accountManager, "resolveHeadlessSpawn");
  try {
    expect(claimedRequestSchema(privateOwnerFlag.advertised).safeParse(privateOwnerFlag.request).success).toBe(false);
    expect(await runClaimedRequest(paired(server.origin), privateOwnerFlag.request, undefined,
      { advertisedFeatures: privateOwnerFlag.advertised, leaseWorker: false }))
      .toMatchObject({ outcome: "declined", reason: "invalid_request" });
    expect(selection).not.toHaveBeenCalled();
  } finally { selection.mockRestore(); await server.close(); }
});
const businessAttacks: HostileCase[] = [
  ["missing requester", req => { delete req.input.requester; return req; }],
  ["owner destination", req => ({ ...req, owner_delivery: { chat_id: 51, reply_to_message_id: 17, message_thread_id: null } })],
  ["malformed owner destination", req => ({ ...req, owner_delivery: { chat_id: "opaque" } })],
  ["progress", req => { req.answer.progress = "notes"; return req; }],
  ["direct tools", req => { req.input.tools = [{ name: "garden_read", summary: "Read notes", mode: "direct" }]; return req; }],
  ["rich format", req => { req.input.format = richRequest(true).input.format; return req; }],
  ["output attachments", req => { req.answer.attachments = { max_items: 1, max_total_bytes: 1024, kinds: ["photo"] }; return req; }],
  ["unnegotiated media", req => { req.features = ["requester_context", businessFeature]; return req; }],
  ["unadvertised arbitrary document", req => { req.features = ["relay_media_any_document"]; return req; }],
  ["history document", req => { req.input.conversation[0]!.media![0]!.kind = "document"; return req; }],
  ["out-of-scope media ref", req => {
    req.input.documents.push({ title: "Detached media", text: "", message_id: req.input.respond_to!,
      media_ref: `media_${"1".repeat(32)}`, extraction: "complete" });
    return req;
  }],
  ["conflicting ref", req => {
    req.input.conversation.at(-1)!.media = [{ ...req.input.conversation[0]!.media![0]!, byte_size: 2 }];
    return req;
  }],
  ["more than ten refs", req => {
    const photo = req.input.conversation[0]!.media![0]!;
    req.input.conversation[0]!.media = Array.from({ length: 10 }, (_, i) => ({ ...photo, ref: `photo_${i}` }));
    req.input.conversation.at(-1)!.media = [photo];
    return req;
  }],
];

test("new isolated claims refuse hostile input before account selection or any lease effects", async () => {
  const endpoints: string[] = [];
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    endpoints.push(req.url!.split("/").at(-1)!);
    completions.push(body);
      return { body: { status: "accepted", duplicate: false } };
  });

  const selection = spyOn(accountManager, "resolveHeadlessSpawn");
  const relay = paired(server.origin);
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const probes = (["business_contact", "guest_non_owner", "private_non_owner"] as const).flatMap(kind => {
      const attacks = kind === "business_contact" ? [...requesterAttacks, ...businessAttacks] : requesterAttacks;
      return [...attacks.map(([name, attack]) => {
        const pair = answerPair(kind);
        pair.request.request_id += `_${name.replaceAll(" ", "_")}`;
        return { raw: attack(pair.request), request: pair.request, advertised: pair.advertised };
      }), { raw: answerPair(kind).request, request: answerPair(kind).request, advertised: [] }];
    });
    const noBusinessCapability = answerPair("business_owner");
    probes.push({ raw: noBusinessCapability.request, request: noBusinessCapability.request,
      advertised: noBusinessCapability.advertised.filter(feature => feature !== businessFeature) });
    const noInboundCapability = answerPair("business_contact");
    noInboundCapability.request.request_id += "_poll_without_media";
    probes.push({ raw: noInboundCapability.request, request: noInboundCapability.request,
      advertised: noInboundCapability.advertised.filter(feature => feature !== "relay_media_in") });
    for (const { raw, request, advertised } of probes) {
      expect(claimedRequestSchema(advertised).safeParse(raw).success).toBe(false);
      const result = await runClaimedRequest(relay, raw, undefined, { advertisedFeatures: advertised, leaseWorker: false });
      expect(result).toMatchObject({ lease_id: request.lease_id, outcome: "declined", reason: "invalid_request", retry_after_s: null });
      expect(completions.at(-1)).toEqual(result);
    }
    expect(endpoints).toEqual(probes.map(() => "complete"));
    expect(selection).not.toHaveBeenCalled();
    expect(readConversations()).toEqual([]);
    expect(readRunLedger().runs).toEqual([]);
  } finally {
    clock.mockRestore();
    selection.mockRestore();
    await server.close();
  }
});

function localAgent(engine: "claude" | "codex", modelReplyTo: string) {
  const home = path.join(root, "account");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "AGENTS.md"), ownerCanary);
  fs.writeFileSync(path.join(home, "CLAUDE.md"), ownerCanary);
  fs.writeFileSync(path.join(home, "memory.md"), ownerCanary);
  fs.writeFileSync(path.join(home, "auth.json"), "{}");
  fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "fixture" }] }));
  const capture = path.join(root, "agent.json");
  const command = path.join(root, "agent");
  fs.writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prompt = await Bun.stdin.text();
const config = process.env.${engine === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"};
const imageBytes = args.filter((_, i) => args[i - 1] === "--image").map(file => fs.readFileSync(file).length);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args, prompt, config, imageBytes, memoryPresent: config && fs.existsSync(path.join(config, "memory.md"))
}));
const answer = ${JSON.stringify({ action: "reply", text: answerText, reply_to: modelReplyTo })};
${engine === "claude" ? `
console.log(JSON.stringify({type:"system", subtype:"init", session_id:args[args.indexOf("--session-id") + 1], tools:["StructuredOutput","WebSearch"], mcp_servers:[]}));
console.log(JSON.stringify({type:"result", subtype:"success", structured_output:answer}));` :
    'fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(answer));'}
`);
  fs.chmodSync(command, 0o700);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({
    kind: "available", account: { engine, accountId: "fixture", kind: "managed", home, transcriptRoot: home, env: { ...process.env } },
  });
  const readCapture = (): { args: string[]; prompt: string; config: string; imageBytes: number[]; memoryPresent: boolean } =>
    JSON.parse(fs.readFileSync(capture, "utf8"));
  return { command, home, readCapture, selection };
}

for (const [kind, engine] of [
  ...cases.map(kind => [kind, "claude"] as const),
  ...cases.slice(0, 3).map(kind => [kind, "codex"] as const),
]) test(`${kind} completes through the ${engine} runner with the expected authority`, async () => {
  const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).png().toBuffer();
  const pair = answerPair(kind, photo.length);
  const endpoints: string[] = [], completions: unknown[] = [], mediaLeases: unknown[] = [], progress: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    const endpoint = req.url!.split("/").at(-1)!;
    endpoints.push(endpoint);
    if (endpoint === photoRef) {
      mediaLeases.push(req.headers["delegatus-relay-lease"]);
      return { raw: photo, headers: { "content-type": "image/png", "content-length": String(photo.length) } };
    }
    if (endpoint === "heartbeat" && body && typeof body === "object" && "progress" in body) progress.push(body.progress);
    if (endpoint === "complete") completions.push(body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const relay = paired(server.origin, engine);
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const agent = localAgent(engine, pair.modelReplyTo);
  const launch = spyOn({ launch: async () => { throw new Error("unexpected owner launch"); } }, "launch");
  const ownerOutbound = spyOn(outbound, "resolveOwnerOutboundContext");
  const ownerBridge = spyOn(bridge, "resolveOwnerBridgeContext");
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const run = (request: unknown) => runClaimedRequest(relay, request, undefined, {
    advertisedFeatures: pair.advertised, command: agent.command, leaseWorker: false,
    ownerPorts: { launch, observe: async () => ({ state: "ended", finalText: "Unexpected" }), stop: async () => {} },
  });
  try {
    if (pair.isolated) {
      pair.request.input.short_term_memory = previousTurn;
      pair.request.input.tools = [{ name: "private_owner_handoff", summary: "Restricted owner handoff", audience: "owner", mode: "handoff" }];
    } else if (pair.request.input.tools) {
      pair.request.input.tools.push({ name: "private_owner_handoff", summary: "Restricted owner handoff", audience: "owner", mode: "handoff" });
    }
    const result = await run(pair.isolated
      ? { ...pair.request, input: { ...pair.request.input, platform_chat_id: 51 } }
      : pair.request);
    expect(result).toEqual({ lease_id: pair.request.lease_id, outcome: "answered", answer: pair.expectedAnswer, duration_ms: 0 });
    expect(completions).toEqual([result]);
    const record = readAnswerRecord(relay.id, pair.request.target_id, pair.request.request_id);
    expect(record).toMatchObject({ delivery: "accepted", answer: pair.expectedAnswer, outcome: "answered" });
    expect(record?.profile?.owner).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
    expect(ownerOutbound).not.toHaveBeenCalled();
    expect(ownerBridge).not.toHaveBeenCalled();
    expect(endpoints.every(endpoint => ["heartbeat", "complete", photoRef].includes(endpoint))).toBe(true);
    expect(mediaLeases).toEqual(pair.hasPhoto ? [pair.request.lease_id] : []);
    expect(readRunLedger().runs).toEqual([]);
    const first = agent.readCapture();
    expect(first.prompt).not.toContain("private_owner_handoff");
    if (pair.hasPhoto) {
      if (engine === "claude") expect(first.prompt).toContain('"type":"image"');
      else expect(first.imageBytes).toEqual([photo.length]);
    }
    if (pair.isolated) {
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every(value => value === null)).toBe(true);
      expect(record?.input).not.toHaveProperty("platform_chat_id");
      expect(first.prompt).not.toContain("platform_chat_id");
      const configName = engine === "claude" ? "claude-home" : "codex-home";
      expect(path.basename(first.config)).toBe(configName);
      expect(first.config.startsWith(agent.home + path.sep)).toBe(false);
      expect(first.args).toContain(engine === "claude" ? "--no-session-persistence" : "--ephemeral");
      expect(first.args).not.toContain("--resume");
      expect(first.memoryPresent).toBe(false);
      expect(first.prompt).not.toContain(ownerCanary);
      expect(first.prompt).toContain(previousTurn);
      expect(fs.existsSync(first.config)).toBe(false);
      const follow = answerPair(kind, photo.length).request;
      follow.request_id += "_follow";
      expect((await run(follow))?.outcome).toBe("answered");
      const second = agent.readCapture();
      expect(second.config).not.toBe(first.config);
      expect(second.prompt).not.toContain(previousTurn);
      expect(readConversations()).toEqual([]);
      expect(record?.conversationId).toBeUndefined();
    } else {
      expect(readConversations().map(conversation => conversation.authority))
        .toEqual(kind === "legacy_no_business" ? [] : ["member"]);
    }
  } finally {
    clock.mockRestore();
    ownerOutbound.mockRestore();
    ownerBridge.mockRestore();
    agent.selection.mockRestore();
    await server.close();
  }
}, 15_000);

test("the Business switch is opt-in and advertises both capabilities", () => {
  const relay = paired("http://127.0.0.1:1");
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  expect(readRelaySwitches().business_answers).toBe(false);
  const baseline = relayClaimBody(relay);
  expect(baseline.features).not.toContain(businessFeature);
  expect(baseline.features).not.toContain(isolatedRequesterFeature);
  setRelaySwitch(switchName, true);
  expect(relayClaimBody(relay)).toEqual({ ...baseline, features: [...baseline.features, isolatedRequesterFeature, businessFeature] });
  setRelaySwitch(switchName, false);
  expect(relayClaimBody(relay)).toEqual(baseline);
});

test("the real poller keeps the lease's advertisement after the switch is withdrawn", async () => {
  const original = answerPair("business_owner").request;
  const claims: unknown[] = [];
  const completions = new Map<string, unknown>();
  const server = await startTestRelay((req, body) => {
    const endpoint = req.url!.split("/").at(-1)!;
    if (endpoint === "targets") return { body: { targets: [{ target_id: "target_1", name: "Garden", answered_by: "install", fallback: "service" }] } };
    if (endpoint === "delegatus-relay.json") return { body: { ...paired(server.origin), protocol: "delegatus-relay",
      versions: [1], kinds: ["answer"], liveness: original.liveness } };
    if (endpoint === "claim") {
      claims.push(body);
      if (claims.length === 1) {
        setRelaySwitch(switchName, false);
        return { body: { request: original } };
      }
      if (claims.length === 2) return { body: { request: { ...original, request_id: "unadvertised_business" } } };
      return { status: 204 };
    }
    if (endpoint === "complete") completions.set(req.url!.split("/").at(-2)!, body);
    return { body: { status: "accepted", duplicate: false } };
  });
  const relay = paired(server.origin);
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "unavailable" });
  try {
    setRelaySwitch(switchName, true);
    ensureExternalRelayPollers();
    const until = Date.now() + 5_000;
    while (completions.size < 2 && Date.now() < until) await Bun.sleep(10);
    expect(claims[0]).toMatchObject({ features: expect.arrayContaining([isolatedRequesterFeature, businessFeature]) });
    expect(claims[1]).toEqual(relayClaimBody(relay));
    expect(completions.get(original.request_id)).toMatchObject({ outcome: "declined", reason: "no_capacity" });
    expect(completions.get("unadvertised_business")).toMatchObject({ outcome: "declined", reason: "invalid_request" });
    expect(selection).toHaveBeenCalledTimes(1);
  } finally {
    stopExternalRelayPollers();
    await waitForExternalRelayRuns();
    selection.mockRestore();
    await server.close();
  }
}, 15_000);

test("default-off real poller admits and downloads a legacy guest owner's history photo", async () => {
  const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).png().toBuffer();
  const pair = answerPair("guest_non_owner", photo.length);
  const request = pair.request;
  request.request_id = "legacy_guest_history_photo";
  request.input.requester!.is_owner = true;
  request.features = ["requester_context", "relay_media_in"];
  request.input.conversation[0]!.media = [{ ref: photoRef, kind: "photo", availability: "ready",
    mime_type: "image/png", byte_size: photo.length, expires_at: "2099-01-01T00:00:00Z" }];
  const seen: string[] = [];
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/targets")) return { body: { targets: [{ target_id: "target_1", name: "Garden", answered_by: "install", fallback: "service" }] } };
    if (req.url === "/.well-known/delegatus-relay.json") return { body: { protocol: "delegatus-relay", versions: [1],
      name: "Fixture relay", description: "", api_base: `${server.origin}/v1`, kinds: ["answer"], liveness: request.liveness,
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 240 },
      features: ["requester_context", "relay_media_in"] } };
    if (req.url?.endsWith("/claim")) return { body: { request } };
    if (req.url?.endsWith(`/media/${photoRef}`)) {
      seen.push(req.url);
      return { raw: photo, headers: { "content-type": "image/png", "content-length": String(photo.length) } };
    }
    if (req.url?.endsWith("/complete")) { completions.push(body); stopExternalRelayPollers(); }
    return { body: { status: "accepted", duplicate: false } };
  });
  const relay = paired(server.origin, "codex");
  relay.features = ["relay_media_in"];
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available",
    account: { engine: "codex", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { ...process.env } } });
  try {
    setRelaySwitch(switchName, false);
    expect(readRelaySwitches().business_answers).toBe(false);
    ensureExternalRelayPollers();
    const deadline = Date.now() + 8_000;
    while (!completions.length && Date.now() < deadline) await Bun.sleep(10);
    await waitForExternalRelayRuns();
    expect(completions).toHaveLength(1);
    expect(seen).toEqual([`/v1/requests/${request.request_id}/media/${photoRef}`]);
    expect(completions[0]).toBeDefined();
    expect(relayClaimBody(relay).features).not.toContain("relay_history_media");
  } finally {
    stopExternalRelayPollers();
    await waitForExternalRelayRuns();
    selection.mockRestore();
    updateRelayStore(store => ({ ...store, relays: [] }));
    await server.close();
  }
}, 15_000);

test("an advertised Business history photo uses the local Codex path for a Cloud target", async () => {
  const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).png().toBuffer();
  const pair = answerPair("business_contact", photo.length);
  const mediaPaths: string[] = [];
  const server = await startTestRelay(req => {
    if (req.url?.endsWith(`/media/${photoRef}`)) {
      mediaPaths.push(req.url);
      return { raw: photo, headers: { "content-type": "image/png", "content-length": String(photo.length) } };
    }
    return { body: { status: "accepted", duplicate: false } };
  });
  const relay = paired(server.origin, "codex-cloud");
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const agent = localAgent("codex", pair.modelReplyTo);
  const cloudTransport = spyOn({ send: async () => { throw new Error("unexpected Cloud request"); } }, "send");
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    setRelaySwitch(switchName, true);
    const advertisedFeatures = relayClaimBody(relay).features;
    setRelaySwitch(switchName, false);
    const runtime = { advertisedFeatures, cloudTransport, command: agent.command, leaseWorker: false };
    expect(await runClaimedRequest(relay, pair.request, undefined, runtime))
      .toEqual({ lease_id: pair.request.lease_id, outcome: "answered", answer: pair.expectedAnswer, duration_ms: 0 });
    expect(agent.selection.mock.calls[0]?.[0]).toBe("codex");
    expect(agent.readCapture().imageBytes).toEqual([photo.length]);
    expect(agent.readCapture().args).toContain("--ephemeral");
    const absent = { ...pair.request, request_id: "business_no_local_capacity" };
    agent.selection.mockReturnValue({ kind: "unavailable" });
    expect(await runClaimedRequest(relay, absent, undefined, runtime)).toEqual({
      lease_id: pair.request.lease_id, outcome: "declined", reason: "no_capacity", detail: null, retry_after_s: null,
    });
    expect(mediaPaths).toEqual([`/v1/requests/${pair.request.request_id}/media/${photoRef}`]);
    expect(cloudTransport).not.toHaveBeenCalled();
    expect(readConversations()).toEqual([]);
  } finally {
    clock.mockRestore();
    agent.selection.mockRestore();
    await server.close();
  }
});

test("a revoked pairing cannot start a Business run or download its history photo", async () => {
  const pair = answerPair("business_contact");
  const endpoints: string[] = [];
  const server = await startTestRelay(req => {
    endpoints.push(req.url!.split("/").at(-1)!);
    return { status: 401, body: { error: { code: "credential_rejected" } } };
  });
  const relay = paired(server.origin);
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "unavailable" });
  try {
    expect(await runClaimedRequest(relay, pair.request, undefined, { advertisedFeatures: pair.advertised, leaseWorker: false })).toBeNull();
    expect(endpoints).toEqual(["heartbeat"]);
    expect(selection).not.toHaveBeenCalled();
    expect(readRunLedger().runs).toEqual([]);
  } finally {
    selection.mockRestore();
    await server.close();
  }
});

for (const disposition of ["lost_ack", "lost_ack_then_revoked", "unknown", "late", "revoked", "too_large"] as const)
  test(`Business completion settles ${disposition} with one frozen-anchor reply`, async () => {
    const pair = answerPair("business_owner");
    const sent: unknown[] = [];
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const server = await startTestRelay((req, body) => {
      if (!req.url?.endsWith("/complete")) return { body: { status: "ok" } };
      sent.push(body);
      if (disposition.startsWith("lost_ack") && sent.length === 1) return { drop: true };
      if (disposition === "unknown") {
        clock.mockReturnValue(now + 60_000);
        return { drop: true };
      }
      if (disposition === "late") return { status: 409, body: { error: { code: "lease_lost" } } };
      if (disposition === "revoked" || disposition === "lost_ack_then_revoked")
        return { status: 401, body: { error: { code: "credential_rejected" } } };
      if (disposition === "too_large") return { status: 413, body: { error: { code: "too_large" } } };
      return { body: { status: "accepted", duplicate: true } };
    });
    const relay = paired(server.origin);
    updateRelayStore(store => ({ ...store, relays: [relay] }));
    const agent = localAgent("claude", pair.modelReplyTo);
    try {
      const request = { ...pair.request, deadline_at: new Date(now + 30_000).toISOString() };
      const completion = await runClaimedRequest(relay, request, undefined, {
        advertisedFeatures: pair.advertised, leaseWorker: disposition === "too_large", command: agent.command,
      });
      const expected = { lease_id: request.lease_id, outcome: "answered", answer: pair.expectedAnswer, duration_ms: 0 } satisfies ExternalRelayCompletion;
      expect(completion).toEqual(expected);
      expect(sent).toEqual(disposition.startsWith("lost_ack") ? [expected, expected] : [expected]);
      expect(readAnswerRecord(relay.id, request.target_id, request.request_id)).toMatchObject({
        delivery: disposition === "lost_ack" ? "accepted"
          : disposition === "unknown" || disposition === "lost_ack_then_revoked" ? "unconfirmed" : "refused",
        answer: pair.expectedAnswer,
      });
      if (disposition === "unknown") {
        const launches = agent.selection.mock.calls.length;
        expect(await runClaimedRequest(relay, { ...pair.request }, undefined, {
          advertisedFeatures: pair.advertised, leaseWorker: false, command: agent.command,
        })).toBeNull();
        expect(agent.selection).toHaveBeenCalledTimes(launches);
        expect(sent).toEqual([expected]);
      }
    } finally {
      clock.mockRestore();
      agent.selection.mockRestore();
      await server.close();
    }
  });

test("isolated completion requires a valid HTTP 200 CompletionAck and retries the identical answer", async () => {
  let clockNow = now;
  const clock = spyOn(Date, "now").mockImplementation(() => clockNow);
  const sent: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (!req.url?.endsWith("/complete")) return { body: { status: "ok" } };
    sent.push(body);
    if (sent.length === 1) { clockNow = now + 1000; return { status: 204 }; }
    if (sent.length === 2) { clockNow = now + 1500; return { status: 200, body: { status: "accepted" } }; }
    return { status: 200, body: { status: "accepted", duplicate: true } };
  });
  const pair = answerPair("private_non_owner");
  const completion: ExternalRelayCompletion = { lease_id: pair.request.lease_id, outcome: "answered",
    answer: pair.expectedAnswer, duration_ms: 0 };
  try {
    expect(await completeRelayRequest(paired(server.origin), pair.request.request_id, completion, () => now + 2000,
      undefined, undefined, 4000, undefined, undefined, true)).toEqual({ body: completion, delivery: "accepted" });
    expect(sent).toEqual([completion, completion, completion]);
  } finally { clock.mockRestore(); await server.close(); }
});

test("isolated completion without a valid receipt remains unconfirmed", async () => {
  let clockNow = now;
  const clock = spyOn(Date, "now").mockImplementation(() => clockNow);
  const sent: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (!req.url?.endsWith("/complete")) return { body: { status: "ok" } };
    sent.push(body);
    clockNow = sent.length === 1 ? now + 1000 : now + 2000;
    return sent.length === 1 ? { status: 204 } : { status: 200, body: { status: "accepted" } };
  });
  const pair = answerPair("private_non_owner");
  const completion: ExternalRelayCompletion = { lease_id: pair.request.lease_id, outcome: "answered",
    answer: pair.expectedAnswer, duration_ms: 0 };
  try {
    expect(await completeRelayRequest(paired(server.origin), pair.request.request_id, completion, () => now + 2000,
      undefined, undefined, 4000, undefined, undefined, true)).toEqual({ body: completion, delivery: "unconfirmed" });
    expect(sent).toEqual([completion, completion]);
  } finally { clock.mockRestore(); await server.close(); }
});
