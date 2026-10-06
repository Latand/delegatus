import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { memoryIndex } from "./service";
import { setSharedMemoryEnabled } from "./settings";
import { offerForHook as prepareForHook } from "./controller";
import { memoryHookSource } from "./hook";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { writeAsksYouSettings } from "@/lib/asks/settings";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { localRepositoryProjectId, directoryProjectId } from "@/lib/projects/identity";
import { readOperatorAsks } from "@/lib/asks/store";
import { deliverConversationMessage } from "@/lib/delivery";
import { offeredMemoryForTranscript } from "./offers";
import { createFeedSession } from "@/components/feed/parse";
import { provenanceLookupFor } from "@/components/feed/messageProvenance";
import { structuredContent } from "@/lib/runtime/structuredContent";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";
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

for (const mode of ["delayed input", "delayed body", "delayed confirmation", "contended confirmation", "restarted confirmation", "unconfirmed", "successful"] as const) test(`actual hook/controller ${mode} accounts only successfully emitted output`, async () => {
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
    const id = (await memoryIndex().injectionCandidates("widget parser", project, "codex", receipt.conversationId))[0].id;
    return Response.json({ answers: { [id]: { noul: .8 } }, usage: { cost: .0001 } });
  }) as unknown as typeof fetch;
  let finished: Promise<string> = Promise.resolve("");
  const confirmationLock: { db: Database | null } = { db: null };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const input = await request.json();
    finished = (async () => {
      if (mode === "delayed confirmation" && input.delegatus_confirm) await Bun.sleep(650);
      if (mode === "contended confirmation" && input.delegatus_confirm) {
        confirmationLock.db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
        confirmationLock.db.exec("BEGIN IMMEDIATE");
      }
      if (mode === "restarted confirmation" && input.delegatus_confirm) {
        // The confirming process has no module-local state from preparation.
        const source = `import { AgentRegistry, setAgentRegistryForTests } from ${JSON.stringify(path.resolve(import.meta.dir, "../agent/registry.ts"))};
          import { offerForHook } from ${JSON.stringify(path.resolve(import.meta.dir, "controller.ts"))};
          setAgentRegistryForTests(new AgentRegistry(${JSON.stringify(path.join(root, "registry.json"))}, undefined, undefined, { sqliteMode: "off" }));
          await offerForHook(new Request("http://localhost/api/memory/inject", { headers: ${JSON.stringify(Object.fromEntries(request.headers))} }), ${JSON.stringify(input)});`;
        const confirmer = Bun.spawn(["bun", "--eval", source], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
        expect(await confirmer.exited).toBe(0);
        expect(await new Response(confirmer.stderr).text()).toBe("");
        memoryIndex().close();
        return "";
      }
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
        expect((await new Response(proc.stdout).text()).length > 0).toBe((mode === "successful" || mode === "delayed confirmation" || mode === "contended confirmation" || mode === "restarted confirmation"));
        await finished;
        confirmationLock.db?.exec("ROLLBACK"); confirmationLock.db?.close(); confirmationLock.db = null;
      } finally { proc.kill(); await proc.exited; }
    }
    memoryIndex().close();
    expect(memoryIndex().turnOffers(receipt.conversationId).length).toBe((mode === "successful" || mode === "delayed confirmation" || mode === "contended confirmation" || mode === "restarted confirmation") ? 1 : 0);
    const reloaded = memoryIndex().turnOffers(receipt.conversationId);
    if (mode === "successful" || mode === "delayed confirmation" || mode === "contended confirmation" || mode === "restarted confirmation") {
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
    expect((await memoryIndex().injectionCandidates("widget parser", project, "codex", receipt.conversationId)).length).toBe((mode === "successful" || mode === "delayed confirmation" || mode === "contended confirmation" || mode === "restarted confirmation") ? 0 : 1);
  } finally { confirmationLock.db?.exec("ROLLBACK"); confirmationLock.db?.close(); server.stop(true); }
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
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt, source: "sdk" };
  setSharedMemoryEnabled(project, false);
  expect(await offerForHook(request, { ...input, delegatus_delivery_id: "operator" })).toBe("");
  setSharedMemoryEnabled(project, true);
  const skipped = memoryIndex().injectionActivity().skipped;
  expect(await offerForHook(request, { ...input, delegatus_delivery_id: "machine" })).toBe(""); expect(calls).toBe(0);
  expect(memoryIndex().injectionActivity().skipped).toBe(skipped);
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
  const skipped = memoryIndex().injectionActivity().skipped;
  expect(await offerForHook(request, { ...input, prompt: wire("agent", "machine") })).toBe(""); expect(calls).toBe(0);
  expect(memoryIndex().injectionActivity().skipped).toBe(skipped);
  expect(await offerForHook(request, { ...input, prompt: wire("operator", "operator") })).toContain("Delegatus shared memory");
  expect(calls).toBe(1);
  expect(memoryIndex().turnOffers(receipt.conversationId)).toMatchObject([{ score: .8 }]);
  expect(await offerForHook(request, { ...input, prompt: wire("operator", "operator") })).toBe(""); expect(calls).toBe(1);
});

for (const engine of ["claude", "codex"] as const) for (const mode of ["followup", "relay"] as const) for (const contended of [false, true]) for (const queued of ["different", "identical", "unowned", "racing before journal", "racing after journal"] as const) test(`${engine} native tmux ${mode} ${contended ? "contended" : "unlocked"} ${queued} queued input preserves delivery authorship`, async () => {
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
  // Independent positive ownership already exists for this queued operator id.
  // Text equality alone would be insufficient for a new native id after delivery.
  const queuedOperatorPrompt = mode === "relay" ? `User message for your branch «${childEntry.title}» — forward it or handle it yourself:\n${prompt}` : prompt;
  memoryIndex().recordNativeTurn(receipt.conversationId, "native:synthetic-typed", transcript, fs.statSync(transcript).size, queuedOperatorPrompt);
  // The earlier operator hook ran before its journal row materialized.
  const lock = contended ? new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite")) : null;
  lock?.exec("BEGIN IMMEDIATE");
  let result;
  try { result = await deliverConversationMessage({ path: mode === "relay" ? child : transcript, pid: process.pid, text: prompt, images: [],
    origin: { kind: mode === "relay" ? "operator" : "agent" } }, { recover: async () => null, targetForKnownPid: async () => "%synthetic",
    pathAllowed: () => true, listFiles: async () => mode === "relay" ? [entry, childEntry] : [entry],
    resumeSpecFor: (_root, pathname) => mode === "relay" && pathname === child ? null : ({ command: "synthetic", engine, cwd: root, transcript, windowName: "synthetic", launchProfile: emptyLaunchProfile({ cwd: root }) }),
    deliver: async ({ payload }) => { wire = payload; return { ok: true, target: "%synthetic", outcome: "resumed" }; } }); }
  finally { lock?.exec("ROLLBACK"); lock?.close(); }
  memoryIndex().close();
  expect(result.ok).toBe(true);
  if (queued === "identical") memoryIndex().recordNativeTurn(receipt.conversationId, "native:synthetic-earlier", transcript, fs.statSync(transcript).size, wire);
  const earlierHook = () => offerForHook(request, { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root,
    prompt_id: "synthetic-earlier", turn_id: "synthetic-earlier", prompt: wire, ...(engine === "claude" ? { source: "user" } : {}) });
  if (queued === "racing before journal") { expect(await earlierHook()).toBe(""); expect(calls).toBe(0); memoryIndex().close(); }
  // Another submission queued before actuation can journal after this receipt.
  fs.appendFileSync(transcript, JSON.stringify(engine === "claude"
    ? { type: "user", uuid: "synthetic-earlier", message: { role: "user", content: queued !== "different" ? wire : "Earlier queued input" } }
    : { type: "response_item", payload: { type: "message", turn_id: "synthetic-earlier", role: "user", content: [{ type: "input_text", text: queued !== "different" ? wire : "Earlier queued input" }] } }) + "\n");
  if (queued === "racing after journal") { expect(await earlierHook()).toBe(""); expect(calls).toBe(0); memoryIndex().close(); }
  if (queued === "identical" || queued.startsWith("racing")) fs.appendFileSync(transcript, JSON.stringify(engine === "claude"
    ? { type: "user", uuid: "synthetic-machine", message: { role: "user", content: wire } }
    : { type: "response_item", payload: { type: "message", turn_id: "synthetic-machine", role: "user", content: [{ type: "input_text", text: wire }] } }) + "\n");
  if (engine === "claude") for (const source of ["sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event"]) {
    expect(await offerForHook(request, { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root,
      prompt_id: `synthetic-${source}`, prompt: "Update widget parser background wakeup", source })).toBe("");
    expect(calls).toBe(0);
    expect(memoryIndex().turnOffers(receipt.conversationId)).toEqual([]);
  }
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root,
    ...(engine === "claude" ? { source: "user" } : {}),
    prompt_id: "synthetic-machine", turn_id: "synthetic-machine", prompt: wire };
  expect(await offerForHook(request, input)).toBe("");
  expect(calls).toBe(0);
  expect(memoryIndex().turnOffers(receipt.conversationId)).toEqual([]);
  if (queued === "unowned" || queued.startsWith("racing")) {
    // Optional earlier hooks can fail. Neither guessed journal ownership nor
    // a retry after reload may admit memory to the pending machine delivery.
    memoryIndex().close();
    expect(await offerForHook(request, input)).toBe("");
    expect(calls).toBe(0);
    expect(await offerForHook(request, { ...input, prompt: "Check widget parser", prompt_id: "synthetic-distinct", turn_id: "synthetic-distinct" })).toContain("Delegatus shared memory");
    expect(calls).toBe(1);
    return;
  }
  expect(await offerForHook(request, { ...input, prompt: wire, prompt_id: "synthetic-typed", turn_id: "synthetic-typed" })).toContain("Delegatus shared memory");
  expect(calls).toBe(1);
  const userLine = (id: string, ts: string) => JSON.stringify(engine === "claude"
    ? { type: "user", uuid: id, timestamp: ts, message: { role: "user", content: wire } }
    : { type: "response_item", timestamp: ts, payload: { type: "message", turn_id: id, role: "user", content: [{ type: "input_text", text: wire }] } });
  // Both hooks ran before their journal rows; the machine row lands first.
  if (queued === "different") fs.appendFileSync(transcript, userLine("synthetic-machine", "2026-10-02T12:00:00.000Z") + "\n");
  expect(offeredMemoryForTranscript(transcript)).toEqual({}); // Poll before the operator native id journals.
  const offeredLine = userLine("synthetic-typed", "2026-10-02T12:00:01.000Z"), repeatedLine = userLine("synthetic-repeat", "2026-10-02T12:00:03.000Z");
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


for (const engine of ["claude", "codex"] as const) for (const mode of ["followup", "relay"] as const) for (const historical of [false, true]) for (const retained of [0, 100, 201]) test(`${engine} native tmux ${mode} ${historical ? "repeated" : "first"} ${retained} later deliveries lost receipt abstains across reload using independent registry evidence`, async () => {
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
const send = () => deliverConversationMessage({ path: mode === "relay" ? child : transcript, pid: process.pid, text: prompt, images: [],
    origin: { kind: mode === "relay" ? "operator" : "agent" } }, { recover: async () => null, targetForKnownPid: async () => "%synthetic",
    pathAllowed: () => true, listFiles: async () => mode === "relay" ? [entry, childEntry] : [entry],
    resumeSpecFor: (_root, pathname) => mode === "relay" && pathname === child ? null : ({ command: "synthetic", engine, cwd: root, transcript, windowName: "synthetic", launchProfile: emptyLaunchProfile({ cwd: root }) }),
    deliver: async ({ payload }) => { wire = payload; return { ok: true, target: "%synthetic", outcome: "resumed" }; } });
  if (historical) {
    expect((await send()).ok).toBe(true);
    expect(await offerForHook(request, { prompt: wire, hook_event_name: "UserPromptSubmit", session_id: session, cwd: root,
      prompt_id: "synthetic-first", turn_id: "synthetic-first", ...(engine === "claude" ? { source: "user" } : {}) })).toBe("");
    fs.appendFileSync(transcript, JSON.stringify(engine === "claude"
      ? { type: "user", uuid: "synthetic-first", message: { role: "user", content: wire } }
      : { type: "response_item", payload: { type: "message", turn_id: "synthetic-first", role: "user", content: [{ type: "input_text", text: wire }] } }) + "\n");
  }
  const lock = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  lock?.exec("BEGIN IMMEDIATE");
  const originalWrite = fs.writeFileSync;
  const pending = path.join(process.env.LLV_STATE_DIR!, "memory-terminal-pending");
  fs.writeFileSync = ((filename, ...args) => {
    if (String(filename).startsWith(pending + path.sep)) throw Object.assign(Error("Synthetic receipt storage unavailable"), { code: "ENOSPC" });
    return originalWrite(filename, ...args);
  }) as typeof fs.writeFileSync;
    let result;
  try { result = await send(); }
  finally { fs.writeFileSync = originalWrite; lock?.exec("ROLLBACK"); lock?.close(); }
  memoryIndex().close();
  expect(result.ok).toBe(true);
  if (retained) {
    const original = Object.values(registry.readOnlySnapshot().heldDeliveries).findLast(delivery => !memoryIndex().hasTerminalDelivery(delivery.command.operationId))!;
    expect(original).toBeDefined();
    await Bun.sleep(3);
    for (let n = 0; n < retained; n++) {
      const later = registry.holdDelivery(original.conversationId, `Different later input ${n}`, `synthetic-later-${n}`, "text", [], messageTextDigest(`Different later input ${n}`), { origin: { kind: "agent" } });
      registry.recordDeliveryOutcome(later.id, "delivered");
    }
    expect(registry.readOnlySnapshot().heldDeliveries[original.id]).toBeUndefined();
    expect(Boolean(registry.readOnlySnapshot().deliveryOperationOwners[original.command.operationId])).toBe(retained === 100);
  }
  setAgentRegistryForTests(new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" }));
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root,
    ...(engine === "claude" ? { source: "user" } : {}),
    prompt_id: "synthetic-machine", turn_id: "synthetic-machine", prompt: wire };
  expect(await offerForHook(request, input)).toBe("");
  expect(calls).toBe(0);
  expect(memoryIndex().turnOffers(receipt.conversationId)).toEqual([]);
  memoryIndex().close();
  expect(await offerForHook(request, input)).toBe("");
  expect(calls).toBe(0);
  if (mode === "followup") {
    // Losing machine authorship keeps identical native text ambiguous, while
    // independently authored structured operator input remains eligible.
    const deliveryId = crypto.randomUUID();
    const typed = engine === "codex" ? encodeCodexStructuredUserText(prompt, undefined, null, { kind: "operator" }, crypto.createHash("sha256").update(deliveryId).digest("hex")) : prompt;
    if (engine === "claude") new FileClaudeDeliveryLedger().recordQueued(session, { id: deliveryId, text: prompt, origin: { kind: "operator" } }, "queued-next-turn");
    expect(await offerForHook(request, { ...input, prompt: typed, ...(engine === "claude" ? { delegatus_delivery_id: deliveryId } : {}) })).toContain("Delegatus shared memory");
    expect(calls).toBe(1);
  }
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

for (const mode of ["unproven authorship", "expired deadline", "agent delivery", "no capability"] as const) test(`operator skipped count excludes machine traffic: ${mode}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-skipped-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT;
  process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" }); setAgentRegistryForTests(registry);
  const session = crypto.randomUUID(), prompt = "Update widget parser";
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, transport: "tmux",
    launchDisplay: { prompt, images: 0, echo: prompt }, launchProfile: emptyLaunchProfile({ cwd: root, title: "Synthetic count" }) });
  if (begun.kind !== "created") throw Error("Synthetic launch refused");
  const capability = registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
  if (mode === "unproven authorship") {
    // Registry authorship survived while the optional machine receipt did not.
    registry.holdDelivery(begun.receipt.conversationId, prompt, "fixture-missing-receipt", "text", [],
      structuredContent(prompt, []).contentDigest, { origin: { kind: "agent" } });
  }
  setSharedMemoryEnabled(projectInfoFromCwd(root)!.project, true);
  const submittedPrompt = mode === "agent delivery" ? encodeCodexStructuredUserText(prompt, undefined, null, { kind: "agent" },
    crypto.createHash("sha256").update("fixture-agent-turn").digest("hex")) : prompt;
  const input = { prompt: submittedPrompt, hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, turn_id: "fixture-native-turn" };
  const request = new Request("http://localhost/api/memory/inject", { headers: {
    ...(mode === "no capability" ? {} : { "x-llv-spawn-capability": capability }),
    "x-llv-memory-hook": crypto.randomUUID(),
    "x-llv-memory-deadline": String(Date.now() + (mode === "expired deadline" ? -1 : 1500)),
  } });
  globalThis.fetch = (() => { throw Error("No provider call expected"); }) as unknown as typeof fetch;
  expect(await prepareForHook(request, input)).toBe("");
  expect(memoryIndex().injectionActivity().skipped).toBe(mode === "agent delivery" || mode === "no capability" ? 0 : 1);
});

for (const oldKey of ["directory", "local repository", "path", "alias", "unlinked deleted directory", "unlinked deleted path", "aliased deleted directory", "aliased deleted path"] as const) for (const sourceEngine of ["claude", "codex"] as const) test(`Claude seat operator hook selects ${sourceEngine} (${oldKey}) memories after a relay with old folder keys and no asks store`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-seat-turn-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT; process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" }); setAgentRegistryForTests(registry);
  // A repository acquired its remote after these memories were indexed.
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/fixture/widgets.git\n');
  const project = projectInfoFromCwd(root)!.project;
  const reservation = registry.beginSpawnRequest({ engine: "claude", cwd: root, explicitProject: project,
    role: "orchestrator", origin: { kind: "operator" }, transport: "structured",
    launchProfile: emptyLaunchProfile({ cwd: root, title: "Synthetic seat conversation" }) });
  if (reservation.kind === "conflict") throw Error("fixture seat conflict");
  const receipt = reservation.receipt;
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  const session = crypto.randomUUID(), transcript = path.join(root, session + ".jsonl");
  const opening = "Review widget parser delimiter escaping";
  const relay = "Machine wake: widget parser work is ready";
  const prompt = "Update widget parser delimiter escaping";
  const line = (role: string, text: string, uuid: string) => JSON.stringify({ type: role, uuid, ...(role === "user" ? { promptSource: "sdk" } : {}), message: { role, content: [{ type: "text", text }] } });
  fs.writeFileSync(transcript, [line("user", opening, "fixture-opening"), line("assistant", "I will check the parser.", "fixture-reply"),
    line("user", relay, "fixture-relay"), line("assistant", "The work is queued.", "fixture-machine-reply")].join("\n") + "\n");
  registry.settleSpawn(receipt.launchId, { key: { engine: "claude", sessionId: session }, artifactPath: transcript, cwd: root,
    accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  setSharedMemoryEnabled(project, true);
  const ledger = new FileClaudeDeliveryLedger();
  ledger.recordQueued(session, { id: "fixture-relay-delivery", text: relay, origin: { kind: "agent" } }, "queued-next-turn");
  ledger.confirmDelivered(session, "fixture-relay-delivery", "fixture-relay");
  const sources = ["older", "current", "foreign"].map((name, n) => {
    const source = path.join(root, name + ".md");
    fs.writeFileSync(source, sourceEngine === "claude"
      ? `---\nname: Widget ${name} rule\ndescription: Widget parser ${name} delimiter policy.\ntype: project\n---\nWidget ${name} policy requires ${n + 2} escape characters.\n`
      : `cwd: ${root}\n# Widget ${name} rule\n- Widget parser ${name} delimiter policy requires ${n + 2} escape characters.\n`);
    return { path: source, engine: sourceEngine, sourceKind: sourceEngine === "claude" ? "claude_memory" as const : "rollout_summary" as const, project };
  });
  await memoryIndex().refresh(sources);
  // Old-path rows have no trusted relationship unless an alias records it.
  // A similarly named foreign folder stays outside the project's scope.
  const deletedFolder = root + "-previous";
  const foreignFolder = deletedFolder + "-copy";
  expect(fs.existsSync(deletedFolder)).toBe(false);
  expect(fs.existsSync(foreignFolder)).toBe(false);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "memory-index.sqlite"));
  const previousKey = oldKey === "directory" ? directoryProjectId(root) : oldKey === "local repository" ? localRepositoryProjectId(root)!
    : oldKey === "path" ? root.replace(/[^a-zA-Z0-9]/g, "-") : oldKey.endsWith("directory") ? directoryProjectId(deletedFolder)
    : oldKey.endsWith("path") ? deletedFolder.replace(/[^a-zA-Z0-9]/g, "-") : "fixture-old-repository";
  db.query("UPDATE memory_entries SET project = ? WHERE sourcePath = ?").run(previousKey, sources[0].path);
  db.query("UPDATE memory_entries SET project = ? WHERE sourcePath = ?").run(oldKey.endsWith("path")
    ? foreignFolder.replace(/[^a-zA-Z0-9]/g, "-") : directoryProjectId(foreignFolder), sources[2].path);
  const expectedMemoryIds = db.query<{ id: string }, [string]>("SELECT id FROM memory_entries WHERE sourcePath = ?")
    .all(sources[1].path).map(row => row.id);
  if (!oldKey.startsWith("unlinked")) expectedMemoryIds.push(...db.query<{ id: string }, [string]>("SELECT id FROM memory_entries WHERE sourcePath = ?")
    .all(sources[0].path).map(row => row.id));
  db.close();
  if (oldKey === "alias" || oldKey.startsWith("aliased")) fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), JSON.stringify({ schemaVersion: 1,
    aliases: { [previousKey]: "fixture-intermediate", "fixture-intermediate": project }, displayNames: { [project]: "Widgets" } }));
  // Unknown deleted paths intentionally contribute no candidate. Same-folder
  // historical keys and explicitly aliased deleted paths contribute both.
  const expectedCandidates = oldKey.startsWith("unlinked") ? 1 : 2;
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "operator-asks.json"))).toBe(false);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "asks-you-settings.json"))).toBe(false);
  let decisionCalls = 0, candidateCount = 0, failDecision = false;
  const endpoint = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    decisionCalls++; const body = await request.json(); candidateCount = Object.keys(body.questions).length;
    if (failDecision) return new Response(null, { status: 503 });
    expect(Object.keys(body.questions).sort()).toEqual(expectedMemoryIds.sort());
    expect(body.state.latestOperatorMessage).toBe(prompt);
    expect(body.state.precedingTurns).toContain("machine:");
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: .9 }])), usage: { cost: .0001 } });
  } });
  globalThis.fetch = ((url, init) => originalFetch(String(url).includes("openrouter.ai") ? `http://127.0.0.1:${endpoint.port}` : url, init)) as typeof fetch;
  const turn = "fixture-operator-delivery";
  ledger.recordQueued(session, { id: turn, text: prompt, origin: { kind: "operator" } }, "queued-next-turn");
  let pending = Promise.resolve("");
  const hookServer = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    pending = prepareForHook(request, await request.json()); return Response.json({ block: await pending });
  } });
  const queue = path.join(root, "queue.jsonl");
  fs.writeFileSync(queue, JSON.stringify({ id: turn, digest: crypto.createHash("sha256").update(prompt).digest("hex") }) + "\n");
  const hook = Bun.spawn([process.execPath, "-e", memoryHookSource(`http://127.0.0.1:${hookServer.port}`, null, queue)], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_SPAWN_CAPABILITY: capability } });
  try {
    hook.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt })); hook.stdin.end();
    expect(await hook.exited).toBe(0);
    const output = await new Response(hook.stdout).text(); await pending;
    expect(output).toContain("Delegatus shared memory");
    expect(candidateCount).toBe(expectedCandidates); expect(decisionCalls).toBe(1);
    expect(readOperatorAsks().spend.calls).toBe(1);
    expect(readOperatorAsks().spend.usd).toBeCloseTo(.0001, 8);
    expect(memoryIndex().injectionActivity()).toMatchObject({ decisions: 1, delivered: 1 });
    fs.appendFileSync(transcript, line("user", prompt, "fixture-current") + "\n");
    ledger.confirmDelivered(session, turn, "fixture-current");
    const names = offeredMemoryForTranscript(transcript);
    expect(names["fixture-current"]).toHaveLength(expectedCandidates); expect(names["fixture-relay"]).toBeUndefined();
    const feed = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const items = feed.feed(fs.readFileSync(transcript, "utf8").trim().split("\n"), 0, false).items.map(e => e.item);
    expect(provenanceLookupFor({ memoryOffers: names }, items).memoryFor!(items.find(i => i.kind === "sysmsg" && i.deliveredMessage?.engineMessageId === "fixture-current")!)).toHaveLength(expectedCandidates);
    expect(memoryIndex().lastTurn(project)).toBe("delivered");
    // Codex's default operator envelope also occurs on delegated stage starts.
    // It must leave the seat's last turn and the shared budget untouched.
    const stagePrompt = "You are a fresh-context Reviewer. Review widget parser delimiter escaping.";
    const stage = registry.beginSpawnRequest({ engine: "codex", cwd: root, explicitProject: project,
      role: "reviewer", origin: { kind: "container", container: "pipeline", containerId: "synthetic-stage", creatorConversationId: null }, transport: "structured",
      launchDisplay: { prompt: stagePrompt, echo: stagePrompt, images: 0 },
      launchProfile: emptyLaunchProfile({ cwd: root, title: "Synthetic stage conversation" }) });
    if (stage.kind === "conflict") throw Error("fixture stage conflict");
    const stageSession = crypto.randomUUID();
    registry.settleSpawn(stage.receipt.launchId, { key: { engine: "codex", sessionId: stageSession }, artifactPath: path.join(root, stageSession + ".jsonl"), cwd: root,
      accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    const stageCapability = registry.rotateSpawnCapabilityForReceipt(stage.receipt.launchId);
    const stageRequest = new Request("http://localhost/api/memory/inject", { headers: { "x-llv-spawn-capability": stageCapability } });
    const stageText = encodeCodexStructuredUserText(stagePrompt, undefined, null, { kind: "operator" }, messageTextDigest("synthetic-stage-start"));
    const beforeStage = memoryIndex().injectionActivity();
    expect(await offerForHook(stageRequest, { hook_event_name: "UserPromptSubmit", session_id: stageSession, cwd: root, prompt: stageText })).toBe("");
    expect(memoryIndex().lastTurn(project)).toBe("delivered");
    expect(memoryIndex().injectionActivity()).toEqual(beforeStage);
    expect(decisionCalls).toBe(1); expect(readOperatorAsks().spend.calls).toBe(1);
    const request = new Request("http://localhost/api/memory/inject", { headers: { "x-llv-spawn-capability": capability } });
    const input = { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt: relay, delegatus_delivery_id: "fixture-relay-delivery" };
    expect(await offerForHook(request, input)).toBe("");
    expect(memoryIndex().lastTurn(project)).toBe("delivered");
    const nextTurn = "fixture-next-operator";
    ledger.recordQueued(session, { id: nextTurn, text: prompt, origin: { kind: "operator" } }, "queued-next-turn");
    expect(await offerForHook(request, { ...input, prompt, delegatus_delivery_id: nextTurn })).toBe("");
    expect(memoryIndex().lastTurn(project)).toBe("noCandidates");
    expect(decisionCalls).toBe(1);
    const fresh = path.join(root, "fresh.md");
    fs.writeFileSync(fresh, "---\nname: Widget integrity\ndescription: Widget checksum protects immutable release manifests.\ntype: project\n---\nWidget integrity validates sealed package manifests before promotion.\n");
    await memoryIndex().refresh([{ path: fresh, engine: "claude", sourceKind: "claude_memory", project }]);
    writeAsksYouSettings({ capUsd: 0 });
    ledger.recordQueued(session, { id: "fixture-capped", text: prompt, origin: { kind: "operator" } }, "queued-next-turn");
    expect(await offerForHook(request, { ...input, prompt, delegatus_delivery_id: "fixture-capped" })).toBe("");
    expect(memoryIndex().lastTurn(project)).toBe("capped"); expect(decisionCalls).toBe(1);
    expect(readOperatorAsks().spend.capped).toBe(1);
    writeAsksYouSettings({ capUsd: 1 }); failDecision = true;
    ledger.recordQueued(session, { id: "fixture-failed", text: prompt, origin: { kind: "operator" } }, "queued-next-turn");
    expect(await offerForHook(request, { ...input, prompt, delegatus_delivery_id: "fixture-failed" })).toBe("");
    expect(memoryIndex().lastTurn(project)).toBe("failed"); expect(decisionCalls).toBe(2);
    expect(readOperatorAsks().spend.usd).toBeCloseTo(.0001, 8);
    // A real subsequent operator submission may repeat the launch's words.
    const human = registry.holdDelivery(stage.receipt.conversationId, stagePrompt, "synthetic-human-stage-turn", "text", [],
      structuredContent(stagePrompt, []).contentDigest, { origin: { kind: "operator" } });
    const humanText = encodeCodexStructuredUserText(stagePrompt, undefined, null, { kind: "operator" }, deliveryDedupToken(human.command.operationId));
    delete process.env.OPENROUTER_API_KEY;
    expect(await offerForHook(stageRequest, { hook_event_name: "UserPromptSubmit", session_id: stageSession, cwd: root, prompt: humanText })).toBe("");
    expect(memoryIndex().lastTurn(project)).toBe("noKey");
  } finally { hook.kill(); await hook.exited; await pending; hookServer.stop(true); endpoint.stop(true); }
}, 5000);
