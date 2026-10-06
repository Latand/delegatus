import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFeedSession } from "@/components/feed/parse";
import { provenanceLookupFor } from "@/components/feed/messageProvenance";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { projectInfoFromCwd } from "@/lib/scanner/describe";

import { offerForHook } from "./controller";
import { memoryForTranscript, offeredMemoryForTranscript } from "./offers";
import { memoryIndex } from "./service";
import { setSharedMemoryEnabled } from "./settings";

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

test("a transcript names the file behind each added memory and the turn where none was chosen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-on-message-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT; process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" }); setAgentRegistryForTests(registry);
  const receipt = registry.beginSpawn("codex", root, { cwd: root, title: "Synthetic memory conversation" });
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  const project = projectInfoFromCwd(root)!.project; setSharedMemoryEnabled(project, true);
  const source = path.join(root, "widget.md");
  fs.writeFileSync(source, "---\nname: Widget parser\ndescription: Widget parser requires escaped delimiters.\nmetadata:\n  type: project\n---\nUse escaped delimiters.\n");
  await memoryIndex().refresh([{ path: source, engine: "claude", sourceKind: "claude_memory", project }]);
  let score = .1, decisions = 0;
  globalThis.fetch = (async () => {
    decisions++;
    const id = memoryIndex().injectionCandidates("widget parser", project, "codex", receipt.conversationId)[0].id;
    return Response.json({ answers: { [id]: { noul: score } }, usage: { cost: .0001 } });
  }) as unknown as typeof fetch;
  const session = crypto.randomUUID(), transcript = path.join(root, session + ".jsonl");
  const turn = async (text: string, seed: string) => {
    const prompt = encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, crypto.createHash("sha256").update(seed).digest("hex"));
    const request = new Request("http://localhost/api/memory/inject", { headers: {
      "x-llv-spawn-capability": capability, "x-llv-memory-hook": crypto.randomUUID(), "x-llv-memory-deadline": String(Date.now() + 1500) } });
    const block = await offerForHook(request, { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt });
    if (block) await offerForHook(request, { delegatus_confirm: true, delegatus_emitted_at: Date.now() });
    return { block, line: JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }) };
  };
  // The quiet turn comes first: an added memory is never a candidate again.
  const quiet = await turn("Check widget parser", "quiet");
  expect(quiet.block).toBe("");
  score = .8;
  const added = await turn("Update widget parser", "added");
  expect(added.block).toContain("Widget parser");
  expect(decisions).toBe(2);
  fs.writeFileSync(transcript, quiet.line + "\n" + added.line + "\n");
  registry.settleSpawn(receipt.launchId, { key: { engine: "codex", sessionId: session }, artifactPath: transcript, cwd: root,
    accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  memoryIndex().close(); // Both records are read back from disk, as a reopened conversation reads them.

  const memory = memoryForTranscript(transcript);
  const [addedKey] = Object.keys(memory.offers);
  expect(memory.offers).toEqual({ [addedKey]: ["Widget parser"] });
  expect(memory.paths).toEqual({ [addedKey]: [source] });
  expect(memory.none).toHaveLength(1);
  expect(memory.none[0]).not.toBe(addedKey);
  expect(offeredMemoryForTranscript(transcript)).toEqual(memory.offers);

  const feed = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  const users = feed.feed([quiet.line, added.line], 0, false).items.map(entry => entry.item).filter(item => item.kind === "user");
  const lookup = provenanceLookupFor({ memoryOffers: memory.offers, memoryPaths: memory.paths, memoryNone: memory.none }, users);
  expect(lookup.memoryOn!(users[0])).toEqual({ added: [], none: true });
  expect(lookup.memoryOn!(users[1])).toEqual({ added: [{ title: "Widget parser", path: source }], none: false });
}, 5000);

test("a turn with no candidates leaves no verdict on the message", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-on-message-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT; process.env.OPENROUTER_API_KEY = "fixture";
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" }); setAgentRegistryForTests(registry);
  const receipt = registry.beginSpawn("codex", root, { cwd: root, title: "Synthetic memory conversation" });
  const capability = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  setSharedMemoryEnabled(projectInfoFromCwd(root)!.project, true);
  let decisions = 0;
  globalThis.fetch = (async () => { decisions++; return Response.json({ answers: {}, usage: { cost: 0 } }); }) as unknown as typeof fetch;
  const session = crypto.randomUUID(), transcript = path.join(root, session + ".jsonl");
  const prompt = encodeCodexStructuredUserText("Update widget parser", undefined, null, { kind: "operator" }, crypto.createHash("sha256").update("empty").digest("hex"));
  const request = new Request("http://localhost/api/memory/inject", { headers: {
    "x-llv-spawn-capability": capability, "x-llv-memory-hook": crypto.randomUUID(), "x-llv-memory-deadline": String(Date.now() + 1500) } });
  expect(await offerForHook(request, { hook_event_name: "UserPromptSubmit", session_id: session, cwd: root, prompt })).toBe("");
  expect(decisions).toBe(0);
  fs.writeFileSync(transcript, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }) + "\n");
  registry.settleSpawn(receipt.launchId, { key: { engine: "codex", sessionId: session }, artifactPath: transcript, cwd: root,
    accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  expect(memoryForTranscript(transcript)).toEqual({ offers: {}, paths: {}, none: [] });
}, 5000);
