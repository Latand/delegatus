import { persistProjectAliases, projectAliasKeys } from "@/lib/projects/aliases";
import { currentRecoverySeat } from "@/lib/orchestrator/seats";
import { pipelineAdmissionIdentity } from "@/lib/pipelines/creationAdmission";
import * as sqliteReads from "@/lib/sqliteReadAttribution";
import { mcpPageCursorStore } from "./pageCursors";
import { runAsMcpHttpCaller } from "./callerContext";
import * as pipelineEngine from "@/lib/pipelines/engine";
import * as pipelineStore from "@/lib/pipelines/store";
import * as pipelineAdmission from "@/lib/pipelines/creationAdmission";
import { admitQueuedPipelineCreations, listQueuedPipelineCreations, pipelineCreationQueueDir } from "@/lib/pipelines/creationQueue";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorRecipientRefusalAsync, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { projectForCwd } from "@/lib/scanner/describe";
import { productionDomainDependencies, recoveryCaller, viewerMcpBindings, viewerMcpRecoverableTools } from "./bindings";
import { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore, type McpRequestBinding } from "./server";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(git = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-unknown-claims-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.LLV_STATE_DIR, previousCodex = process.env.LLV_CODEX_HOME;
  process.env.LLV_STATE_DIR = path.join(root, "state"); process.env.LLV_CODEX_HOME = path.join(root, "codex");
  fs.mkdirSync(path.join(process.env.LLV_CODEX_HOME, "sessions"), { recursive: true });
  cleanup.push(() => {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    if (previousCodex === undefined) delete process.env.LLV_CODEX_HOME; else process.env.LLV_CODEX_HOME = previousCodex;
  });
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  setAgentRegistryForTests(registry); cleanup.push(() => { setAgentRegistryForTests(null); registry.close(); });
  if (git) {
    for (const args of [["init", "--initial-branch=main", root], ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=noreply", "commit", "--allow-empty", "-m", "Fixture"]]) {
      const child = Bun.spawnSync(["/usr/bin/git", ...args], { stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    }
  }
  const project = projectForCwd(root)!;
  if (git) { pipelineStore.loadPipelines(); pipelineAdmissionIdentity(true); }
  function seed(name: string) {
    const receipt = registry.beginSpawn("codex", root, { cwd: root, title: "Read launch claims" });
    const transcript = path.join(process.env.LLV_CODEX_HOME!, "sessions", `${name}.jsonl`); fs.writeFileSync(transcript, "{}\n");
    registry.completeSpawn(receipt.launchId, { key: { engine: "codex", sessionId: name }, artifactPath: transcript,
      cwd: root, accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    return receipt.conversationId;
  }
  const stranger = seed("unrelated-worker");
  const strangerCapability = registry.rotateSpawnCapabilityForConversation(stranger)!.capability;
  let caller = seed("owner");
  let capability = registry.rotateSpawnCapabilityForConversation(caller)!.capability;
  function seat(id: string, key: string) {
    beginOrchestratorSeatIntent({ project, mandate: "Inspect launch claims", clientRequestId: key, mode: "existing", conversationId: id, now: "2020-01-01T00:00:00Z" });
    completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId: id,
      path: registry.conversation(id as `conversation_${string}`)!.generations.at(-1)!.path, now: "2020-01-01T00:00:00Z" });
  }
  seat(caller, "initial-seat");
  await orchestratorRecipientRefusalAsync([], () => "conversation_identity");
  const domain = { ...productionDomainDependencies, registrySnapshot: () => registry.readOnlySnapshot(),
    attentionAuthority: () => ({ kind: "worker" as const, conversationId: caller, role: "orchestrator" }) };
  const store = new SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR, "mcp-receipts.sqlite")); cleanup.push(() => store.close());
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), store, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  let afterService: (() => Promise<void>) | undefined;
  const server = createViewerMcpServer({ callTool: (...args) => runAsMcpHttpCaller({ capability }, async () => {
    const result = await service.callTool(...args); await afterService?.(); return result;
  }) }); const client = new Client({ name: "claims-reader", version: "1" });
  const [transport, peer] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(transport), server.connect(peer)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const read = async (args: Record<string, unknown> = {}) => (await client.callTool({ name: "list_unknown_launch_claims", arguments: args })).structuredContent as Record<string, unknown>;
  function claim(number: number, foreign = false, claimProject?: string) {
    const owner = recoveryCaller(domain, true, false);
    const key = `fixture-claim-${number}`;
    const projectKey = foreign ? "foreign-project" : claimProject ?? project;
    const binding: McpRequestBinding = { version: 1, toolName: "spawn_agent", clientRequestId: key, caller: { ...owner, project: projectKey },
      target: { project: projectKey, identity: root }, downstreamKey: `fixture-downstream-${number}`,
      owner: { pid: process.pid, startIdentity: null }, claimedAt: "2020-01-01T00:01:00Z",
      launchAdmission: { version: 1, settleAfter: Date.parse("2030-01-01T00:03:00Z"), envelopeDigest: "a".repeat(64), adaptations: {}, registryIdentity: null } };
    store.claim(`spawn_agent:${key}`, "b".repeat(64), "durable", binding);
    return key;
  }
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>;
  let rotations = 0;
  return { read, call, root, service, direct: (args: Record<string, unknown>) => runAsMcpHttpCaller({ capability }, () => service.callTool("list_unknown_launch_claims", args)),
    afterService: (hook: (() => Promise<void>) | undefined) => { afterService = hook; }, get source() { return registry.conversation(caller as `conversation_${string}`)!.generations.at(-1)!.path; },
    store, claim, project, rotate: () => { rotations++; caller = seed(`successor-${rotations}`); capability = registry.rotateSpawnCapabilityForConversation(caller)!.capability; seat(caller, `successor-seat-${rotations}`); },
    stranger: () => { caller = stranger; capability = strangerCapability; }, epoch: () => orchestratorSeatFor(project).active!.seatEpoch };
}

for (const count of [0, 1, 50, 100, 101]) test(`unknown launch read reaches ${count} claims with indexed bounded pages`, async () => {
  const f = await fixture();
  const expected = Array.from({ length: count }, (_, n) => f.claim(n));
  for (let n = 0; n < 250; n++) f.claim(1000 + n, true);
  let decoded = 0;
  const parse = sqliteReads.parseSqliteJson;
  const observer = spyOn(sqliteReads, "parseSqliteJson").mockImplementation((...args) => {
    if (args[1] && sqliteReads.sqliteReadCounters(args[1])?.reader === "mcp-receipts") decoded++;
    return parse(...args);
  });
  cleanup.push(() => observer.mockRestore());
  const keys: string[] = [];
  let cursor: unknown, pages = 0;
  do {
    const page = await f.read({ limit: 50, ...(cursor ? { cursor } : {}) });
    expect(page.ok).toBe(true);
    expect(Number(page.scanned)).toBeLessThanOrEqual(100);
    expect(page.decoded).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(24_576);
    keys.push(...(page.items as { clientRequestId: string }[]).map(row => row.clientRequestId));
    cursor = page.nextCursor; pages++;
    expect(pages).toBeLessThan(10);
  } while (cursor);
  expect(keys).toEqual(expected);
  expect(decoded).toBe(0);
  // A native positive control proves the parser observer reaches receipt reads.
  f.store.lookup(`spawn_agent:fixture-claim-${count ? 0 : 1000}`);
  expect(decoded).toBeGreaterThan(0);
});

test("unknown launch cursors pin the seat and watermark and refuse workers and foreign projects", async () => {
  const f = await fixture();
  f.claim(1); f.claim(2);
  const page = await f.read({ limit: 1 });
  f.claim(3);
  const second = await f.read({ limit: 1, cursor: page.nextCursor });
  expect(second.items).toMatchObject([{ clientRequestId: "fixture-claim-2" }]);
  expect(await f.read({ project: "foreign-project" })).toMatchObject({ ok: false, code: "recovery_not_permitted" });
  f.rotate();
  const stale = await f.read({ limit: 1, cursor: page.nextCursor });
  expect(stale).toMatchObject({ cursorReset: true });
  f.stranger();
  expect(await f.read()).toMatchObject({ ok: false, code: "recovery_not_permitted" });
});

test("unknown launch read skips a claim settled after its indexed selection", async () => {
  const f = await fixture();
  f.claim(1); f.claim(2);
  const select = SqliteMcpReceiptStore.prototype.launchClaimPage;
  let selected = false;
  const held = spyOn(SqliteMcpReceiptStore.prototype, "launchClaimPage").mockImplementation(function (this: SqliteMcpReceiptStore, ...args) {
    const rows = select.apply(this, args);
    if (!selected && rows.length) {
      selected = true;
      expect(f.store.fenceUndispatched("spawn_agent:fixture-claim-1", "b".repeat(64), { ok: false, error: "fixture fenced",
        toolName: "spawn_agent", clientRequestId: "fixture-claim-1", replayed: false, code: "fixture", retryable: false },
        f.store.lookup("spawn_agent:fixture-claim-1")!.binding!)).toBe(true);
    }
    return rows;
  });
  try {
    const page = await f.read();
    expect(selected).toBe(true);
    expect(page.items).toMatchObject([{ clientRequestId: "fixture-claim-2" }]);
    expect(page.items).toHaveLength(1);
    expect(Number(page.scanned)).toBeLessThanOrEqual(100);
  } finally { held.mockRestore(); }
});

test("unknown launch read advances through corrupt and individually oversized metadata", async () => {
  const f = await fixture();
  f.claim(1); f.claim(2); f.claim(3);
  const db = new (await import("bun:sqlite")).Database(f.store.filename);
  try {
    db.query("UPDATE mcp_receipts SET launch_tool='invalid' WHERE receipt_key=?").run("spawn_agent:fixture-claim-1");
    db.query("UPDATE mcp_receipts SET receipt_key=? WHERE receipt_key=?").run(`spawn_agent:${"ї".repeat(24_000)}`, "spawn_agent:fixture-claim-2");
  } finally { db.close(); }
  const page = await f.read({ limit: 1 });
  expect(page.items).toEqual([expect.objectContaining({ clientRequestId: "fixture-claim-3" })]);
  expect(Number(page.scanned)).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(24_576);
});

test("warm launch reads reuse seat authority without rereading unchanged lineage history", async () => {
  const f = await fixture();
  for (let n = 0; n < 40; n++) f.rotate();
  for (let n = 0; n < 50; n++) f.claim(n);
  let reads = 0;
  const read = fs.readFileSync;
  const observer = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === path.join(f.root, "state", "orchestrator-seats.json")) reads++;
    return Reflect.apply(read, fs, args);
  }) as typeof fs.readFileSync);
  try {
    for (let n = 0; n < 2; n++) {
      const page = await f.read({ limit: 50 });
      expect(page.ok).toBe(true); expect(page.items).toHaveLength(50);
    }
    expect(reads).toBe(0);
    // The unprojected native read proves the observer reaches the real file.
    expect(orchestratorSeatFor(f.project).active?.seatEpoch).toBe(f.epoch());
    expect(reads).toBeGreaterThan(0);
  } finally { observer.mockRestore(); }
});

test("a cold launch read warms the projection asynchronously without a synchronous history scan", async () => {
  const f = await fixture();
  for (let n = 0; n < 120; n++) f.rotate();
  f.claim(777);
  const cache = (globalThis as typeof globalThis & { __delegatusOrchestratorRecipientAuthorityV2__?: { indexes: Map<string, unknown> } })
    .__delegatusOrchestratorRecipientAuthorityV2__;
  expect(cache).toBeDefined();
  cache!.indexes.clear();
  let reads = 0;
  const read = fs.readFileSync;
  const observer = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === path.join(f.root, "state", "orchestrator-seats.json")) reads++;
    return Reflect.apply(read, fs, args);
  }) as typeof fs.readFileSync);
  try {
    expect(await f.read()).toMatchObject({ ok: true, items: [expect.objectContaining({ clientRequestId: "fixture-claim-777" })] });
    expect(reads).toBe(0);
  } finally { observer.mockRestore(); }
});


test("the recovery authority cache refreshes when project aliases change without a seat write", async () => {
  const f = await fixture();
  const before = currentRecoverySeat(f.project)!;
  expect(before).not.toBeNull();
  expect(before.seatEpoch).toBe(f.epoch());
  const file = path.join(f.root, "state", "orchestrator-seats.json"), bytes = fs.readFileSync(file);
  const target = "repo-recovery-cache-target";
  expect(persistProjectAliases([{ source: f.project, target, displayName: "Recovery fixture" }])).toBe(true);
  expect(fs.readFileSync(file)).toEqual(bytes);
  expect(currentRecoverySeat(target)).toEqual(before);
  expect(currentRecoverySeat(f.project)).toEqual(before);
});

test("unknown launch reads include late claims in 64, 65 and 72 key project families", async () => {
  for (const count of [64, 65, 72]) {
    const f = await fixture();
    const aliases = Array.from({ length: count - 1 }, (_, index) => ({
      source: `repo-launch-family-${count}-${index}`,
      target: f.project,
      displayName: "Launch family fixture",
    }));
    expect(persistProjectAliases(aliases)).toBe(true);
    const family = projectAliasKeys(f.project);
    expect(family).toHaveLength(count);
    const lateProject = family.at(-1)!;
    f.claim(count, false, lateProject);

    const recheck = SqliteMcpReceiptStore.prototype.launchClaimStillOpen;
    const observed = spyOn(SqliteMcpReceiptStore.prototype, "launchClaimStillOpen").mockImplementation(function (this: SqliteMcpReceiptStore, ...args) {
      expect(args[0]).toContain(lateProject);
      return recheck.apply(this, args);
    });
    try {
      const page = await f.read({ limit: 1 });
      expect(page).toMatchObject({ ok: true, items: [{ clientRequestId: `fixture-claim-${count}` }] });
      expect(page.scanned).toBeLessThanOrEqual(100);
    } finally { observed.mockRestore(); }
  }
});

test("launch claims written under a predecessor project key remain visible after succession", async () => {
  const f = await fixture();
  f.claim(17); f.claim(18);
  const predecessorPage = await f.read({ limit: 1 });
  expect(predecessorPage.nextCursor).toBeString();
  const successor = "repo-launch-claims-successor";
  expect(persistProjectAliases([{ source: f.project, target: successor, displayName: "Successor fixture" }])).toBe(true);
  const page = await f.read();
  expect(page).toMatchObject({ ok: true, items: [{ clientRequestId: "fixture-claim-17" }, { clientRequestId: "fixture-claim-18" }] });
  expect(await f.read({ cursor: predecessorPage.nextCursor })).toMatchObject({ cursorReset: true });
  f.stranger();
  expect(await f.read()).toMatchObject({ ok: false, code: "recovery_not_permitted" });
});

test("launch read refuses disclosure after the SDK service await changes the seat", async () => {
  const f = await fixture(); f.claim(0);
  const held = barrier(); f.afterService(async () => { held.enter(); await held.held; });
  const pending = f.read(); await held.ready;
  f.rotate(); held.release();
  const refused = await pending;
  expect(refused).toMatchObject({ ok: false, code: "caller_unidentified" });
  expect(JSON.stringify(refused)).not.toContain("fixture-claim-0");
  f.afterService(undefined); f.claim(1);
  expect(await f.read()).toMatchObject({ ok: true });
});

test("launch read revalidates after the outer page cursor wrapper", async () => {
  const f = await fixture(); f.claim(0); f.claim(1);
  const cursors = mcpPageCursorStore(), issue = cursors.issue.bind(cursors);
  let calls = 0;
  const observer = spyOn(cursors, "issue").mockImplementation((...args: Parameters<typeof issue>) => {
    const result = issue(...args); if (++calls === 2) f.rotate(); return result;
  });
  try {
    const refused = await f.direct({ limit: 1 });
    expect(calls).toBe(2);
    expect(refused).toMatchObject({ ok: false, code: "caller_unidentified" });
    expect(JSON.stringify(refused)).not.toContain("fixture-claim-0");
  } finally { observer.mockRestore(); }
  expect(await f.read({ limit: 1 })).toMatchObject({ ok: true });
});

function barrier() {
  let release!: () => void, enter!: () => void;
  return { held: new Promise<void>(resolve => { release = resolve; }), ready: new Promise<void>(resolve => { enter = resolve; }),
    release: () => release(), enter: () => enter() };
}

test("pipeline admission expiry fences a real MCP create held before preflight", async () => {
  const f = await fixture(true), gate = barrier();
  const original = pipelineEngine.createPipelineFromRequest;
  const held = spyOn(pipelineEngine, "createPipelineFromRequest").mockImplementation(async (...args) => {
    gate.enter(); await gate.held; return original(...args);
  });
  const args = { clientRequestId: "bounded-pipeline-original", task: "Inspect bounded creation", spec: "Inspect bounded creation", repoDir: f.root,
    src: f.source, autoStart: false, stages: [] };
  const pending = f.call("create_pipeline", args);
  try {
    await Promise.race([gate.ready, pending.then(result => { throw new Error(JSON.stringify(result)); })]);
    const db = new (await import("bun:sqlite")).Database(path.join(process.env.LLV_STATE_DIR!, "mcp-receipts.sqlite"));
    try {
      const row = db.query<{ binding_json: string }, [string]>("SELECT binding_json FROM mcp_receipts WHERE receipt_key=?").get(`create_pipeline:${args.clientRequestId}`)!;
      const binding = JSON.parse(row.binding_json); expect(binding.launchAdmission).toBeDefined();
      binding.launchAdmission.settleAfter = 1;
      db.query("UPDATE mcp_receipts SET binding_json=? WHERE receipt_key=?").run(JSON.stringify(binding),`create_pipeline:${args.clientRequestId}`);
    } finally { db.close(); }
    expect(await f.call("create_pipeline", { ...args, recoveryOnly: true })).toMatchObject({ details: { outcome: "not-executed" } });
    gate.release(); await pending;
    expect(pipelineStore.loadPipelines()).toHaveLength(0);
    expect(await admitQueuedPipelineCreations()).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(await f.call("create_pipeline", { ...args, recoveryOnly: true })).toMatchObject({ details: { outcome: "not-executed" } });
  } finally { gate.release(); await pending.catch(() => {}); held.mockRestore(); }
});

test("pipeline caller replacement at its awaited writer prevents persistence", async () => {
  const f = await fixture(true), gate = barrier();
  const original = pipelineStore.createPipelineWithDelivery;
  const held = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementation(async (...args) => {
    gate.enter(); await gate.held; return original(...args);
  });
  const pending = f.call("create_pipeline", { clientRequestId: "bounded-pipeline-caller", task: "Inspect caller authority", spec: "Inspect caller authority", repoDir: f.root,
    src: f.source, autoStart: false, stages: [] });
  try {
    await Promise.race([gate.ready, pending.then(result => { throw new Error(JSON.stringify(result)); })]);
    f.stranger(); gate.release();
    expect(await pending).toMatchObject({ ok: false, code: "caller_unidentified" });
    expect(pipelineStore.loadPipelines()).toHaveLength(0);
  } finally { gate.release(); await pending.catch(() => {}); held.mockRestore(); }
});

test("an actual queued pipeline with a lost MCP settlement recovers its id and drains once", async () => {
  const f = await fixture(true), gate = barrier();
  const holder = pipelineStore.withPipelineMutation(async () => { gate.enter(); await gate.held; }); await gate.ready;
  const settle = f.store.settle.bind(f.store);
  const fail = spyOn(f.store, "settle").mockImplementation((...args) => {
    if (args[0] === "create_pipeline:bounded-pipeline-queue") throw new Error("fixture lost MCP settlement");
    return settle(...args);
  });
  const args = { clientRequestId: "bounded-pipeline-queue", task: "Inspect queued creation", spec: "Inspect queued creation", repoDir: f.root,
    src: f.source, autoStart: false, stages: [] };
  try {
    const answer = await f.call("create_pipeline", args);
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true }); expect(answer.pipelineId).toBeString();
    expect(pipelineStore.loadPipelines()).toHaveLength(0);
    const queuedFiles = fs.readdirSync(pipelineCreationQueueDir());
    expect(queuedFiles).toEqual([`${answer.pipelineId}.admission`]);
    // Optional stage proof runs the captured previous release's actual reader
    // and writer against this fixture, including its visible native control.
    if (process.env.BOUNDED_LEGACY_SOURCE) {
      const child = Bun.spawn([process.execPath, "-e", `
        const fs = await import('node:fs'); const path = await import('node:path');
        const old = await import(path.join(process.env.BOUNDED_LEGACY_SOURCE,'src/lib/pipelines/creationQueue.ts'));
        const entry = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
        const control = {...entry.pipeline,id:'legacy-reader-control',creationRequest:{key:'legacy-reader-control',digest:'legacy-reader-control'}};
        const file = path.join(old.pipelineCreationQueueDir(),control.id+'.json');
        try {
          old.queuePipelineCreation(control,entry.target,true,'fixture control');
          const ids = old.listQueuedPipelineCreations().map(row=>row.pipeline.id);
          if (JSON.stringify(ids)!==JSON.stringify([control.id])) throw new Error('legacy reader consumed guarded work or missed its control');
          console.log(JSON.stringify({legacyVisible:ids,guardedVisible:false}));
        } finally { fs.rmSync(file,{force:true}); }
      `, path.join(pipelineCreationQueueDir(), queuedFiles[0]!)], { env: process.env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(code, stderr).toBe(0); console.info(stdout.trim());
    }
    fail.mockRestore();
    expect(await f.call("create_pipeline", { ...args, recoveryOnly: true })).toMatchObject({ ok: true, pipelineId: answer.pipelineId });
    gate.release(); await holder;
    expect((await admitQueuedPipelineCreations()).map(row => row.id)).toEqual([answer.pipelineId as string]);
    expect(fs.readdirSync(pipelineCreationQueueDir())).toEqual([]);
    expect(await admitQueuedPipelineCreations()).toHaveLength(0);
    expect(pipelineStore.loadPipelines().map(row => row.id)).toEqual([answer.pipelineId as string]);
  } finally { fail.mockRestore(); gate.release(); await holder; }
});

test("queue publication survives a lost admission witness and drains exactly once", async () => {
  const f = await fixture(true), gate = barrier();
  const holder = pipelineStore.withPipelineMutation(async () => { gate.enter(); await gate.held; }); await gate.ready;
  const original = pipelineAdmission.recordCreationAdmission;
  let dropped = false;
  const lostWitness = spyOn(pipelineAdmission, "recordCreationAdmission").mockImplementation((...args) => {
    if (!dropped && fs.existsSync(pipelineCreationQueueDir())
      && fs.readdirSync(pipelineCreationQueueDir()).some(name => name.endsWith(".admission"))) {
      dropped = true;
      throw new Error("fixture lost witness after queue publication");
    }
    return original(...args);
  });
  const args = { clientRequestId: "bounded-pipeline-witness-gap", task: "Recover queued admission", spec: "Recover queued admission", repoDir: f.root,
    src: f.source, autoStart: false, stages: [] };
  let answer: Record<string, unknown>;
  try { answer = await f.call("create_pipeline", args); }
  finally { lostWitness.mockRestore(); gate.release(); await holder; }
  expect(dropped).toBe(true);
  const files = fs.readdirSync(pipelineCreationQueueDir());
  expect(files).toEqual([expect.stringMatching(/\.admission$/)]);
  expect(answer!).toMatchObject({ ok: true, outcome: "settled", state: "queued" });
  const recovered = await f.call("create_pipeline", { ...args, recoveryOnly: true });
  const recoveredId = String(recovered.pipelineId);
  expect(recovered).toMatchObject({ ok: true, pipelineId: files[0]!.replace(/\.admission$/, "") });
  expect((await admitQueuedPipelineCreations()).map(row => row.id)).toEqual([recoveredId]);
  expect(await admitQueuedPipelineCreations()).toHaveLength(0);
  expect(pipelineStore.loadPipelines().map(row => row.id)).toEqual([recoveredId]);
});


test("empty suppressed owner pages advance and the receipt query uses its scope index", async () => {
  const f = await fixture();
  for (let n = 0; n < 101; n++) f.claim(n);
  const db = new (await import("bun:sqlite")).Database(f.store.filename);
  try {
    db.query("UPDATE mcp_receipts SET claimed_at=? WHERE receipt_key=?").run(Date.parse("2020-01-01T00:00:00Z"), "spawn_agent:fixture-claim-100");
    const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT sequence,receipt_key FROM mcp_receipts
      WHERE launch_project IN ('project') AND launch_target IN ('project') AND launch_owner='owner' AND launch_open=1 AND sequence>0 AND sequence<=1000 ORDER BY sequence LIMIT 100`).all();
    expect(plan.some(row => row.detail.includes("mcp_launch_owner"))).toBe(true);
  } finally { db.close(); }
  f.rotate();
  const first = await f.read({ limit: 1 });
  expect(first.items).toEqual([]); expect(first.nextCursor).toBeString();
  let page = first;
  for (let n = 0; n < 4 && !(page.items as unknown[]).length; n++) {
    expect(Number(page.scanned)).toBeLessThanOrEqual(100);
    page = await f.read({ limit: 1, cursor: page.nextCursor });
  }
  expect(page.items).toMatchObject([{ clientRequestId: "fixture-claim-100" }]);
});

test("a queued pipeline rechecks its original seat at the final awaited writer", async () => {
  const f = await fixture(true), busy = barrier();
  const holder = pipelineStore.withPipelineMutation(async () => { busy.enter(); await busy.held; }); await busy.ready;
  const args = { clientRequestId: "bounded-queue-seat", task: "Inspect deferred authority", spec: "Inspect deferred authority", repoDir: f.root,
    src: f.source, autoStart: false, stages: [] };
  let answer: Record<string, unknown>;
  try { answer = await f.call("create_pipeline", args); }
  finally { busy.release(); await holder; }
  expect(answer!).toMatchObject({ ok: true });
  const gate = barrier(), original = pipelineStore.createPipelineWithDelivery;
  const held = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementation(async (...args) => {
    gate.enter(); await gate.held; f.rotate(); return original(...args);
  });
  const drain = admitQueuedPipelineCreations();
  try {
    await Promise.race([gate.ready, drain.then(() => { throw new Error("queue did not reach its writer"); })]);
    gate.release();
    expect(await drain).toEqual([]);
    expect(pipelineStore.loadPipelines()).toHaveLength(0);
    expect(await admitQueuedPipelineCreations()).toHaveLength(0);
    expect(fs.readdirSync(pipelineCreationQueueDir())).toEqual([`${answer!.pipelineId}.admission.refused`]);
  } finally { gate.release(); await drain; held.mockRestore(); }
  // Freshly authorized work still reaches the same native writer.
  expect(await f.call("create_pipeline", { ...args, src: f.source, clientRequestId: "bounded-queue-current" })).toMatchObject({ ok: true });
  expect(pipelineStore.loadPipelines()).toHaveLength(1);
});

test("a guarded queue refuses a candidate already written by a different legacy creation", async () => {
  const f = await fixture(true), busy = barrier();
  const holder = pipelineStore.withPipelineMutation(async () => { busy.enter(); await busy.held; }); await busy.ready;
  let answer: Record<string, unknown>;
  try {
    answer = await f.call("create_pipeline", { clientRequestId: "bounded-queue-collision", task: "Inspect candidate ownership", spec: "Inspect candidate ownership",
      repoDir: f.root, src: f.source, autoStart: false, stages: [] });
  } finally { busy.release(); await holder; }
  expect(answer!).toMatchObject({ ok: true });
  const queued = listQueuedPipelineCreations()[0]!;
  const independent = structuredClone(queued.pipeline);
  independent.creationRequest = { key: "legacy-independent-creation", digest: "c".repeat(64) };
  await pipelineStore.createPipelineWithDelivery(independent, queued.target, false);
  expect(await admitQueuedPipelineCreations()).toEqual([]);
  expect(fs.readdirSync(pipelineCreationQueueDir())).toEqual([`${answer!.pipelineId}.admission.refused`]);
  expect(pipelineStore.findPipelineRecord(independent.id)?.creationRequest).toEqual(independent.creationRequest);
  expect(await admitQueuedPipelineCreations()).toEqual([]);
  expect(pipelineStore.loadPipelines()).toHaveLength(1);
});
