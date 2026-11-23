import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { AgentRegistry } from "@/lib/agent/registry";
import { structuredHostFixture } from "@/lib/agent/registryTestFixtures";
import { liveRootSession } from "@/lib/root/adopt";
import { attentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { resolveNativeCaller, type NativeCallerSources } from "@/lib/attention/nativeCaller";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { hostedConversationsFromSnapshot, attentionCallerSources, productionDomainDependencies, viewerMcpBindings, viewerMcpRecoverableTools, viewerMcpToolPolicy } from "./bindings";
import { runAsMcpHttpCaller } from "./callerContext";
import { nativePeerProof, verifyNativePeer } from "./nativePeer";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, MUTATING_MCP_TOOL_NAMES, type McpToolBindings } from "./server";
import crypto from "node:crypto";

const roots: string[] = [];
const registries: AgentRegistry[] = [];
afterEach(() => { for (const r of registries.splice(0)) r.close(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const capability = "A".repeat(43);
const digest = crypto.createHash("sha256").update(capability).digest("hex");
const stamp = "2026-10-18T00:00:00.000Z";
const id = "conversation_caller";
const session = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
const transcript = `/sessions/${session}.jsonl`;
const probe = { pidAlive: () => true, processIdentity: () => "42:original", bootEpoch: () => "boot-fixture" };

function fixture(history: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caller-resolution-")); roots.push(root);
  const filename = path.join(root, "registry.json"), sqliteFilename = path.join(root, "registry.sqlite");
  const initial = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename }); initial.close();
  const db = new Database(sqliteFilename);
  const conversation = { id, engine: "codex", accountId: null, createdAt: stamp, updatedAt: stamp,
    generations: [{ id: session, path: transcript, launchProfile: { role: "worker" } }], continuityPaths: [] };
  const host = { pid: 42, startIdentity: "42:original", bootEpoch: "boot-fixture" };
  const entry = { key: { engine: "codex", sessionId: session }, artifactPath: transcript, host: null, structuredHost: structuredHostFixture(host, "codex-app-server") };
  const put = db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES (?,?,?,?)");
  db.transaction(() => {
    put.run("conversations", id, JSON.stringify(conversation), 0);
    put.run("entries", `codex:${session}`, JSON.stringify(entry), 0);
    put.run("receipts", "caller-launch", JSON.stringify({ launchId: "caller-launch", conversationId: id, spawnCapabilityDigest: digest }), 0);
    for (let n = 1; n <= history; n++) {
      put.run("conversations", `conversation_history_${n}`, JSON.stringify({ ...conversation, id: `conversation_history_${n}`, generations: [] }), n);
      put.run("entries", `history:${n}`, JSON.stringify({ ...entry, artifactPath: `/history/${n}`, structuredHost: null }), n);
    }
  })(); db.close();
  let decoded = 0, read = 0;
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename,
    onSqliteRowPayloadRead: (_collection, count) => { read += count; },
    onSqliteRowPayloadParse: (_collection, count) => { decoded += count; } }); registries.push(registry);
  return { registry, sqliteFilename, reset: () => { decoded = 0; read = 0; }, count: () => decoded, reads: () => read };
}

test("one caller resolution serves a mutating tool's policy and binding", async () => {
  let resolutions = 0;
  const snapshot = fixture(0).registry.readOnlySnapshot();
  const dependencies = { ...productionDomainDependencies, registrySnapshot: () => snapshot,
    callerAttribution: () => { resolutions++; return { kind: "agent" as const, conversationId: id, role: "worker" }; } };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  const result = await service.callTool("update_task", { taskId: "task_missing", clientRequestId: "caller-count", text: "Fixture task" });
  expect(result.ok).toBe(false);
  expect(resolutions).toBe(1);
  await service.callTool("update_task", { taskId: "task_missing", clientRequestId: "caller-count-next", text: "Fixture task" });
  expect(resolutions).toBe(2);
});

test.skipIf(process.platform !== "linux")("an unwatchable retained host path leaves the Viewer available and native verification closed", async () => {
  const { prepareRegistryForNativeCallers } = await import("@/lib/viewerInstrumentation");
  const { registry, sqliteFilename } = fixture(0);
  const artifact = path.join(path.dirname(sqliteFilename), "native-caller.jsonl");
  fs.writeFileSync(artifact, "");
  const db = new Database(sqliteFilename);
  try {
    db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.engine','claude','$.generations[0].path',?) WHERE collection='conversations' AND row_key=?").run(artifact, id);
    db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.artifactPath',?) WHERE collection='entries' AND row_key=?")
      .run("/proc/self/fixture-host.jsonl", `codex:${session}`);
  } finally {
    db.close();
  }

  await prepareRegistryForNativeCallers(registry, new AbortController().signal);
  expect(registry.mcpNativeCallerSnapshot(session, null).snapshot).toMatchObject({ nativeHostsIncomplete: true });
});

test("every mutating tool resolves its policy caller once, including concurrent calls", async () => {
  const snapshot = fixture(0).registry.readOnlySnapshot();
  let resolutions = 0;
  const dependencies = { ...productionDomainDependencies, registrySnapshot: () => snapshot,
    callerAttribution: () => { resolutions++; return { kind: "agent" as const, conversationId: id, role: "worker" }; } };
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(tool => [tool, async () => ({})])) as unknown as McpToolBindings;
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  for (const tool of MUTATING_MCP_TOOL_NAMES) {
    resolutions = 0;
    await service.callTool(tool, { clientRequestId: `count-${tool}` });
    expect({ tool, resolutions }).toEqual({ tool, resolutions: 1 });
  }
  resolutions = 0;
  await Promise.all([service.callTool("update_task", { clientRequestId: "parallel-a" }), service.callTool("update_task", { clientRequestId: "parallel-b" })]);
  expect(resolutions).toBe(2);
});

test("HTTP capability attribution decodes the same rows with tenfold unrelated history, cold and warm", () => {
  const counts: number[] = [];
  for (const history of [10, 100]) {
    const f = fixture(history);
    for (let run = 0; run < 2; run++) {
      f.reset();
      const authority = runAsMcpHttpCaller({ capability }, () => attentionCallerAuthority(attentionCallerSources(f.registry, probe)));
      expect(authority).toEqual({ kind: "worker", conversationId: id, role: "worker" });
      counts.push(f.count());
    }
  }
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[2]).toBe(counts[0]);
  expect(counts[3]).toBe(counts[1]);
  expect(counts[0]).toBeLessThanOrEqual(5);
});

test("stored grant declarations do not expand caller identity reads into unrelated history", () => {
  const counts: number[] = [];
  for (const history of [10, 100]) {
    const f = fixture(history);
    const db = new Database(f.sqliteFilename);
    db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.launchProfile',json(?)) WHERE collection='receipts' AND row_key='caller-launch'")
      .run(JSON.stringify({ mcpServers: ["viewer", "connector-fixture"] }));
    db.close(); f.reset();
    const authority = runAsMcpHttpCaller({ capability }, () => attentionCallerAuthority(attentionCallerSources(f.registry, probe)));
    expect(authority).toEqual({ kind: "worker", conversationId: id, role: "worker" });
    counts.push(f.count());
  }
  expect(counts[0]).toBeLessThanOrEqual(5);
  expect(counts[1]).toBe(counts[0]);
});

test("targeted and enumerated authority agree for hostile capabilities and process identities", () => {
  const f = fixture(10);
  const other = "B".repeat(43);
  const db = new Database(f.sqliteFilename);
  db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('receipts','foreign',?,1)")
    .run(JSON.stringify({ conversationId: "conversation_history_1", spawnCapabilityDigest: crypto.createHash("sha256").update(other).digest("hex") }));
  db.close();
  for (const presented of [capability, other, "C".repeat(43)]) {
    for (const identity of ["42:original", "42:reused"]) {
      const currentProbe = { ...probe, processIdentity: () => identity };
      runAsMcpHttpCaller({ capability: presented }, () => {
        const sources = attentionCallerSources(f.registry, currentProbe, () => [42]);
        const old = { ...sources, hosted: () => hostedConversationsFromSnapshot(f.registry.readOnlySnapshot(), currentProbe) };
        expect(attentionCallerAuthority(sources)).toEqual(attentionCallerAuthority(old));
        if ((presented === other && identity === "42:original") || presented.startsWith("C")) expect(attentionCallerAuthority(sources).kind).toBe("unidentified");
      });
    }
  }
});

test("recovery refuses a native generation change after the production send binding", async () => {
  const f = fixture(0);
  let authority = { kind: "worker" as const, conversationId: id, role: "worker", nativeProof: "generation-a" };
  const dependencies = { ...productionDomainDependencies, registrySnapshot: () => f.registry.readOnlySnapshot(), attentionAuthority: () => authority };
  const recovery = viewerMcpRecoverableTools(dependencies);
  const originalBind = recovery.send_message!.bind!;
  recovery.send_message!.bind = async args => {
    const result = await originalBind(args);
    authority = { ...authority, nativeProof: "generation-b" };
    return result;
  };
  let claims = 0, dispatches = 0;
  const receipts = new MemoryMcpReceiptStore();
  const claim = receipts.claim.bind(receipts);
  receipts.claim = (...args) => { claims++; return claim(...args); };
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(tool => [tool, async () => ({})])) as unknown as McpToolBindings;
  bindings.send_message = async () => { dispatches++; return { operationId: "op_stale" }; };
  const service = createMcpToolService(bindings, receipts, undefined, { recovery });
  const result = await runAsMcpHttpCaller({ capability }, () => service.callTool("send_message", {
    clientRequestId: "native-generation-bind", conversationId: id, text: "fixture",
  }));
  expect(result).toMatchObject({ ok: false, code: "caller_unidentified" });
  expect({ claims, dispatches }).toEqual({ claims: 0, dispatches: 0 });
});

test("recovery discloses no receipt when native generation changes during receipt lookup", async () => {
  const f = fixture(0);
  let authority = { kind: "worker" as const, conversationId: id, role: "worker", nativeProof: "generation-a" };
  const dependencies = { ...productionDomainDependencies, registrySnapshot: () => f.registry.readOnlySnapshot(), attentionAuthority: () => authority };
  const receipts = new MemoryMcpReceiptStore();
  let dispatches = 0;
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(tool => [tool, async () => ({})])) as unknown as McpToolBindings;
  bindings.send_message = async () => { dispatches++; return { operationId: "op_receipt" }; };
  const service = createMcpToolService(bindings, receipts, undefined, { recovery: viewerMcpRecoverableTools(dependencies) });
  const args = { clientRequestId: "native-generation-receipt", conversationId: id, text: "fixture" };
  expect(await runAsMcpHttpCaller({ capability }, () => service.callTool("send_message", args))).toMatchObject({ ok: true });
  const lookup = receipts.lookup.bind(receipts);
  receipts.lookup = key => {
    const row = lookup(key);
    authority = { ...authority, nativeProof: "generation-b" };
    return row;
  };
  const result = await runAsMcpHttpCaller({ capability }, () => service.callTool("send_message", { ...args, recoveryOnly: true }));
  expect(result).toMatchObject({ ok: false, code: "caller_unidentified" });
  expect(JSON.stringify(result)).not.toContain("op_receipt");
  expect(dispatches).toBe(1);
});


test("a stale generation cannot hide a conflicting live ancestor", () => {
  const f = fixture(10);
  const db = new Database(f.sqliteFilename);
  db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json(?)) WHERE collection='conversations' AND row_key=?")
    .run(JSON.stringify([{ id: session, path: transcript, launchProfile: { role: "worker" } }]), "conversation_history_1");
  db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json('[]')) WHERE collection='conversations' AND row_key=?").run(id);
  db.close();
  for (const identity of ["42:original", "42:reused"]) {
    runAsMcpHttpCaller({ capability }, () => {
      const currentProbe = { ...probe, processIdentity: () => identity };
      const sources = attentionCallerSources(f.registry, currentProbe, () => [42]);
      const snapshot = f.registry.readOnlySnapshot();
      const old = { ...sources, hosted: () => hostedConversationsFromSnapshot(snapshot, currentProbe) };
      if (identity === "42:original") {
        expect(attentionCallerAuthority(old)).toMatchObject({ kind: "unidentified", admission: { reason: "capability-conflict" } });
      }
      expect(attentionCallerAuthority(sources)).toEqual(attentionCallerAuthority(old));
    });
  }
});

test("an ancestry entry with a stale generation key still conflicts with a foreign capability", () => {
  const f = fixture(10);
  const staleSession = "stale-session-two";
  const db = new Database(f.sqliteFilename);
  db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json('[]')) WHERE collection='conversations' AND row_key=?").run(id);
  db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json(?)) WHERE collection='conversations' AND row_key='conversation_history_1'")
    .run(JSON.stringify([{ id: staleSession, path: transcript, launchProfile: { role: "worker" } }]));
  db.close();
  runAsMcpHttpCaller({ capability }, () => {
    const sources = attentionCallerSources(f.registry, probe, () => [42]);
    const old = { ...sources, hosted: () => hostedConversationsFromSnapshot(f.registry.readOnlySnapshot(), probe) };
    expect(attentionCallerAuthority(old)).toMatchObject({ kind: "unidentified", admission: { reason: "capability-conflict" } });
    expect(attentionCallerAuthority(sources)).toEqual(attentionCallerAuthority(old));
  });
});

test("credentialless calls inspect only the ancestry cohort as unrelated history grows", () => {
  for (const history of [10, 1000]) {
    const f = fixture(history);
    const full = f.registry.readOnlySnapshot();
    const expected = attentionCallerAuthority({
      ancestry: () => [42], hosted: () => hostedConversationsFromSnapshot(full, probe), rootConversationId: () => null,
    });
    expect(expected).toEqual({ kind: "worker", conversationId: id, role: "worker" });
    f.registry.readOnlySnapshot = () => { throw new Error("caller resolution opened the whole registry"); };
    for (let run = 0; run < 2; run++) {
      f.reset();
      const legacy = runAsMcpHttpCaller({}, () => attentionCallerAuthority(attentionCallerSources(f.registry, probe, () => [42])));
      expect(legacy).toEqual(expected);
      expect(f.count()).toBeLessThanOrEqual(2);
    }
    const miss = runAsMcpHttpCaller({}, () => attentionCallerAuthority(attentionCallerSources(f.registry, probe)));
    expect(miss).toMatchObject({ kind: "unidentified", admission: { reason: "no-claude-ancestor" } });
  }
});

test.skipIf(process.platform !== "linux")("a shared transcript path gives neither of its live ancestry owners authority", async () => {
  const f = fixture(1);
  const peer = captureProcessIdentity(process.pid);
  const db = new Database(f.sqliteFilename);
  const other = "conversation_history_1";
  db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost',json(?)) WHERE collection='entries' AND row_key=?")
    .run(JSON.stringify(structuredHostFixture(peer, "codex-app-server")), `codex:${session}`);
  const body = JSON.stringify({ name: "list_tasks", arguments: {} });
  const proof = await nativePeerProof(body);
  const prior = process.env.LLV_SPAWN_CAPABILITY;
  delete process.env.LLV_SPAWN_CAPABILITY;
  try {
    const verified = await verifyNativePeer(proof.header, body);
    const stdio = () => attentionCallerAuthority(attentionCallerSources(f.registry));
    const http = () => runAsMcpHttpCaller({ nativePeer: verified }, stdio);
    const authority = { kind: "worker", conversationId: id, role: "worker" } as const;
    expect(stdio()).toEqual(authority);
    expect(http()).toEqual(authority);
    db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json(?)) WHERE collection='conversations' AND row_key=?")
      .run(JSON.stringify([{ id: "retained-generation", path: transcript, launchProfile: { role: "root" } }]), other);
    const order = db.query("UPDATE registry_rows SET row_order=? WHERE collection='conversations' AND row_key=?");
    for (const first of [0, 1]) {
      order.run(first, id);
      order.run(1 - first, other);
      for (const call of [stdio, http]) {
        expect(call()).toMatchObject({ kind: "unidentified", admission: { reason: "ancestry-ambiguous" } });
      }
      let probes = 0;
      const changingProbe = {
        pidAlive: () => true, bootEpoch: () => peer.bootEpoch ?? null,
        processIdentity: () => ++probes === 1 ? peer.startIdentity : null,
      };
      expect(attentionCallerAuthority(attentionCallerSources(f.registry, changingProbe, () => [peer.pid])))
        .toMatchObject({ kind: "unidentified", admission: { reason: "ancestry-ambiguous" } });
      expect(probes).toBe(1);
    }
    db.query("DELETE FROM registry_rows WHERE collection='conversations' AND row_key=?").run(other);
    expect(http()).toEqual(authority);
  } finally {
    if (prior === undefined) delete process.env.LLV_SPAWN_CAPABILITY;
    else process.env.LLV_SPAWN_CAPABILITY = prior;
    db.close();
    proof.close();
  }
});

test.skipIf(process.platform !== "linux")("approved native generations read only their key and matching host artifacts", async () => {
  for (const history of [10, 1000]) {
    const f = fixture(history);
    const home = path.dirname(f.sqliteFilename);
    const projectsDir = path.join(home, "projects");
    const nativePath = path.join(projectsDir, `${session}.jsonl`);
    const alias = path.join(home, "host-alias.jsonl");
    const unrelated = path.join(home, "unrelated.jsonl");
    fs.mkdirSync(projectsDir);
    fs.writeFileSync(nativePath, "");
    fs.writeFileSync(unrelated, "");
    const db = new Database(f.sqliteFilename);
    try {
      const nativeId = "conversation_external";
      const row = { id: nativeId, engine: "claude", updatedAt: stamp,
        generations: [{ id: session, path: nativePath, archivedAt: null, launchProfile: { role: "worker" } }] };
      const put = db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('conversations',?,?,?)");
      put.run(nativeId, JSON.stringify(row), history + 1);
      let retiredKey: string | undefined;
      let releasedResumeKey: string | undefined;
      if (history > 256) {
        const key = { engine: "codex" as const, sessionId: "retained-domain-0" };
        const identity = (pid: number) => ({ pid, startIdentity: `${pid}:fixture`, bootEpoch: "fixture-boot" });
        const domain = {
          policyVersion: 1 as const, monitor: identity(2_147_483_600), bubblewrap: identity(2_147_483_601),
          init: identity(2_147_483_602), native: identity(2_147_483_603),
          pidNamespace: "pid:[101]", userNamespace: "user:[102]", scope: "/fixture/retained.scope", directory: home,
        };
        f.registry.upsert({
          key, artifactPath: unrelated, cwd: home, accountId: null,
          status: "idle", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null,
          structuredHost: { ...structuredHostFixture(domain.native, "codex-app-server"), exitProcess: domain.native, signalDomain: domain },
        });
        expect(f.registry.terminateStructuredHost(key, domain.native)).toBe(true);
        retiredKey = `codex:${key.sessionId}`;
        const stored = db.query<{ value_json: string }, [string]>(
          "SELECT value_json FROM registry_rows WHERE collection='entries' AND row_key=?").get(retiredKey)!;
        const retired = JSON.parse(stored.value_json);
        expect(retired).toMatchObject({ status: "dead", structuredHost: { endpoint: "stdio:released", process: null, signalDomain: { retired: true } } });

        const resumeSession = ["00000000", "0000", "4000", "8000", "000000000002"].join("-");
        const resumePath = path.join(home, `${resumeSession}.jsonl`);
        const resume = f.registry.ensureConversation("codex", resumePath, "fixture");
        const resumeKey = { engine: "codex" as const, sessionId: resume.generations[0]!.id };
        const spawn = f.registry.beginSpawnRequest({
          engine: "codex", cwd: home, accountId: "fixture", transport: "structured", conversationId: resume.id,
          purpose: "resume-successor", expectedArtifactPath: resumePath, launchProfile: { cwd: home, title: "Fixture resume" },
        });
        if (spawn.kind !== "created") throw new Error("fixture did not reserve the resume");
        const staged = f.registry.stageStructuredSpawn(spawn.receipt.launchId, {
          key: resumeKey, artifactPath: resumePath, cwd: home, accountId: "fixture", status: "idle",
          host: null, claimEpoch: 1, claimOwner: null, pendingAction: "spawn",
          structuredHost: { ...structuredHostFixture(null, "codex-app-server"), eventCursor: 1 },
        });
        expect(staged.kind).toBe("settled");
        expect(f.registry.failStructuredSpawn(spawn.receipt.launchId, "fixture resume failed", { announce: false }).claimed).toBe(true);
        releasedResumeKey = `codex:${resumeKey.sessionId}`;
        const released = JSON.parse(db.query<{ value_json: string }, [string]>(
          "SELECT value_json FROM registry_rows WHERE collection='entries' AND row_key=?").get(releasedResumeKey)!.value_json);
        expect(released).toMatchObject({ status: "dead", host: null, claimOwner: null, pendingAction: null,
          structuredHost: { endpoint: "stdio:released", process: null, eventCursor: 1 } });
        expect(released.structuredHost.signalDomain).toBeUndefined();

        const memory = { mechanism: "scope", limitBytes: 1024, unit: "delegatus-agent-fixture.scope", kills: 0, lastKill: null };
        const exit = { pid: 42, startIdentity: "42:retained", bootEpoch: "fixture-boot" };
        const profiles = [
          { count: 1300, row: { ...retired, structuredHost: { ...retired.structuredHost, memory } } },
          { count: 1050, row: { ...released, hostExitProcess: exit, structuredHost: { ...released.structuredHost, exitProcess: exit } } },
          { count: 800, row: { ...retired, hostExitProcess: exit, structuredHost: { ...retired.structuredHost, memory } } },
          { count: 450, row: { ...released, structuredHost: { ...released.structuredHost, memory } } },
        ];
        const insert = db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('entries',?,?,?)");
        db.transaction(() => {
          let rowOrder = history + 10;
          for (const [profile, { count, row }] of profiles.entries()) {
            for (let n = 0; n < count; n++) {
              const sessionId = `retained-profile-${profile}-${n}`;
              insert.run(`codex:${sessionId}`, JSON.stringify({ ...row, key: { ...key, sessionId },
                artifactPath: path.join(home, "retained", `${sessionId}.jsonl`) }), rowOrder++);
            }
          }
        })();
      }
      f.registry.readOnlySnapshot = () => { throw new Error("native authority opened the whole registry"); };
      let realpaths = 0;
      let checkedGenerations = 0;
      const sources: NativeCallerSources = {
        platform: "linux", ancestry: () => [99, 42], isClaude: pid => pid === 42,
        hostStamp: () => null, home: () => home, accounts: () => [{ home, projectsDir }],
        realpath: file => { realpaths++; try { return fs.realpathSync(file); } catch { return null; } },
        record: () => ({ kind: "record", value: { pid: 42, sessionId: session, procStart: "100", pidDomain: "fixture-domain", startedAt: 11_000, kind: "interactive" } }),
        identity: () => "42:100", domain: () => "fixture-domain", bootTime: () => 10_000, processStartedAt: () => 11_000,
        sessionHeldElsewhere: () => false, cwd: () => home,
        snapshot: sessionId => f.registry.mcpNativeCallerSnapshot(sessionId, null).snapshot,
        generationProof: () => { checkedGenerations++; return "fixture-generation"; },
        association: () => ({ status: "approved", proof: "fixture-approved" }), hostStatus: () => "alive",
      };
      const admitted = { kind: "admitted", conversationId: nativeId, proof: "fixture-approved" } as const;
      await f.registry.prepareNativeCallerArtifacts();
      for (let run = 0; run < 2; run++) {
        f.reset(); realpaths = 0; checkedGenerations = 0;
        expect(resolveNativeCaller(sources)).toEqual(admitted);
        expect(f.reads()).toBe(1);
        expect(realpaths).toBe(4);
        expect(checkedGenerations).toBe(3);
      }
      if (retiredKey && releasedResumeKey) {
        expect(f.registry.archiveInactiveRows(5000)).toBeGreaterThanOrEqual(3602);
        const archived = db.query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM registry_cold WHERE collection='entries' AND row_key LIKE ?");
        expect(archived.get("codex:retained-profile-%")?.count).toBe(3600);
        expect(archived.get(releasedResumeKey)?.count).toBe(1);
        f.reset(); realpaths = 0;
        // Another process can keep changing unrelated directory entries.
        // Deliver unrelated events before every kernel queue read, even
        // between preparation and the synchronous caller check.
        let noise = path.join(home, "unrelated-noise");
        fs.writeFileSync(noise, "");
        const read = fs.readSync;
        const churn = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof read>) => {
          if (fs.readlinkSync(`/proc/self/fd/${args[0]}`) === "anon_inode:inotify") {
            const moved = noise.endsWith("-moved") ? noise.slice(0, -6) : noise + "-moved";
            fs.renameSync(noise, moved);
            noise = moved;
          }
          return Reflect.apply(read, fs, args);
        }) as typeof read);
        try { expect(resolveNativeCaller(sources)).toEqual(admitted); }
        finally { churn.mockRestore(); }
        expect(f.reads()).toBe(1);
        expect(realpaths).toBe(4);
        // A path indexed as missing can become a matching alias between calls.
        // Only the filesystem changes here. The row stays archived.
        const retained = path.join(home, "retained");
        fs.mkdirSync(retained);
        const committedAlias = path.join(retained, "retained-profile-1-0.jsonl");
        const aliasTarget = path.join(home, "alias-target.jsonl");
        fs.symlinkSync(nativePath, aliasTarget);
        fs.symlinkSync("../alias-target.jsonl", committedAlias);
        await f.registry.prepareNativeCallerArtifacts();
        expect(resolveNativeCaller(sources)).toMatchObject({ kind: "refused", reason: "generation-hosted" });
        fs.unlinkSync(aliasTarget);
        fs.symlinkSync(unrelated, aliasTarget);
        expect(resolveNativeCaller(sources)).toEqual(admitted);
        // A new claim or pending spawn makes either released row relevant.
        fs.symlinkSync(nativePath, alias);
        const claim = db.query(`UPDATE registry_rows SET value_json=json_set(value_json,'$.artifactPath',?,'$.claimOwner',?,'$.pendingAction',?)
          WHERE collection='entries' AND row_key=?`);
        for (const rowKey of [retiredKey, releasedResumeKey]) {
          claim.run(alias, "fixture-replacement-claim", null, rowKey);
          expect(resolveNativeCaller(sources)).toMatchObject({ kind: "refused", reason: "generation-hosted" });
          claim.run(alias, null, "spawn", rowKey);
          expect(resolveNativeCaller(sources)).toMatchObject({ kind: "refused", reason: "generation-hosted" });
          claim.run(unrelated, null, null, rowKey);
          expect(resolveNativeCaller(sources)).toEqual(admitted);
        }
        const keepExit = db.query(`UPDATE registry_rows SET value_json=json_set(value_json,'$.artifactPath',?,?,json(?))
          WHERE collection='entries' AND row_key=?`);
        const clearExit = db.query(`UPDATE registry_rows SET value_json=json_remove(json_set(value_json,'$.artifactPath',?),?)
          WHERE collection='entries' AND row_key=?`);
        const exitProcess = { pid: 42, startIdentity: "42:original", bootEpoch: "boot-fixture" };
        for (const [field, value] of [
          ["$.structuredHost.exitProcess", exitProcess],
          ["$.hostExitProcess", exitProcess],
          ["$.pendingHostExits", [{ process: exitProcess, launchId: null }]],
        ] as const) {
          keepExit.run(alias, field, JSON.stringify(value), releasedResumeKey);
          expect(resolveNativeCaller(sources)).toMatchObject({ kind: "refused", reason: "generation-hosted" });
          clearExit.run(unrelated, field, releasedResumeKey);
          expect(resolveNativeCaller(sources)).toEqual(admitted);
        }
        fs.unlinkSync(alias);
      }

      fs.symlinkSync(nativePath, alias);
      db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.artifactPath',?) WHERE collection='entries' AND row_key=?")
        .run(alias, `codex:${session}`);
      expect(resolveNativeCaller(sources)).toMatchObject({ kind: "refused", reason: "generation-hosted" });
      db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost.process',json('null')) WHERE collection='entries' AND row_key=?")
        .run(`codex:${session}`);
      expect(resolveNativeCaller(sources)).toMatchObject({ kind: "refused", reason: "generation-hosted" });
      fs.unlinkSync(alias);
      fs.symlinkSync(unrelated, alias);
      expect(resolveNativeCaller(sources)).toEqual(admitted);

      const duplicate = "conversation_external_duplicate";
      put.run(duplicate, JSON.stringify({ ...row, id: duplicate }), history + 2);
      expect(resolveNativeCaller(sources)).toMatchObject({ kind: "refused", reason: "generation-ambiguous" });
      db.query("DELETE FROM registry_rows WHERE collection='conversations' AND row_key=?").run(duplicate);
      expect(resolveNativeCaller(sources)).toEqual(admitted);
      if (history > 256) {
        db.query(`UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost',json(?),'$.artifactPath',?)
          WHERE collection='entries' AND row_key LIKE 'history:%'`).run(JSON.stringify(structuredHostFixture(null)), nativePath);
        realpaths = 0;
        expect(resolveNativeCaller(sources)).toMatchObject({ kind: "refused", reason: "generation-hosted" });
        expect(realpaths).toBe(4);
      }
    } finally {
      db.close();
    }
  }
}, 30_000);

test("ancestry attributes a retained scope's exit identity without crossing engine namespaces", () => {
  const f = fixture(10);
  const db = new Database(f.sqliteFilename);
  const other = "conversation_history_1";
  db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.engine','claude','$.generations',json(?)) WHERE collection='conversations' AND row_key=?")
    .run(JSON.stringify([{ id: session, path: `/claude/${session}.jsonl`, launchProfile: { role: "reviewer" } }]), other);
  db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost',json(?)) WHERE collection='entries' AND row_key=?")
    .run(JSON.stringify({
      ...structuredHostFixture(null, "codex-app-server"),
      exitProcess: { pid: 42, startIdentity: "42:original", bootEpoch: "boot-fixture" },
      scope: { unit: "delegatus-agent-fixture.scope", bootEpoch: "boot-fixture" },
    }), `codex:${session}`);
  db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES ('entries',?,?,?)").run(
    `claude:${session}`, JSON.stringify({ key: { engine: "claude", sessionId: session }, artifactPath: `/claude/${session}.jsonl`,
      structuredHost: structuredHostFixture({ pid: 44, startIdentity: "44:original", bootEpoch: "boot-fixture" }) }), 11);
  db.close();
  const probes = { ...probe, processIdentity: (pid: number) => `${pid}:original` };
  for (const [pid, conversationId, role] of [[42, id, "worker"], [44, other, "reviewer"]] as const) {
    const sources = () => attentionCallerSources(f.registry, probes, () => [pid]);
    runAsMcpHttpCaller({}, () => {
      const old = { ...sources(), hosted: () => hostedConversationsFromSnapshot(f.registry.readOnlySnapshot(), probes) };
      const expected = { kind: "worker", conversationId, role } as const;
      expect(attentionCallerAuthority(old)).toEqual(expected);
      expect(attentionCallerAuthority(sources())).toEqual(expected);
    });
  }
  runAsMcpHttpCaller({ capability }, () => {
    expect(attentionCallerAuthority(attentionCallerSources(f.registry, probes, () => [44, 42])))
      .toMatchObject({ kind: "unidentified", admission: { reason: "capability-conflict" } });
  });
  const peer = new Database(f.sqliteFilename);
  peer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost.process.pid',42,'$.structuredHost.process.startIdentity','42:original') WHERE collection='entries' AND row_key=?")
    .run(`claude:${session}`);
  peer.close();
  for (const token of [undefined, capability]) {
    const conflict = runAsMcpHttpCaller({ capability: token }, () => attentionCallerAuthority(attentionCallerSources(f.registry, probes, () => [42])));
    expect(conflict).toMatchObject({ kind: "unidentified", admission: { reason: "ancestry-ambiguous" } });
  }
});

test.each(["pid", "path"])("an oversized %s cohort refuses instead of trusting partial ancestry", (kind) => {
  const f = fixture(257);
  const db = new Database(f.sqliteFilename);
  if (kind === "pid") {
    db.query(`UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost',json(?))
      WHERE collection='entries' AND row_key LIKE 'history:%'`).run(
      JSON.stringify(structuredHostFixture({ pid: 42, startIdentity: "42:original", bootEpoch: "boot-fixture" })),
    );
  } else {
    db.query(`UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json(?))
      WHERE collection='conversations' AND row_key LIKE 'conversation_history_%'`)
      .run(JSON.stringify([{ id: session, path: transcript, launchProfile: { role: "worker" } }]));
  }
  db.close();
  f.registry.readOnlySnapshot = () => { throw new Error("oversized ancestry fell back to a full registry"); };
  for (const token of [undefined, capability]) {
    f.reset();
    const refusal = runAsMcpHttpCaller({ capability: token }, () => attentionCallerAuthority(attentionCallerSources(f.registry, probe, () => [42])));
    expect(refusal).toMatchObject({ kind: "unidentified", admission: { reason: "ancestry-ambiguous", retryable: false } });
    expect(f.count()).toBeLessThanOrEqual(1);
  }
});

test("root ordering and configured-root precedence survive peer writes and reopen", () => {
  const f = fixture(10);
  const db = new Database(f.sqliteFilename);
  const update = (key: string, role: string, updated: string) => db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json(?),'$.updatedAt',?) WHERE collection='conversations' AND row_key=?")
    .run(JSON.stringify([{ id: session, path: `/root/${key}`, launchProfile: { role } }, { id: session, path: `/legacy/${key}`, launchProfile: { role } }]), updated, key);
  update(id, "root", stamp);
  expect(f.registry.mcpCallerSnapshot(id, [], null).rootConversationId).toBe(id);
  update("conversation_history_1", "root", "2026-10-19T00:00:00.000Z");
  expect(f.registry.mcpCallerSnapshot(id, [], null).rootConversationId).toBe("conversation_history_1");
  expect(f.registry.mcpCallerSnapshot(id, [], id).rootConversationId).toBe(id);
  expect(f.registry.mcpCallerSnapshot(id, [], "missing").rootConversationId).toBe("conversation_history_1");
  update("conversation_history_1", "worker", "2026-10-19T00:00:00.000Z");
  expect(f.registry.mcpCallerSnapshot(id, [], null).rootConversationId).toBe(id);
  db.query("DELETE FROM registry_rows WHERE collection='conversations' AND row_key=?").run(id);
  expect(f.registry.mcpCallerSnapshot(id, [], null).rootConversationId).toBeNull();
  db.close();
  f.registry.close();
  const reopened = new AgentRegistry(f.registry.filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: f.sqliteFilename }); registries.push(reopened);
  expect(reopened.mcpCallerSnapshot(id, [], null).rootConversationId).toBeNull();
});

test("a roleless newest generation defaults to worker in root authority selection", () => {
  const f = fixture(10);
  const db = new Database(f.sqliteFilename);
  db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json(?)) WHERE collection='conversations' AND row_key=?")
    .run(JSON.stringify([
      { id: session, path: `/root/${id}`, launchProfile: { role: "root" } },
      { id: "legacy-generation-three", path: `/legacy/${id}` },
    ]), id);
  db.close();
  const priorRoot = process.env.LLV_ROOT_CONVERSATION_ID;
  delete process.env.LLV_ROOT_CONVERSATION_ID;
  try {
    const expectParity = (registry: AgentRegistry) => runAsMcpHttpCaller({ capability }, () => {
      const sources = attentionCallerSources(registry, probe, () => []);
      const snapshot = registry.readOnlySnapshot();
      const old = { ...sources,
        hosted: () => hostedConversationsFromSnapshot(snapshot, probe),
        rootConversationId: () => liveRootSession({ conversations: Object.values(snapshot.conversations), configuredRootId: null })?.conversationId ?? null,
      };
      expect(attentionCallerAuthority(sources)).toEqual(attentionCallerAuthority(old));
      return attentionCallerAuthority(old);
    });
    expect(expectParity(f.registry)).toEqual({ kind: "worker", conversationId: id, role: "worker" });

    const peer = new Database(f.sqliteFilename);
    peer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json(?)) WHERE collection='conversations' AND row_key=?")
      .run(JSON.stringify([
        { id: session, path: `/root/${id}`, launchProfile: { role: "root" } },
        { id: "legacy-generation-three", path: `/next/${id}`, launchProfile: { role: "root" } },
      ]), id);
    peer.close();
    expect(expectParity(f.registry)).toEqual({ kind: "root", conversationId: id });

    const legacyPeer = new Database(f.sqliteFilename);
    legacyPeer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations',json(?)) WHERE collection='conversations' AND row_key=?")
      .run(JSON.stringify([
        { id: session, path: `/root/${id}`, launchProfile: { role: "root" } },
        { id: "legacy-generation-four", path: `/legacy/${id}` },
      ]), id);
    legacyPeer.query("UPDATE registry_meta SET value='1' WHERE key='caller_indexes_version'").run();
    legacyPeer.close();
    expect(expectParity(f.registry)).toEqual({ kind: "worker", conversationId: id, role: "worker" });

    f.registry.close();
    const reopened = new AgentRegistry(f.registry.filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: f.sqliteFilename });
    registries.push(reopened);
    expect(expectParity(reopened)).toEqual({ kind: "worker", conversationId: id, role: "worker" });
  } finally {
    if (priorRoot === undefined) delete process.env.LLV_ROOT_CONVERSATION_ID;
    else process.env.LLV_ROOT_CONVERSATION_ID = priorRoot;
  }
});

test("ancestry and root selectors use scoped indexes", () => {
  const f = fixture(100);
  const db = new Database(f.sqliteFilename);
  for (const field of ["structuredHost.process.pid"]) {
    const plan = db.query(`EXPLAIN QUERY PLAN SELECT json_extract(value_json,'$.artifactPath') AS path FROM registry_rows WHERE collection='entries' AND json_extract(value_json,'$.${field}')=? ORDER BY row_order`).all(42);
    expect(JSON.stringify(plan)).toContain("registry_caller_structured_pid");
    expect(JSON.stringify(plan)).not.toContain("SCAN registry_rows");
  }
  expect(JSON.stringify(db.query("EXPLAIN QUERY PLAN SELECT conversation_id FROM registry_caller_roots ORDER BY updated_at DESC,row_order DESC LIMIT 1").all())).toContain("registry_caller_roots_latest");
  db.close();
});

test("credentialless authority follows peer writes, process custody, and restart", async () => {
  const f = fixture(10);
  const driver = path.join(path.dirname(f.registry.filename), "legacy-memo.ts");
  fs.writeFileSync(driver, `
    import { Database } from "bun:sqlite";
    import { AgentRegistry } from ${JSON.stringify(path.resolve("src/lib/agent/registry.ts"))};
    import { attentionCallerSources } from ${JSON.stringify(path.resolve("src/lib/mcp/bindings.ts"))};
    import { attentionCallerAuthority } from ${JSON.stringify(path.resolve("src/lib/attention/callerAuthority.ts"))};
    import { runAsMcpHttpCaller } from ${JSON.stringify(path.resolve("src/lib/mcp/callerContext.ts"))};
    const r = new AgentRegistry(process.argv[2], undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: process.argv[3] });
    r.readOnlySnapshot = () => { throw new Error("credentialless authority opened the whole registry"); };
    let bootEpoch = "boot-fixture", identity = "42:original", alive = true, callerPid = 42;
    const probe = { pidAlive: () => alive, processIdentity: () => identity, bootEpoch: () => bootEpoch };
    const read = () => runAsMcpHttpCaller({}, () => attentionCallerAuthority(attentionCallerSources(r, probe, () => [callerPid])));
    const assert = (kind, role) => {
      const actual = read();
      if (actual.kind !== kind || actual.role !== role) throw new Error(JSON.stringify(actual));
    };
    if (process.argv[4] === "reopen") {
      callerPid = 43; identity = "43:replacement";
      assert("worker", "reviewer");
    } else {
      assert("worker", "worker");
      assert("worker", "worker");
      alive = false; assert("unidentified"); alive = true;
      identity = "42:reused"; assert("unidentified"); identity = "42:original";
      bootEpoch = "boot-next"; assert("unidentified"); bootEpoch = "boot-fixture";
      const writer = new Database(process.argv[3]);
      const role = writer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.generations[0].launchProfile.role',?) WHERE collection='conversations' AND row_key='conversation_caller'");
      role.run("root"); assert("root");
      role.run("reviewer"); assert("worker", "reviewer");
      writer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost.process.pid',43,'$.structuredHost.process.startIdentity','43:replacement') WHERE collection='entries' AND row_order=0").run();
      assert("unidentified");
      callerPid = 43; identity = "43:replacement"; assert("worker", "reviewer");
      writer.close();
    }
    r.close();
    console.log("identity-ok");
  `);
  for (const mode of ["initial", "reopen"]) {
    const child = Bun.spawn([process.execPath, driver, f.registry.filename, f.sqliteFilename, mode], {
      env: { ...process.env, LLV_STATE_DIR: path.dirname(driver), LLV_SPAWN_CAPABILITY: undefined, LLV_ROOT_CONVERSATION_ID: undefined }, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout.trim()).toBe("identity-ok");
  }
});
