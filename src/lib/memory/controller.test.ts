import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { memoryIndex } from "./service";
import { setSharedMemoryEnabled } from "./settings";
import { offerForHook } from "./controller";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { writeAsksYouSettings } from "@/lib/asks/settings";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { readOperatorAsks } from "@/lib/asks/store";
import type { groundedRequest } from "./selection";

const previous = { ...process.env };
const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(() => {
  memoryIndex().close(); setAgentRegistryForTests(null); globalThis.fetch = originalFetch;
  for (const key of ["LLV_STATE_DIR", "OPENROUTER_API_KEY", "PORT"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

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
