import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { applyConversationAction } from "./actions";
import { resumeConversation } from "@/lib/delivery";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import { recoverDeadStructuredConversation } from "@/lib/runtime/structuredRecovery";

function fixture(engine: "claude" | "codex") {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-parity-"));
 const transcript = path.join(directory, crypto.randomUUID() + ".jsonl"); fs.writeFileSync(transcript, "");
 const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
 const value = registry.ensureConversation(engine, transcript, null);
 const wakes: string[] = [];
 const deps = { registry: () => registry, structuredEnabled: () => true, dispatchStructuredControl: async () => null,
  onResumed: (id: string) => { wakes.push(id); },
  interruptConversation: async () => ({ ok: true as const, target: null }),
  killConversation: async () => ({ ok: true as const, target: null }),
  compactConversation: async () => ({ ok: true as const, target: null }),
  answerDialogKey: async () => ({ ok: true as const, target: null }) };
 return { registry, value, transcript, directory, wakes, deps,
  request: { conversationId: value.id, transcriptPath: transcript, action: "resume" },
  close: () => { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
for (const engine of ["claude", "codex"] as const) {
 test("real canonical " + engine + " bridge preserves held recovery without requesting a tick", async () => {
  const f = fixture(engine);
  try {
   const key = { engine, sessionId: f.value.generations.at(-1)!.id };
   const row = { key, artifactPath: f.transcript, cwd: f.directory, accountId: "fixture-account",
    launchProfile: emptyLaunchProfile({ cwd: f.directory }), status: "dead" as const, host: null,
    claimEpoch: 4, claimOwner: "structured-host:parked", pendingAction: null,
    structuredHost: { kind: engine === "claude" ? "claude-broker" as const : "codex-app-server" as const,
     endpoint: "stdio:parked", process: captureProcessIdentity(process.pid), eventCursor: 11,
     protocolVersion: "v2", writerClaimEpoch: 4, activeTurnRef: null, pendingAttention: [], activeFlags: [] } };
   f.registry.upsert(row);
   let fellThrough = false;
   const result = await applyConversationAction(f.request, { ...f.deps,
    dispatchStructuredControl: async request => {
     const result = await dispatchStructuredControl(request, { registry: f.registry, enabled: () => true, client: null });
     expect(result).toBeNull(); fellThrough = true; return result;
    },
    resumeConversation: async transcript => {
     // A concurrent recovery publishes its host after the dead-row routing decision.
     expect(fellThrough).toBeTrue(); f.registry.upsert({ ...row, status: "idle" });
     return resumeConversation(transcript, { registry: f.registry, pathAllowed: () => true,
      recover: async request => {
       const recovered = await recoverDeadStructuredConversation(request, {
        registry: f.registry, client: null, transport: () => "structured",
        park: () => ({ reason: "quota_exhausted", accountId: "fixture-account", until: new Date(Date.now() + 60000).toISOString(), resetKnown: true }) });
       expect(recovered?.hold).toMatchObject({ reason: "quota_exhausted" }); return recovered;
      } });
    } });
   await new Promise<void>(resolve => setImmediate(resolve));
   expect(result.body).toMatchObject({ outcome: "held" });
   expect(f.wakes).toHaveLength(0);
  } finally { f.close(); }
 });
 test("real canonical " + engine + " successful resume requests exactly one tick", async () => {
  const f = fixture(engine);
  try {
   await applyConversationAction(f.request, { ...f.deps,
    resumeConversation: transcript => resumeConversation(transcript, { registry: f.registry, pathAllowed: () => true,
     recover: async () => ({ target: null, path: transcript, conversationId: f.value.id, spawned: true }) }) });
   await new Promise<void>(resolve => setImmediate(resolve));
   expect(f.wakes).toEqual([f.value.id]);
  } finally { f.close(); }
 });
 test("real canonical " + engine + " failed recovery never requests a tick", async () => {
  const f = fixture(engine);
  try {
   const result = await applyConversationAction(f.request, { ...f.deps,
    resumeConversation: transcript => resumeConversation(transcript, { registry: f.registry, pathAllowed: () => true,
     recover: async () => { throw new Error("recovery unavailable"); } }) });
   await new Promise<void>(resolve => setImmediate(resolve));
   expect(result.status).toBe(500); expect(f.wakes).toEqual([]);
  } finally { f.close(); }
 });
 test("handled structured " + engine + " resume never also enters canonical resume", async () => {
  const f = fixture(engine); let canonical = 0;
  try {
   await applyConversationAction(f.request, { ...f.deps,
    dispatchStructuredControl: async () => { f.wakes.push(f.value.id); return { status: 200, body: { ok: true, structured: true, target: f.value.id, outcome: "resumed", spawned: false } }; },
    resumeConversation: async () => { canonical++; return { ok: true, target: null, outcome: "resumed" }; } });
   await new Promise<void>(resolve => setImmediate(resolve));
   expect(canonical).toBe(0); expect(f.wakes).toEqual([f.value.id]);
  } finally { f.close(); }
 });
}

for (const engine of ["claude", "codex"] as const) test("structured " + engine + " held recovery does not request a tick", async () => {
 const f = fixture(engine);
 try {
  const key = { engine, sessionId: f.value.generations.at(-1)!.id };
  f.registry.upsert({ key, artifactPath: f.transcript, cwd: f.directory, accountId: "fixture-account",
   launchProfile: emptyLaunchProfile({ cwd: f.directory }), status: "idle", host: null,
   claimEpoch: 4, claimOwner: "structured-host:parked", pendingAction: null,
   structuredHost: { kind: engine === "claude" ? "claude-broker" : "codex-app-server",
    endpoint: "stdio:parked", process: captureProcessIdentity(process.pid), eventCursor: 11,
    protocolVersion: "v2", writerClaimEpoch: 4, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  const result = await dispatchStructuredControl({ path: f.transcript, conversationId: f.value.id, action: "resume" }, {
   registry: f.registry, enabled: () => true, client: null, hostProcessAlive: () => false,
   onResumed: id => { f.wakes.push(id); },
   recover: request => recoverDeadStructuredConversation(request, { registry: f.registry, client: null,
    transport: () => "structured", park: () => ({ reason: "quota_exhausted", accountId: "fixture-account",
     until: new Date(Date.now() + 60000).toISOString(), resetKnown: true }) }),
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(result?.body).toMatchObject({ outcome: "held" });
  expect(f.wakes).toEqual([]);
 } finally { f.close(); }
});
