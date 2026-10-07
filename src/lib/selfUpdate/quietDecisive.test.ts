/* The independent review's repro suite for #2555 (docs/design/update-drain-liveness.md,
   "The repro suite"): fifteen cases over the real delivery controller, registry
   and RuntimeJournal with the production reader. Recorded at the #2555 head as
   7 pass and 8 fail; each case names the rule that decides it. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { agentLivenessSnapshot, productionLivenessSources } from "@/lib/lifecycle/liveness";
import { bindStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryController";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeEventInput, RuntimeSession } from "@/lib/runtime/contracts";
import { RuntimeJournal } from "../../runtime-host/journal";
import { ownerCensusReader, productionDeps } from "./instance";
import { probeQuiet, type QuietPorts } from "./quiet";
import type { Snapshot } from "./types";

const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;
const previousCodexHome = process.env.LLV_CODEX_HOME;
let f: ReturnType<typeof fixture>;
let child: ReturnType<typeof Bun.spawn>;

function ports(journal: RuntimeJournal): QuietPorts {
  return { ...productionDeps().quiet!, runtimeSnapshot: async () => journal.snapshot(),
    owners: ownerCensusReader(productionLivenessSources, { readSession: (query) => f.client.readSession!(query) }),
    pipelines: () => [], flows: () => [], seats: () => [], presence: () => [],
    registryHealth: () => [], controllerBusyReason: async () => null, memoryAvailableMb: () => 8_192 };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "quiet-fallback-"));
  process.env.LLV_CODEX_HOME = join(dir, "codex");
  const transcriptDir = join(process.env.LLV_CODEX_HOME, "sessions", "2026", "01", "01");
  mkdirSync(transcriptDir, { recursive: true });
  const id = randomUUID(), at = new Date().toISOString();
  const file = join(transcriptDir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  writeFileSync(file, [
    { timestamp: at, type: "session_meta", payload: { id, cwd: dir } },
    { timestamp: at, type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "Run the task" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const registry = new AgentRegistry(join(dir, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", file, "fixture");
  const key = { engine: "codex" as const, sessionId: conversation.generations[0]!.id };
  const journal = new RuntimeJournal(join(dir, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    snapshot: async () => journal.snapshot(),
    readSession: async (query: Parameters<RuntimeJournal["readSession"]>[0]) => journal.readSession(query),
    append: async (event: RuntimeEventInput) => journal.append(event),
    appendSessionFenced: async (event: RuntimeEventInput & { expectedSessionRevision: number }) => {
      if (typeof event.scope !== "object" || journal.readSession({ conversationId: event.scope.id })?.revision !== event.expectedSessionRevision) {
        throw new Error("session revision changed");
      }
      return journal.append(event);
    },
    operationStatus: async () => null,
    effectBatch: async () => [],
  } as unknown as RuntimeHostClient;
  return { dir, registry, conversation, key, file, journal, client };
}

beforeEach(() => {
  f = fixture();
  child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid);
  if (!identity) throw new Error("fixture process identity unavailable");
  f.registry.upsert({ key: f.key, artifactPath: f.file, cwd: f.dir, accountId: "fixture", status: "live", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:fixture", process: identity,
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: "running-turn", pendingAttention: [], activeFlags: [] } });
});

afterEach(async () => {
  await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
  setAgentRegistryForTests(null);
  if (child.exitCode === null) child.kill();
  await child.exited;
  f.journal.close();
  rmSync(f.dir, { recursive: true, force: true });
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
});

function journalRow(overrides: Partial<RuntimeSession> = {}) {
  f.journal.append({ scope: { type: "session", id: f.conversation.id }, kind: "session-status",
    producer: { kind: "codex-app-server", eventKey: randomUUID() },
    payload: { sessionKey: f.key, hostKind: "codex-app-server", host: "hosted", turn: "running", provenance: "structured",
      artifactPath: f.file, cwd: f.dir, accountId: "fixture", activeTurnId: "running-turn", ...overrides } });
}

async function fallback(status: "dead" | "unhosted" | "idle") {
  const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  f.registry.upsert({ ...entry, status });
  await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
}

function settleTranscript() {
  appendFileSync(f.file, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_complete" } }) + "\n");
  const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  f.registry.upsert({ ...entry, status: "idle", structuredHost: { ...entry.structuredHost!, activeTurnRef: null } });
}

function settleSuccessor() {
  const id = randomUUID();
  const path = join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const at = new Date().toISOString();
  writeFileSync(path, [{ timestamp: at, type: "session_meta", payload: { id, cwd: f.dir } },
    { timestamp: at, type: "event_msg", payload: { type: "task_complete" } }].map(record => JSON.stringify(record)).join("\n") + "\n");
  const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
    purpose: "resume-successor", conversationId: f.conversation.id });
  if (begun.kind !== "created") throw new Error("successor receipt was not created");
  expect(f.registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: id }, artifactPath: path, cwd: f.dir,
    accountId: "fixture", status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null }).kind).toBe("settled");
  expect(f.registry.readOnlySnapshot().conversations[f.conversation.id]!.generations.map(generation => generation.path)).toEqual([f.file, path]);
  return path;
}

for (const status of ["dead", "unhosted"] as const) test(`independent: settled host with its own writer claim releases despite ${status} labels`, async () => {
 settleTranscript();
 const entry=f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
 const identity=captureProcessIdentity(child.pid)!;
 f.registry.upsert({...entry,claimEpoch:1,claimOwner:`structured-host:${JSON.stringify(identity)}`,structuredHost:{...entry.structuredHost!,writerClaimEpoch:1}});
 await fallback(status);
 const p=ports(f.journal),now=Date.now();
 expect(await probeQuiet(snapshot,p,now+300000,true)).toMatchObject({quiet:true,blockers:{turns:0}});
});
for(const current of ["dead","reused","idle"] as const) test(`independent: second settled idle row releases with a ${current} first row at the same path`, async () => {
 settleTranscript();
 const sibling=Bun.spawn(["sleep","60"]);
 try {
  const key={engine:"codex" as const,sessionId:randomUUID()};
  const entry=f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  f.registry.upsert({...entry,key,status:"idle",structuredHost:{...entry.structuredHost!,process:captureProcessIdentity(sibling.pid)!,activeTurnRef:null}});
  if(current==="dead"){child.kill();await child.exited;}
  if(current==="reused") f.registry.upsert({...entry,structuredHost:{...entry.structuredHost!,process:{...entry.structuredHost!.process!,startIdentity:"reused"}}});
  await fallback(current==="idle"?"idle":"dead");
  const p=ports(f.journal),now=Date.now();
  expect(await probeQuiet(snapshot,p,now+300000,true)).toMatchObject({quiet:true,blockers:{turns:0}});
 } finally{sibling.kill();await sibling.exited;}
});
for(const prior of ["dead","reused"] as const) test(`independent: stale journal turn from ${prior} prior owner releases after live idle successor`,async()=>{
 journalRow();
 if(prior==="dead"){child.kill();await child.exited;}
 else {const entry=f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;f.registry.upsert({...entry,structuredHost:{...entry.structuredHost!,process:{...entry.structuredHost!.process!,startIdentity:"reused"}}});}
 const current=settleSuccessor(),conv=f.registry.readOnlySnapshot().conversations[f.conversation.id]!,generation=conv.generations.at(-1)!;
 const successor=Bun.spawn(["sleep","60"]);
 try{
  const key={engine:"codex" as const,sessionId:generation.id};
  f.registry.upsert({key,artifactPath:current,cwd:f.dir,accountId:"fixture",status:"idle",host:null,claimEpoch:0,claimOwner:null,pendingAction:null,structuredHost:{kind:"codex-app-server",endpoint:"stdio:successor",process:captureProcessIdentity(successor.pid)!,eventCursor:0,protocolVersion:null,writerClaimEpoch:0,activeTurnRef:null,pendingAttention:[],activeFlags:[]}});
  const p=ports(f.journal),now=Date.now();
  expect(await probeQuiet(snapshot,p,now+300000,true)).toMatchObject({quiet:true,blockers:{turns:0}});
 }finally{successor.kill();await successor.exited;}
});

for(const projected of [false,true])for(const kind of ["busy","idle","dead","reused"] as const)test(`independent: inventory collision hides actual ${kind} path projection=${projected}`,async()=>{
 settleTranscript();
 const entry=f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
 const actual=join(process.env.LLV_CODEX_HOME!,"sessions","2026","01","01",`rollout-2026-01-01T01-00-00-${f.key.sessionId}.jsonl`),at=new Date().toISOString();
 writeFileSync(actual,[{timestamp:at,type:"session_meta",payload:{id:f.key.sessionId,cwd:f.dir}},{timestamp:at,type:"event_msg",payload:{type:kind==="idle"?"task_complete":"task_started"}}].map(record=>JSON.stringify(record)).join("\n")+"\n");
 const idle=Bun.spawn(["sleep","60"]);
 try{
  f.registry.upsert({...entry,artifactPath:actual,structuredHost:{...entry.structuredHost!,activeTurnRef:null,...(kind==="reused"?{process:{...entry.structuredHost!.process!,startIdentity:"reused"}}:{})}});
  f.registry.upsert({...entry,key:{engine:"codex",sessionId:randomUUID()},artifactPath:f.file,status:"idle",structuredHost:{...entry.structuredHost!,process:captureProcessIdentity(idle.pid)!,activeTurnRef:null}});
  if(kind==="dead"){child.kill();await child.exited;}
  await bindStructuredDeliveryQueue([],{registry:f.registry,client:f.client,hostlessSettleIntervalMs:0});
  const p=ports(f.journal);
  if(!projected){p.runtimeSnapshot=async()=>({sessions:[]});f.client.readSession=async()=>null;}
  const live=(await agentLivenessSnapshot({transcriptPath:actual,liveOnly:true},productionLivenessSources())).conversations[0]!;
  const verdict=await probeQuiet(snapshot,p,Date.now(),true);
  if(kind==="busy")expect(live).toMatchObject({host:{state:"alive"},turnState:"busy"});
  expect(verdict).toMatchObject({quiet:kind!=="busy",blockers:{turns:kind==="busy"?1:0}});
 }finally{idle.kill();await idle.exited;}
});
