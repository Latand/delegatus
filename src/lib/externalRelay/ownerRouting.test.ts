import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { accountManager } from "@/lib/accounts/manager";
import { DECISIONS_ENDPOINT } from "@/lib/openaiServices/decisions";
import { readAnswerRecord } from "./answers";
import { richRequest } from "./rich.fixture";
import { contextRequest } from "./request.fixture";
import { ownerTierFor } from "./profile";
import * as outboundContext from "./ownerOutboundContext";
import { scrubOwnerOutput } from "./ownerOutput";
import { requestSchema } from "./protocol";
import { destinationRelay, destinationTarget } from "./ownerDestination.fixture";
import { runClaimedRequest } from "./runner";
import { RelayLeaseTransport } from "./relayLeaseTransport";
import { changeRun, dropRun, readRunLedger, updateRelayStore } from "./store";
import { setRelaySwitch } from "./switches";
import { startTestRelay } from "./testRelay";
import { routeOwnerMessage, routingEnabled, ROUTING_THRESHOLDS, type RelayRoutingEvidence } from "./ownerRouting";

type HttpInput = Parameters<typeof fetch>[0];
type HttpOptions = Parameters<typeof fetch>[1];
const originalRouting = process.env.LLV_RELAY_ROUTING;
const epoch = Date.parse("2026-11-17T09:00:00Z");
beforeEach(() => setSystemTime(epoch));
afterEach(() => {
  setSystemTime();
  if (originalRouting === undefined) delete process.env.LLV_RELAY_ROUTING;
  else process.env.LLV_RELAY_ROUTING = originalRouting;
});
function request() {
  const source = richRequest();
  return requestSchema.parse({ ...source, claimed_at: new Date().toISOString(),
    input: { ...source.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: true } } });
}
const low = { machine: 0.01, action: 0.02, reasoning: 0.03 };
function classification(scores = low) {
  return Response.json({ answers: Object.entries(scores).map(([name, probability]) => ({ type: "predicate", name, probability })),
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 } } });
}
function answer(text = "**Hello**") {
  return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, output_tokens: 20 } });
}
async function route(http: typeof fetch, options: { timeoutMs?: number; authorize?: () => void; apiKey?: string | null } = {}) {
  const input = request(); const evidence: RelayRoutingEvidence[] = [];
  const result = await routeOwnerMessage(input, ownerTierFor({ ownerTier: true }, input)!, {
    apiKey: "fixture", signal: new AbortController().signal, authorize: () => {},
    ...options, fetch: http, observe: row => evidence.push(structuredClone(row)),
  });
  return { result, evidence: evidence.at(-1)! };
}
test("classifier and fast requests scrub credentials and fast output uses the owner's privacy boundary", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const input = request();
  const secret = ["fixture", "routing", "private", "value"].join("-");
  input.input.conversation[0]!.text = `What does this mean? api_key=${secret}`;
  const owner = ownerTierFor({ ownerTier: true }, input)!;
  const result = await routeOwnerMessage(input, owner, { apiKey: secret, signal: new AbortController().signal,
    authorize: () => {}, observe: () => {}, fetch: (async (url: HttpInput, init?: HttpOptions) => {
      expect(String(init?.body)).not.toContain(secret);
      if (String(url) === DECISIONS_ENDPOINT) return classification();
      return answer(`**Answer** ${secret}`);
    }) as unknown as typeof fetch });
  expect(result?.text).toContain("[redacted]"); expect(result?.text).not.toContain(secret);
});
test("both providers receive neutral message identities with intact reply relationships", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const relay = destinationRelay();
  relay.credential = "routing".repeat(6) + "x";
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  expect(scrubOwnerOutput(relay.credential)).toBe("[redacted]");
  const input = request();
  const current = { ...input.input.conversation[0]!, id: relay.credential, reply_to: `parent_${relay.credential}`, text: "Draft" };
  const parent = { ...current, id: current.reply_to, reply_to: `missing_${relay.credential}`,
    author: { key: relay.credential, name: relay.credential, self: true }, text: "Choose a name: Draft or Release." };
  input.input.conversation = [parent, current]; input.input.respond_to = current.id;
  input.input.requester!.key = current.author.key;
  const owner = ownerTierFor({ ownerTier: true }, input)!;
  const inputs: unknown[] = [];
  const leaks: boolean[] = [];
  const result = await routeOwnerMessage(requestSchema.parse(input), owner, {
    apiKey: "fixture", signal: new AbortController().signal, authorize: () => {}, observe: () => {},
    fetch: (async (url: HttpInput, init?: HttpOptions) => {
      const body = JSON.parse(String(init?.body));
      leaks.push(String(init?.body).includes(relay.credential));
      inputs.push(JSON.parse(String(url) === DECISIONS_ENDPOINT ? body.input[0].content[1].data.input : body.input));
      return String(url) === DECISIONS_ENDPOINT ? classification() : answer();
    }) as unknown as typeof fetch,
  });
  expect(leaks).toEqual([false, false]);
  expect(inputs).toHaveLength(2); expect(inputs[0]).toEqual(inputs[1]);
  const rows = (inputs[0] as { conversation: { id: string; reply_to: string | null; self: boolean }[] }).conversation;
  expect(rows[1]!.reply_to).toBe(rows[0]!.id);
  expect(inputs[0]).toMatchObject({ respond_to: rows[1]!.id });
  expect(new Set([rows[0]!.id, rows[1]!.id, rows[0]!.reply_to]).size).toBe(3);
  expect(rows.map(row => row.self)).toEqual([true, false]);
  expect(result).toMatchObject({ action: "reply", reply_to: current.id });
});
for (const field of ["message", "request", "reply"] as const)
for (const encoded of [false, true])
test(`privacy withholding preserves full-agent dispatch for ${field} (encoded=${encoded})`, async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const apiKey = ["fixture", "routing", "private", "value"].join("-");
  const secret = encoded ? Array.from(apiKey, char => `%${char.charCodeAt(0).toString(16)}`).join("") : apiKey;
  const instruction = "Fix the failing project tests.";
  const text = `${instruction} Log: ${secret}`;
  expect(scrubOwnerOutput(text, [apiKey])).toBe(encoded ? "[redacted]" : `${instruction} Log: [redacted]`);
  const input = request(); input.request_id = `routing_privacy_${field}_${encoded}`;
  const current = input.input.conversation[0]!;
  current.text = field === "message" ? text : "Please proceed.";
  if (field === "request") input.input.request_text = text;
  if (field === "reply") {
    current.reply_to = "parent";
    input.input.conversation.unshift({ ...current, id: "parent", reply_to: null, text,
      author: { key: "assistant", name: "Assistant", self: true } });
  }
  const posts: unknown[] = [];
  const service = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) posts.push(body); return { body: { status: "ok" } }; });
  const relay = destinationRelay([destinationTarget("target_1", true)]);
  relay.targets[0]!.project = null; relay.origin = service.origin; relay.api_base = `${service.origin}/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] })); setRelaySwitch("chain_conversations", false);
  const recovered = spyOn(outboundContext, "resolveOwnerOutboundContext").mockResolvedValue(null);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  let calls = 0; let launches = 0;
  try {
    const result = await runClaimedRequest(relay, requestSchema.parse(input), undefined, { leaseWorker: false,
      routing: { apiKey, fetch: (async (url: HttpInput, init?: HttpOptions) => {
        calls++;
        expect(String(init?.body)).not.toContain(apiKey);
        expect(String(init?.body)).not.toContain(secret);
        const body = JSON.parse(String(init?.body));
        const data = String(url) === DECISIONS_ENDPOINT ? body.input[0].content[1].data.input : body.input;
        return String(url) === DECISIONS_ENDPOINT ? classification({ ...low, action: data.includes(instruction) ? 0.99 : 0.01 }) : answer();
      }) as unknown as typeof fetch },
      ownerPorts: { launch: async () => {
        launches++; return { status: 202, body: { conversationId: `conversation_privacy_${field}_${encoded}`, initialMessage: "delivered" } };
      }, observe: async () => ({ state: "ended", finalText: "**Full action result**" }), stop: async () => {}, pollMs: 1 },
    });
    expect(calls).toBe(encoded ? 0 : 1); expect(launches).toBe(1);
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "**Full action result**", reply_to: current.id } });
    expect(posts).toEqual([result]);
    expect(readAnswerRecord(relay.id, input.target_id, input.request_id)).toMatchObject({ delivery: "accepted", routing: {
      path: "full", reason: encoded ? "privacy" : "predicate", fast: null,
      classifier: { status: encoded ? "skipped" : "completed", costUsd: encoded ? 0 : expect.any(Number) } } });
  } finally { recovered.mockRestore(); selection.mockRestore(); await service.close(); }
});
test("classifier redaction that removes all current text falls back before either provider", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const input = request(); input.input.conversation[0]!.text = "<oai-mem-citation>Fix the project.</oai-mem-citation>";
  const evidence: RelayRoutingEvidence[] = []; let calls = 0;
  const result = await routeOwnerMessage(input, ownerTierFor({ ownerTier: true }, input)!, {
    apiKey: "fixture", signal: new AbortController().signal, authorize: () => {}, observe: row => evidence.push(row),
    fetch: (async () => { calls++; return classification(); }) as unknown as typeof fetch,
  });
  expect(result).toBeNull(); expect(calls).toBe(0);
  expect(evidence.at(-1)).toMatchObject({ path: "full", reason: "privacy", classifier: { status: "skipped", costUsd: 0 }, fast: null });
});
for (const branch of ["action", "story"] as const)
test(`the triggering ${branch} reply selects its own parent across both providers and delivery`, async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const input = request(); input.request_id = `routing_trigger_${branch}`;
  const row = input.input.conversation[0]!;
  const parent = (id: string, text: string) => ({ ...row, id, text, reply_to: null,
    author: { key: "assistant", name: "Assistant", self: true } });
  input.input.conversation = [parent("action_parent", "Which project branch should I delete? Choose Draft or Release."),
    { ...row, id: "action_reply", text: "Draft", reply_to: "action_parent" },
    parent("story_parent", "Choose a name for a story: Draft or Release."),
    { ...row, id: "story_reply", text: "Draft", reply_to: "story_parent" }];
  input.input.respond_to = `${branch}_reply`;
  const posts: unknown[] = [];
  const service = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) posts.push(body); return { body: { status: "ok" } }; });
  const relay = destinationRelay([destinationTarget("target_1", true)]);
  relay.targets[0]!.project = null; relay.origin = service.origin; relay.api_base = `${service.origin}/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] })); setRelaySwitch("chain_conversations", false);
  const recovered = spyOn(outboundContext, "resolveOwnerOutboundContext").mockResolvedValue(null);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  const inputs: unknown[] = []; let launches = 0;
  try {
    const result = await runClaimedRequest(relay, input, undefined, { leaseWorker: false,
      routing: { apiKey: "fixture", fetch: (async (url: HttpInput, init?: HttpOptions) => {
        const body = JSON.parse(String(init?.body));
        const data = JSON.parse(String(url) === DECISIONS_ENDPOINT ? body.input[0].content[1].data.input : body.input);
        inputs.push(data);
        const rows = data.conversation as { id: string; reply_to: string | null; text: string }[];
        const trigger = rows.find(row => row.id === data.respond_to);
        expect(trigger?.text).toBe("Draft");
        const parent = rows.find(row => row.id === trigger?.reply_to);
        expect(parent?.text).toContain(branch === "action" ? "delete" : "story");
        if (String(url) === DECISIONS_ENDPOINT) return classification({ ...low, action: parent!.text.includes("delete") ? 0.99 : 0.01 });
        return answer("Draft is a suitable story title.");
      }) as unknown as typeof fetch },
      ownerPorts: { launch: async () => {
        launches++; return { status: 202, body: { conversationId: `conversation_trigger_${branch}`, initialMessage: "delivered" } };
      }, observe: async () => ({ state: "ended", finalText: "**Full branch action result**" }), stop: async () => {}, pollMs: 1 },
    });
    expect(inputs).toHaveLength(branch === "action" ? 1 : 2);
    if (branch === "story") expect(inputs[0]).toEqual(inputs[1]);
    expect(launches).toBe(branch === "action" ? 1 : 0);
    expect(result).toMatchObject({ outcome: "answered", answer: {
      text: branch === "action" ? "**Full branch action result**" : "Draft is a suitable story title.", reply_to: input.input.respond_to } });
    expect(posts).toEqual([result]);
    expect(readAnswerRecord(relay.id, input.target_id, input.request_id)).toMatchObject({ delivery: "accepted", routing: {
      path: branch === "action" ? "full" : "fast", reason: branch === "action" ? "predicate" : "simple" } });
  } finally { recovered.mockRestore(); selection.mockRestore(); await service.close(); }
});
test("recovered action context dispatches the full agent and delivers its answer", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const posts: unknown[] = [];
  const service = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) posts.push(body); return { body: { status: "ok" } }; });
  const relay = destinationRelay([destinationTarget("target_1", true)]);
  relay.targets[0]!.project = null;
  relay.origin = service.origin; relay.api_base = `${service.origin}/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] })); setRelaySwitch("chain_conversations", false);
  const input = request(); input.request_id = "routing_recovered_action";
  const current = { ...input.input.conversation[0]!, text: "Draft", reply_to: "parent" };
  const parent = { ...current, id: "parent", reply_to: null, author: { key: "assistant", name: "Assistant", self: true },
    text: "Choose a name: Draft or Release." };
  input.input.conversation = [parent, current]; input.input.request_text = null;
  const context: outboundContext.OwnerOutboundContext = { resolution: "explicit_parent", questionIds: [parent.id], origins: { parent: "agent" },
    conversation: [{ ...parent, text: `${parent.text} I will delete the branch you select from the project.` }, current] };
  const recovered = spyOn(outboundContext, "resolveOwnerOutboundContext").mockResolvedValue(context);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
  let calls = 0; let launches = 0;
  try {
    const result = await runClaimedRequest(relay, input, undefined, { leaseWorker: false,
      routing: { apiKey: "fixture", fetch: (async (url: HttpInput) => {
        calls++; return String(url) === DECISIONS_ENDPOINT ? classification() : answer("Draft is a good name.");
      }) as unknown as typeof fetch },
      ownerPorts: { launch: async () => {
        launches++;
        return { status: 202, body: { conversationId: "conversation_recovered_action", initialMessage: "delivered" } };
      }, observe: async () => ({ state: "ended", finalText: "**Full action result**" }), stop: async () => {}, pollMs: 1 },
    });
    expect(recovered).toHaveBeenCalledTimes(1); expect(calls).toBe(0); expect(launches).toBe(1);
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "**Full action result**", reply_to: current.id } });
    expect(posts).toEqual([result]);
    expect(readAnswerRecord(relay.id, input.target_id, input.request_id)).toMatchObject({ routing: {
      path: "full", reason: "context_requires_agent", classifier: { status: "skipped", costUsd: 0 }, fast: null } });
  } finally { recovered.mockRestore(); selection.mockRestore(); await service.close(); }
});
test("a fetch that ignores cancellation is still bounded and routes to the agent", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const routed = await route((async () => new Promise(() => {})) as unknown as typeof fetch, { timeoutMs: 5 });
  expect(routed.evidence.reason).toBe("classifier_timeout"); expect(routed.result).toBeNull();
});
for (const phase of ["fetch", "json"] as const)
test(`a fast reply arriving after the ${phase} timeout cannot touch the fallback answer`, async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  let release!: () => void; let reads = 0;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const response = answer();
  response.json = async () => {
    if (phase === "json") await delayed;
    else reads++;
    return { get usage() { reads++; return {}; }, status: "completed", output: [] };
  };
  const routed = await route((async (url: HttpInput) => {
    if (String(url) === DECISIONS_ENDPOINT) return classification();
    if (phase === "fetch") await delayed;
    return response;
  }) as unknown as typeof fetch, { timeoutMs: 5 });
  expect(routed.evidence.reason).toBe("fast_timeout"); expect(routed.result).toBeNull();
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(reads).toBe(0);
});
test("legacy plain replies keep the same threading and character limit", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const input = request(); delete input.input.format; input.features = [];
  input.answer.max_chars = 20;
  const result = await routeOwnerMessage(input, ownerTierFor({ ownerTier: true }, input)!, {
    apiKey: "fixture", signal: new AbortController().signal, authorize: () => {}, observe: () => {},
    fetch: (async (url: HttpInput) => String(url) === DECISIONS_ENDPOINT ? classification() : answer("a".repeat(25))) as unknown as typeof fetch,
  });
  expect(result).toEqual({ action: "reply", text: "a".repeat(19) + "…", reply_to: "m1" });
});
test("a late classifier cannot consume the fast-answer budget after the service window closes", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const input = request(); let calls = 0;
  const evidence: RelayRoutingEvidence[] = [];
  const result = await routeOwnerMessage(input, ownerTierFor({ ownerTier: true }, input)!, {
    apiKey: "fixture", signal: new AbortController().signal, deadlineAt: epoch + 2_000, authorize: () => {}, observe: row => evidence.push(row),
    fetch: (async () => { calls++; setSystemTime(epoch + 2_000); return classification(); }) as unknown as typeof fetch,
  });
  expect(result).toBeNull(); expect(calls).toBe(1); expect(evidence.at(-1)?.reason).toBe("service_window");
});
test("paid routing requires explicit opt-in and the off switch makes no API call", async () => {
  delete process.env.LLV_RELAY_ROUTING;
  expect(routingEnabled()).toBe(false);
  process.env.LLV_RELAY_ROUTING = "0";
  const routed = await route((async () => { throw Error("unexpected API call"); }) as unknown as typeof fetch);
  expect(routed.result).toBeNull();
  expect(routed.evidence).toMatchObject({ path: "full", reason: "disabled", classifier: { costUsd: 0, status: "skipped" }, fast: null });
});
for (const predicate of ["machine", "action", "reasoning"] as const) {
  for (const offset of [0, 0.001]) test(`${predicate} at or above its threshold takes the full path (${offset})`, async () => {
    process.env.LLV_RELAY_ROUTING = "1";
    let calls = 0;
    const scores = { ...low, [predicate]: ROUTING_THRESHOLDS[predicate] + offset };
    const routed = await route((async () => { calls++; return classification(scores); }) as unknown as typeof fetch);
    expect(routed.result).toBeNull(); expect(calls).toBe(1);
    expect(routed.evidence).toMatchObject({ path: "full", reason: "predicate", scores, fast: null });
    expect(routed.evidence.classifier.costUsd).toBeCloseTo(0.000082, 12);
  });
}
test("scores below every threshold use Terra low with no tools and retain unknown pricing", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const scores = Object.fromEntries(Object.entries(ROUTING_THRESHOLDS).map(([name, value]) => [name, value - 0.001])) as typeof low;
  const bodies: Record<string, unknown>[] = [];
  const routed = await route((async (url: HttpInput, init?: HttpOptions) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    expect(init?.redirect).toBe("error");
    if (String(url) === DECISIONS_ENDPOINT) return classification(scores);
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(body).toMatchObject({ model: "gpt-6.1-terra", reasoning: { effort: "low" }, tools: [], store: false, service_tier: "default" });
    return answer();
  }) as unknown as typeof fetch);
  expect(bodies).toHaveLength(2);
  expect(routed.result).toMatchObject({ action: "reply", text: "**Hello**", reply_to: "m1", format: "rich_markdown" });
  expect(routed.evidence).toMatchObject({ path: "fast", reason: "simple", scores,
    fast: { model: "gpt-6.1-terra", status: "completed", costUsd: null, tokens: { input: 100, output: 20 } } });
});
for (const failure of ["network", "http", "shape", "timeout", "credentials"] as const)
  test(`classifier ${failure} falls back without a fast request`, async () => {
    process.env.LLV_RELAY_ROUTING = "1";
    let calls = 0;
    const routed = await route((async (_url: HttpInput, init?: HttpOptions) => {
      calls++;
      if (failure === "timeout") return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("aborted"))));
      if (failure === "http") return new Response("", { status: 503 });
      if (failure === "shape") return Response.json({ answers: [] });
      throw Error("private upstream text");
    }) as unknown as typeof fetch, { timeoutMs: 10, ...(failure === "credentials" ? { apiKey: null } : {}) });
    expect(routed.result).toBeNull(); expect(calls).toBe(failure === "credentials" ? 0 : 1);
    expect(routed.evidence.path).toBe("full"); expect(routed.evidence.fast).toBeNull();
    expect(JSON.stringify(routed.evidence)).not.toContain("private upstream text");
    expect(routed.evidence.reason).toBe(failure === "credentials" ? "credentials" : `classifier_${failure}`);
  });
for (const failure of ["http", "shape", "incomplete", "empty", "tool", "timeout"] as const)
  test(`fast ${failure} falls back with classifier cost retained`, async () => {
    process.env.LLV_RELAY_ROUTING = "1";
    const routed = await route((async (url: HttpInput, init?: HttpOptions) => {
      if (String(url) === DECISIONS_ENDPOINT) return classification();
      if (failure === "timeout") return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("aborted"))));
      if (failure === "http") return new Response("", { status: 503 });
      if (failure === "empty") return answer(" ");
      if (failure === "shape") return Response.json({ output: "bad" });
      if (failure === "tool") return Response.json({ status: "completed", output: [{ type: "function_call", name: "run_command" }] });
      return Response.json({ status: "incomplete", output: [] });
    }) as unknown as typeof fetch, { timeoutMs: 10 });
    expect(routed.result).toBeNull(); expect(routed.evidence.path).toBe("full");
    expect(routed.evidence.reason).toStartWith("fast_");
    expect(routed.evidence.classifier.costUsd).toBeGreaterThan(0);
  });
test("authority is checked again after classification and after the fast reply", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  for (const revokeAt of ["classifier", "fast"]) {
    let valid = true; let calls = 0;
    await expect(route((async (url: HttpInput) => {
      calls++;
      if (String(url) === DECISIONS_ENDPOINT) { if (revokeAt === "classifier") valid = false; return classification(); }
      valid = false; return answer();
    }) as unknown as typeof fetch, { authorize: () => { if (!valid) throw Error("revoked"); } })).rejects.toThrow("revoked");
    expect(calls).toBe(revokeAt === "classifier" ? 1 : 2);
  }
});
for (const leaseWorker of [false, true])
test(`fast runner uses normal completion, persists evidence, and needs no subscription account (worker=${leaseWorker})`, async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const posts: unknown[] = [];
  const service = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) posts.push(body); return { body: { status: "ok" } }; });
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "exhausted", resetsAt: null });
  // The child has a real clock. This success case gives its delivery a fixed
  // open bound; deadline behavior is exercised with the frozen inline clock.
  const originalComplete = RelayLeaseTransport.prototype.complete;
  const completion = leaseWorker ? spyOn(RelayLeaseTransport.prototype, "complete").mockImplementation(function (this: RelayLeaseTransport, body, _until, plainMax, owner) {
    return originalComplete.call(this, body, Number.MAX_SAFE_INTEGER, plainMax, owner);
  }) : null;
  const relay = destinationRelay([destinationTarget("target_1", true)]);
  relay.origin = service.origin; relay.api_base = `${service.origin}/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] })); setRelaySwitch("chain_conversations", false);
  let launches = 0;
  try {
    const input = request(); input.request_id = `routing_fast_${leaseWorker}`;
    const result = await runClaimedRequest(relay, input, undefined, { leaseWorker,
      routing: { apiKey: "fixture", fetch: (async (url: HttpInput) => String(url) === DECISIONS_ENDPOINT ? classification() : answer()) as unknown as typeof fetch },
      ownerPorts: { launch: async () => { launches++; throw Error("unexpected agent launch"); },
        observe: async () => ({ state: "ended", finalText: "Unused" }), stop: async () => {} } });
    expect(result).toMatchObject({ outcome: "answered", answer: { text: "**Hello**", reply_to: "m1", format: "rich_markdown" } });
    expect(posts).toEqual([result]); expect(launches).toBe(0);
    expect(readRunLedger().runs.some(row => row.requestId === input.request_id)).toBe(false);
    expect(readAnswerRecord(relay.id, input.target_id, input.request_id)).toMatchObject({
      engine: "openai", model: "gpt-6.1-terra", delivery: "accepted", routing: { path: "fast", scores: low, classifier: { costUsd: 0.000082 }, fast: { costUsd: null } } });
  } finally { completion?.mockRestore(); selection.mockRestore(); await service.close(); }
});
for (const mode of ["machine", "action", "reasoning", "classifier_error", "classifier_timeout", "fast_error", "off"] as const)
  test(`runner really launches its existing owner agent for ${mode}`, async () => {
    process.env.LLV_RELAY_ROUTING = mode === "off" ? "0" : "1";
    const posts: unknown[] = [];
    const service = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) posts.push(body); return { body: { status: "ok" } }; });
    const relay = destinationRelay([destinationTarget("target_1", true)]);
    relay.targets[0]!.project = null;
    relay.origin = service.origin; relay.api_base = `${service.origin}/v1`;
    updateRelayStore(store => ({ ...store, relays: [relay] })); setRelaySwitch("chain_conversations", false);
    const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
      engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env } } });
    const input = request(); input.request_id = `routing_${mode}`;
    let launches = 0; let calls = 0;
    try {
      const result = await runClaimedRequest(relay, input, undefined, { leaseWorker: false,
        routing: { apiKey: "fixture", timeoutMs: 10, fetch: (async (url: HttpInput) => {
          calls++;
          if (mode === "classifier_error") throw Error("upstream failure");
          if (mode === "classifier_timeout") return new Promise(() => {});
          if (String(url) !== DECISIONS_ENDPOINT) return new Response("", { status: 503 });
          return classification(mode === "fast_error" ? low : { ...low, [mode]: 0.9 });
        }) as unknown as typeof fetch },
        ownerPorts: { launch: async () => { launches++; return { status: 202, body: { conversationId: `conversation_routing_${mode}`, initialMessage: "delivered" } }; },
          observe: async () => ({ state: "ended", finalText: "**Full answer**" }), stop: async () => {}, pollMs: 1 },
      });
      expect(launches).toBe(1); expect(calls).toBe(mode === "off" ? 0 : mode === "fast_error" ? 2 : 1);
      expect(result).toMatchObject({ outcome: "answered", answer: { text: "**Full answer**", reply_to: "m1" } });
      expect(posts).toEqual([result]);
      expect(readAnswerRecord(relay.id, input.target_id, input.request_id)).toMatchObject({ routing: { path: "full" } });
    } finally { selection.mockRestore(); await service.close(); }
  });
test("replacing persisted request custody during classification preserves the successor's record and delivery", async () => {
  process.env.LLV_RELAY_ROUTING = "1";
  const completions: unknown[] = [];
  const service = await startTestRelay((req, body) => { if (req.url?.endsWith("/complete")) completions.push(body); return { body: { status: "ok" } }; });
  const relay = destinationRelay([destinationTarget("target_1", true)]);
  relay.origin = service.origin; relay.api_base = `${service.origin}/v1`;
  updateRelayStore(store => ({ ...store, relays: [relay] })); setRelaySwitch("chain_conversations", false);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "exhausted", resetsAt: null });
  try {
    const input = request(); input.request_id = "routing_replaced"; let calls = 0;
    const result = await runClaimedRequest(relay, input, undefined, { leaseWorker: false, routing: { apiKey: "fixture", fetch: (async () => {
      calls++; changeRun(input.request_id, row => ({ ...row, ownerIdentity: "replacement" })); return classification();
    }) as unknown as typeof fetch } });
    expect(calls).toBe(1); expect(result).toBeNull(); expect(completions).toEqual([]);
    expect(readRunLedger().runs.find(row => row.requestId === input.request_id)?.ownerIdentity).toBe("replacement");
  } finally { dropRun("routing_replaced"); selection.mockRestore(); await service.close(); }
});
