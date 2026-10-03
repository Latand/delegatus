import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { memoryIndex } from "./service";
import { setSharedMemoryEnabled } from "./settings";
import { offerForHook as prepareForHook } from "./controller";
import { memoryHookSource } from "./hook";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { writeAsksYouSettings } from "@/lib/asks/settings";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { readOperatorAsks } from "@/lib/asks/store";
import { deliverConversationMessage } from "@/lib/delivery";
import { offeredMemoryForTranscript } from "./offers";
import { createFeedSession } from "@/components/feed/parse";
import { provenanceLookupFor } from "@/components/feed/messageProvenance";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { FileEntry } from "@/lib/types";
import type { groundedRequest } from "./selection";

const previous = { ...process.env };
const originalFetch = globalThis.fetch;
const roots: string[] = [];
async function offerForHook(request: Request, input: Record<string, unknown>) {
  const headers = new Headers(request.headers);
  headers.set("x-llv-memory-deadline", String(Date.now() + 1500));
  headers.set("x-llv-memory-hook", crypto.randomUUID());
  const admitted = new Request(request.url, { headers });
  const block = await prepareForHook(admitted, input);
  if (block) await prepareForHook(admitted, { delegatus_confirm: true, delegatus_emitted_at: Date.now() });
  return block;
}
afterEach(() => {
  memoryIndex().close(); setAgentRegistryForTests(null); globalThis.fetch = originalFetch;
  for (const key of ["LLV_STATE_DIR", "OPENROUTER_API_KEY", "PORT"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

for (const mode of ["delayed input", "delayed body", "delayed confirmation", "unconfirmed", "successful"] as const) test(`actual hook/controller ${mode} accounts only successfully emitted output`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-output-boundary-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT; process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" }); setAgentRegistryForTests(registry);
  const receipt = registry.beginSpawn("codex", root, { cwd: root, title: "Synthetic boundary conversation" });
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  const project = projectInfoFromCwd(root)!.project; setSharedMemoryEnabled(project, true);
  const source = path.join(root, "cross.md");
  fs.writeFileSync(source, "---\nname: Widget parser\ndescription: Widget parser requires escaped delimiters.\nmetadata:\n  type: project\n---\nUse escaped delimiters.\n");
  await memoryIndex().refresh([{ path: source, engine: "claude", sourceKind: "claude_memory", project }]);
  globalThis.fetch = (async () => {
    if (mode === "delayed input") await Bun.sleep(1100);
    if (mode === "delayed confirmation") await Bun.sleep(1050);
    const id = memoryIndex().injectionCandidates("widget parser", project, "codex", receipt.conversationId)[0].id;
    return Response.json({ answers: { [id]: { noul: .8 } }, usage: { cost: .0001 } });
  }) as unknown as typeof fetch;
  let finished: Promise<string> = Promise.resolve("");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const input = await request.json();
    finished = (async () => {
      if (mode === "delayed confirmation" && input.delegatus_confirm) await Bun.sleep(650);
      return prepareForHook(request, input);
    })();
    const block = await finished;
    if (mode === "delayed body" && block) return new Response(new ReadableStream({ async start(c) {
      await Bun.sleep(1650); c.enqueue(new TextEncoder().encode(JSON.stringify({ block }))); c.close();
    } }));
    return Response.json({ block });
  } });
  const prompt = encodeCodexStructuredUserText("Update widget parser", undefined, null, { kind: "operator" }, crypto.createHash("sha256").update("output-boundary").digest("hex"));
  const session = crypto.randomUUID(), transcript = path.join(root, session + ".jsonl");
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt };
  try {
    if (mode === "unconfirmed") {
      await prepareForHook(new Request("http://localhost", { headers: { "x-llv-spawn-capability": capability, "x-llv-memory-hook": crypto.randomUUID(), "x-llv-memory-deadline": String(Date.now() + 1500) } }), input);
    } else {
      const proc = Bun.spawn(["bun", "-e", memoryHookSource(`http://127.0.0.1:${server.port}`)], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_SPAWN_CAPABILITY: capability } });
      try {
        if (mode === "delayed input") await Bun.sleep(600);
        proc.stdin.write(JSON.stringify(input)); proc.stdin.end();
        expect(await proc.exited).toBe(0);
        expect((await new Response(proc.stdout).text()).length > 0).toBe((mode === "successful" || mode === "delayed confirmation"));
        await finished;
      } finally { proc.kill(); await proc.exited; }
    }
    expect(memoryIndex().turnOffers(receipt.conversationId).length).toBe((mode === "successful" || mode === "delayed confirmation") ? 1 : 0);
    memoryIndex().close();
    const reloaded = memoryIndex().turnOffers(receipt.conversationId);
    if (mode === "successful" || mode === "delayed confirmation") {
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]).toMatchObject({ title: "Widget parser", score: .8 });
      fs.writeFileSync(transcript, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }) + "\n");
      registry.settleSpawn(receipt.launchId, { key: { engine: "codex", sessionId: session }, artifactPath: transcript, cwd: root,
        accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
      const offers = offeredMemoryForTranscript(transcript);
      expect(offers[reloaded[0].requestId]).toEqual(["Widget parser"]);
      const feed = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
      const entries = feed.feed(fs.readFileSync(transcript, "utf8").trim().split("\n"), 0, false).items;
      const lookup = provenanceLookupFor({ memoryOffers: offers }, entries.map(entry => entry.item));
      expect(lookup.memoryFor!(entries.find(entry => entry.item.kind === "user")!.item)).toEqual(["Widget parser"]);
    }
    expect(memoryIndex().injectionCandidates("widget parser", project, "codex", receipt.conversationId).length).toBe((mode === "successful" || mode === "delayed confirmation") ? 0 : 1);
  } finally { server.stop(true); }
}, 5000);

for (const engine of ["claude", "codex"] as const) for (const prompt of ["Proceed", "Так"]) {
  test(`${engine} short follow-up ${prompt} recalls preceding task terms and keeps the Jev prompt unchanged`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-controller-followup-")); roots.push(root);
    process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT;
    process.env.OPENROUTER_API_KEY = "fixture";
    const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    setAgentRegistryForTests(registry);
    const receipt = registry.beginSpawn(engine, root, { cwd: root, title: "Synthetic hook conversation" });
    const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
    const project = projectInfoFromCwd(root)!.project; setSharedMemoryEnabled(project, true);
    const session = crypto.randomUUID(), transcript = path.join(root, session + ".jsonl");
    const opening = "Review calendar scheduling timezone reminders meetings invitations attendees availability recurrence notifications holidays weekends appointments agenda events appointments scheduling";
    const priorTask = "Update the widget parser";
    const turns = [{ role: "user", text: opening }, { role: "user", text: priorTask }, { role: "assistant", text: "I can update it." }];
    fs.writeFileSync(transcript, turns.map(turn => JSON.stringify(engine === "claude"
      ? { type: turn.role, uuid: crypto.randomUUID(), message: { role: turn.role, content: [{ type: "text", text: turn.text }] } }
      : { type: "response_item", payload: { type: "message", role: turn.role, content: [{ type: turn.role === "user" ? "input_text" : "output_text", text: turn.text }] } }
    )).join("\n") + "\n");
    expect(registry.settleSpawn(receipt.launchId, {
      key: { engine, sessionId: session }, artifactPath: transcript, cwd: root, accountId: null,
      status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    }).kind).toBe("settled");
    const source = path.join(root, "memory.md");
    fs.writeFileSync(source, engine === "claude"
      ? "v1\n## User preferences\n- Widget parser uses escaped delimiters for every record.\n"
      : "---\nname: Widget parser\ndescription: Widget parser records use escaped delimiters.\nmetadata:\n  type: user\n---\nApply escaped delimiters to the widget parser.\n");
    await memoryIndex().refresh([{ path: source, engine: engine === "claude" ? "codex" : "claude", sourceKind: engine === "claude" ? "codex_summary" : "claude_memory", project }]);
    const deliveryId = crypto.randomUUID();
    const wirePrompt = engine === "codex"
      ? encodeCodexStructuredUserText(prompt, undefined, null, { kind: "operator" }, crypto.createHash("sha256").update(deliveryId).digest("hex"))
      : prompt;
    if (engine === "claude") new FileClaudeDeliveryLedger().recordQueued(session, { id: deliveryId, text: prompt, origin: { kind: "operator" } }, "queued-next-turn");
    let calls = 0;
    let jevRequest: ReturnType<typeof groundedRequest> | undefined;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      jevRequest = body;
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: .8 }])), usage: { cost: .0001 } });
    }) as typeof fetch;
    const request = new Request("http://localhost/api/memory/inject", { headers: { "x-llv-spawn-capability": capability } });
    const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt: wirePrompt, ...(engine === "claude" ? { delegatus_delivery_id: deliveryId } : {}) };
    const block = await offerForHook(request, input);
    expect(calls).toBe(1);
    expect(jevRequest!.state.latestOperatorMessage).toBe(prompt);
    expect(jevRequest!.state.openingRequest).toBe(opening);
    expect(jevRequest!.state.precedingTurns).toContain("user: " + priorTask);
    expect(jevRequest!.state.receivingEngine).toBe(engine);
    expect(Object.values(jevRequest!.questions)).toHaveLength(1);
    expect(Object.values(jevRequest!.questions)[0].instructions.proposedOffer.summary).toContain("escaped delimiters");
    expect(block).toContain("Widget parser");
    expect(memoryIndex().turnOffers(receipt.conversationId)).toMatchObject([{ score: .8 }]);
    expect(input.prompt).toBe(wirePrompt);
  });
}

test("real controller joins queued operator authorship, calls grounded Jev once, charges shared cap and records offers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-controller-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT;
  process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const receipt = registry.beginSpawn("claude", root, { cwd: root, title: "Synthetic hook conversation" });
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  expect(registry.conversationIdForSpawnCapabilityDigest(crypto.createHash("sha256").update(capability).digest("hex"))).toBe(receipt.conversationId);
  // A first hook runs before transcript materialization creates its conversation.
  const project = projectInfoFromCwd(root)!.project;
  setSharedMemoryEnabled(project, true);
  const source = path.join(root, "memory.md");
  fs.writeFileSync(source, "v1\n## User preferences\n- Widget parser uses escaped delimiters for every record.\n");
  await memoryIndex().refresh([{ path: source, engine: "codex", sourceKind: "codex_summary" }]);
  const session = crypto.randomUUID();
  const prompt = "Update the widget parser to handle delimiters";
  const ledger = new FileClaudeDeliveryLedger();
  ledger.recordQueued(session, { id: "machine", text: prompt, origin: { kind: "agent" } }, "turn-started");
  ledger.recordQueued(session, { id: "operator", text: prompt, origin: { kind: "operator" } }, "queued-next-turn");
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    expect(request.state.latestOperatorMessage).toBe(prompt);
    expect(request.state.receivingEngine).toBe("claude");
    expect(Object.values(request.questions)[0]).toHaveProperty("instructions.supportingBodyExcerpt");
    return Response.json({ answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { noul: .8 }])), usage: { cost: .0001 } });
  }) as typeof fetch;
  const request = new Request("http://localhost/api/memory/inject", { headers: { "x-llv-spawn-capability": capability } });
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt };
  setSharedMemoryEnabled(project, false);
  expect(await offerForHook(request, { ...input, delegatus_delivery_id: "operator" })).toBe("");
  setSharedMemoryEnabled(project, true);
  expect(await offerForHook(request, { ...input, delegatus_delivery_id: "machine" })).toBe(""); expect(calls).toBe(0);
  expect(await offerForHook(request, { ...input, delegatus_delivery_id: "operator" })).toContain("Delegatus shared memory");
  expect(calls).toBe(1);
  expect(memoryIndex().turnOffers(receipt.conversationId)).toMatchObject([{ requestId: "operator", score: .8 }]);
  expect(readOperatorAsks().spend.usd).toBeCloseTo(.0001, 8);
  expect(await offerForHook(request, { ...input, delegatus_delivery_id: "operator" })).toBe(""); expect(calls).toBe(1);
  writeAsksYouSettings({ capUsd: 0 });
  ledger.recordQueued(session, { id: "capped", text: prompt + " again", origin: { kind: "operator" } }, "queued-next-turn");
  expect(await offerForHook(request, { ...input, prompt: prompt + " again", delegatus_delivery_id: "capped" })).toBe(""); expect(calls).toBe(1);
});

test("Codex hook resolves durable authorship and abstains on machine and unknown deliveries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-controller-codex-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT;
  process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const receipt = registry.beginSpawn("codex", root, { cwd: root, title: "Synthetic hook conversation" });
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  const project = projectInfoFromCwd(root)!.project; setSharedMemoryEnabled(project, true);
  const source = path.join(root, "memory.md");
  fs.writeFileSync(source, "---\nname: Widget parser\ndescription: Widget parser records use escaped delimiters.\nmetadata:\n  type: user\n---\nApply escaped delimiters to the widget parser.\n");
  await memoryIndex().refresh([{ path: source, engine: "claude", sourceKind: "claude_memory", project }]);
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    expect(body.state.receivingEngine).toBe("codex");
    expect(body.state.latestOperatorMessage).toBe("Update widget parser");
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: .8 }])), usage: { cost: .0001 } });
  }) as typeof fetch;
  const request = new Request("http://localhost/api/memory/inject", { headers: { "x-llv-spawn-capability": capability } });
  const input = { hook_event_name: "UserPromptSubmit", session_id: crypto.randomUUID(), cwd: root };
  expect(await offerForHook(request, { ...input, prompt: "Update widget parser" })).toBe("");
  const wire = (kind: "agent" | "operator", id: string) => encodeCodexStructuredUserText("Update widget parser", undefined, null, { kind }, crypto.createHash("sha256").update(id).digest("hex"));
  expect(await offerForHook(request, { ...input, prompt: wire("agent", "machine") })).toBe(""); expect(calls).toBe(0);
  expect(await offerForHook(request, { ...input, prompt: wire("operator", "operator") })).toContain("Delegatus shared memory");
  expect(calls).toBe(1);
  expect(memoryIndex().turnOffers(receipt.conversationId)).toMatchObject([{ score: .8 }]);
  expect(await offerForHook(request, { ...input, prompt: wire("operator", "operator") })).toBe(""); expect(calls).toBe(1);
});

for (const engine of ["claude", "codex"] as const) for (const mode of ["followup", "relay"] as const) test(`${engine} native tmux ${mode} deliveries abstain while identical typed operator occurrences receive memory`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-terminal-authorship-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT;
  process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const begun = registry.beginSpawnRequest({ engine, cwd: root, transport: "tmux", launchProfile: emptyLaunchProfile({ cwd: root, title: "Synthetic terminal conversation" }) });
  if (begun.kind !== "created") throw new Error("Synthetic terminal launch refused");
  const receipt = begun.receipt;
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  const project = projectInfoFromCwd(root)!.project; setSharedMemoryEnabled(project, true);
  const session = crypto.randomUUID(), transcript = path.join(root, session + ".jsonl");
  const prompt = "Update widget parser";
  fs.writeFileSync(transcript, JSON.stringify(engine === "claude"
    ? { type: "user", message: { role: "user", content: "Earlier synthetic task" } }
    : { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier synthetic task" }] } }) + "\n");
  registry.settleSpawn(receipt.launchId, { key: { engine, sessionId: session }, artifactPath: transcript, cwd: root,
    accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  const source = path.join(root, "cross.md");
  fs.writeFileSync(source, engine === "claude"
    ? "v1\n## User preferences\n- Widget parser uses escaped delimiters.\n"
    : "---\nname: Widget parser\ndescription: Widget parser uses escaped delimiters.\nmetadata:\n  type: project\n---\nUse escaped delimiters.\n");
  await memoryIndex().refresh([{ path: source, engine: engine === "claude" ? "codex" : "claude",
    sourceKind: engine === "claude" ? "codex_summary" : "claude_memory", project }]);
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: .8 }])), usage: { cost: .0001 } });
  }) as typeof fetch;
  const request = new Request("http://localhost/api/memory/inject", { headers: { "x-llv-spawn-capability": capability } });
  let wire = "";
  const child = path.join(root, "synthetic-child.jsonl");
  if (mode === "relay") { fs.writeFileSync(child, ""); registry.ensureConversation(engine, child, "default"); }
  const entry = { path: transcript, root, engine, title: "Synthetic terminal" } as FileEntry;
  const childEntry = { ...entry, path: child, parent: transcript };
  const result = await deliverConversationMessage({ path: mode === "relay" ? child : transcript, pid: process.pid, text: prompt, images: [],
    origin: { kind: mode === "relay" ? "operator" : "agent" } }, { recover: async () => null, targetForKnownPid: async () => "%synthetic",
    pathAllowed: () => true, listFiles: async () => mode === "relay" ? [entry, childEntry] : [entry],
    resumeSpecFor: (_root, pathname) => mode === "relay" && pathname === child ? null : ({ command: "synthetic", engine, cwd: root, transcript, windowName: "synthetic", launchProfile: emptyLaunchProfile({ cwd: root }) }),
    deliver: async ({ payload }) => { wire = payload; return { ok: true, target: "%synthetic", outcome: "resumed" }; } });
  expect(result.ok).toBe(true);
  // Another submission queued before actuation can journal after this receipt.
  fs.appendFileSync(transcript, JSON.stringify(engine === "claude"
    ? { type: "user", uuid: "synthetic-earlier", message: { role: "user", content: "Earlier queued input" } }
    : { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier queued input" }] } }) + "\n");
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root,
    prompt_id: "synthetic-machine", turn_id: "synthetic-machine", prompt: wire };
  expect(await offerForHook(request, input)).toBe("");
  expect(calls).toBe(0);
  expect(memoryIndex().turnOffers(receipt.conversationId)).toEqual([]);
  expect(await offerForHook(request, { ...input, prompt: wire, prompt_id: "synthetic-typed", turn_id: "synthetic-typed" })).toContain("Delegatus shared memory");
  expect(calls).toBe(1);
  const userLine = (ts: string) => JSON.stringify(engine === "claude"
    ? { type: "user", uuid: crypto.randomUUID(), timestamp: ts, message: { role: "user", content: wire } }
    : { type: "response_item", timestamp: ts, payload: { type: "message", role: "user", content: [{ type: "input_text", text: wire }] } });
  const offeredLine = userLine("2026-10-02T12:00:01.000Z"), repeatedLine = userLine("2026-10-02T12:00:03.000Z");
  fs.appendFileSync(transcript, offeredLine + "\n" + repeatedLine + "\n");
  memoryIndex().close(); // Reload every persisted join, as the conversation does.
  const offers = offeredMemoryForTranscript(transcript);
  const offeredKey = `native:${messageTextDigest(offeredLine)}`;
  expect(offers[offeredKey]?.length).toBe(1);
  const sessionFeed = createFeedSession({ engine, fmt: engine, showSvc: false, lineFilter: "" });
  const entries = sessionFeed.feed([offeredLine, repeatedLine], 0, false).items;
  const lookup = provenanceLookupFor({ memoryOffers: offers }, entries.map(entry => entry.item));
  const users = entries.filter(entry => entry.item.kind === "user");
  expect(lookup.memoryFor!(users[0].item)).toEqual(offers[offeredKey]);
  expect(lookup.memoryFor!(users[1].item)).toEqual([]);
});


for (const engine of ["claude", "codex"] as const) for (const materialization of ["present", "pending", "unknown path"] as const) for (const origin of ["operator", "agent"] as const) test(`${engine} receipt-only native launch ${materialization} keeps ${origin} authorship and deferred offer names`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-native-launch-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT; process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" }); setAgentRegistryForTests(registry);
  const session = crypto.randomUUID(), transcript = path.join(root, session + ".jsonl"), prompt = "Update widget parser";
  const begun = registry.beginSpawnRequest({ engine, cwd: root, transport: "tmux", expectedArtifactPath: materialization === "unknown path" ? undefined : transcript,
    launchDisplay: { prompt, images: 0, echo: prompt }, launchProfile: emptyLaunchProfile({ cwd: root, title: "Synthetic native launch" }) });
  if (begun.kind !== "created") throw Error("Synthetic launch refused");
  const receipt = begun.receipt, capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  expect(registry.readOnlySnapshot().conversations[receipt.conversationId]).toBeUndefined();
  if (materialization === "present") fs.writeFileSync(transcript, "");
  memoryIndex().recordTerminalDelivery(`spawn:${receipt.launchId}`, receipt.conversationId, prompt, origin, materialization === "unknown path" ? null : transcript);
  const project = projectInfoFromCwd(root)!.project; setSharedMemoryEnabled(project, true);
  const source = path.join(root, "cross.md");
  fs.writeFileSync(source, engine === "claude" ? "v1\n## User preferences\n- Widget parser uses escaped delimiters.\n"
    : "---\nname: Widget parser\ndescription: Widget parser uses escaped delimiters.\nmetadata:\n  type: project\n---\nUse escaped delimiters.\n");
  await memoryIndex().refresh([{ path: source, engine: engine === "claude" ? "codex" : "claude", sourceKind: engine === "claude" ? "codex_summary" : "claude_memory", project }]);
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: .8 }])), usage: { cost: .0001 } });
  }) as typeof fetch;
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt, prompt_id: "synthetic-initial", turn_id: "synthetic-initial" };
  const request = new Request("http://localhost/api/memory/inject", { headers: { "x-llv-spawn-capability": capability } });
  const block = await offerForHook(request, input);
  expect(Boolean(block)).toBe(origin === "operator");
  expect(calls).toBe(origin === "operator" ? 1 : 0);
  const line = JSON.stringify(engine === "claude" ? { type: "user", uuid: "synthetic-initial", message: { role: "user", content: prompt } }
    : { type: "response_item", payload: { type: "message", turn_id: "synthetic-initial", role: "user", content: [{ type: "input_text", text: prompt }] } });
  fs.writeFileSync(transcript, line + "\n");
  registry.settleSpawn(receipt.launchId, { key: { engine, sessionId: session }, artifactPath: transcript, cwd: root,
    accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  memoryIndex().close();
  const offers = offeredMemoryForTranscript(transcript);
  expect(offers[`native:${messageTextDigest(line)}`]?.length ?? 0).toBe(origin === "operator" ? 1 : 0);
});
