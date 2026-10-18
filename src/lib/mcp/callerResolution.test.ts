import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { AgentRegistry } from "@/lib/agent/registry";
import { liveRootSession } from "@/lib/root/adopt";
import { attentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { hostedConversationsFromSnapshot, attentionCallerSources, productionDomainDependencies, viewerMcpBindings, viewerMcpRecoverableTools, viewerMcpToolPolicy } from "./bindings";
import { runAsMcpHttpCaller } from "./callerContext";
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
  const entry = { key: { engine: "codex", sessionId: session }, artifactPath: transcript, host: { kind: "tmux", agent: host }, structuredHost: null };
  const put = db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES (?,?,?,?)");
  db.transaction(() => {
    put.run("conversations", id, JSON.stringify(conversation), 0);
    put.run("entries", `codex:${session}`, JSON.stringify(entry), 0);
    put.run("receipts", "caller-launch", JSON.stringify({ launchId: "caller-launch", conversationId: id, spawnCapabilityDigest: digest }), 0);
    for (let n = 1; n <= history; n++) {
      put.run("conversations", `conversation_history_${n}`, JSON.stringify({ ...conversation, id: `conversation_history_${n}`, generations: [] }), n);
      put.run("entries", `history:${n}`, JSON.stringify({ ...entry, artifactPath: `/history/${n}`, host: null }), n);
    }
  })(); db.close();
  let decoded = 0;
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename,
    onSqliteRowPayloadParse: (_collection, count) => { decoded += count; } }); registries.push(registry);
  return { registry, sqliteFilename, reset: () => { decoded = 0; }, count: () => decoded };
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
  receipts.claim = async (...args) => { claims++; return claim(...args); };
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
  receipts.lookup = async key => {
    const row = await lookup(key);
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
  for (const field of ["host.agent.pid", "structuredHost.process.pid"]) {
    const plan = db.query(`EXPLAIN QUERY PLAN SELECT json_extract(value_json,'$.artifactPath') AS path FROM registry_rows WHERE collection='entries' AND json_extract(value_json,'$.${field}')=? ORDER BY row_order`).all(42);
    expect(JSON.stringify(plan)).toContain(field.startsWith("host.") ? "registry_caller_agent_pid" : "registry_caller_structured_pid");
    expect(JSON.stringify(plan)).not.toContain("SCAN registry_rows");
  }
  expect(JSON.stringify(db.query("EXPLAIN QUERY PLAN SELECT conversation_id FROM registry_caller_roots ORDER BY updated_at DESC,row_order DESC LIMIT 1").all())).toContain("registry_caller_roots_latest");
  db.close();
});

test("legacy enumeration memo belongs to one snapshot and boot, and resets in a fresh process", async () => {
  const f = fixture(10);
  const driver = path.join(path.dirname(f.registry.filename), "legacy-memo.ts");
  fs.writeFileSync(driver, `
    import { Database } from "bun:sqlite";
    import { AgentRegistry } from ${JSON.stringify(path.resolve("src/lib/agent/registry.ts"))};
    import { attentionCallerSources } from ${JSON.stringify(path.resolve("src/lib/mcp/bindings.ts"))};
    import { performanceSpans, performanceSites } from ${JSON.stringify(path.resolve("src/lib/performanceSpans.ts"))};
    const r = new AgentRegistry(process.argv[2], undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: process.argv[3] });
    delete process.env.LLV_SPAWN_CAPABILITY;
    let boot = "boot-fixture", identity = "42:original", enumerations = 0;
    const probe = { pidAlive: () => true, processIdentity: () => identity, bootEpoch: () => boot };
    const site = performanceSites.indexOf("mcp.caller-enumeration");
    performanceSpans.observeSite(value => { if (value === site) enumerations++; });
    const read = () => attentionCallerSources(r, probe, () => [42]).hosted();
    const counts = [];
    counts.push(read().find(c => c.conversationId === "conversation_caller").pids.length);
    read();
    if (enumerations !== 1) throw new Error("legacy memo missed");
    identity = "42:reused";
    counts.push(read().find(c => c.conversationId === "conversation_caller").pids.length);
    if (enumerations !== 1 || counts.join() !== "1,0") throw new Error("memo trusted a reused PID");
    boot = "boot-next"; read();
    if (enumerations !== 2) throw new Error("boot did not invalidate");
    const writer = new Database(process.argv[3]);
    writer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.fixtureRevision',COALESCE(json_extract(value_json,'$.fixtureRevision'),0)+1) WHERE collection='conversations' AND row_key='conversation_caller'").run();
    writer.close();
    read();
    if (enumerations !== 3) throw new Error("revision did not invalidate");
    performanceSpans.observeSite(); r.close();
    console.log("memo-ok");
  `);
  for (let run = 0; run < 2; run++) {
    const child = Bun.spawn([process.execPath, driver, f.registry.filename, f.sqliteFilename], {
      env: { ...process.env, LLV_STATE_DIR: path.dirname(driver), LLV_SPAWN_CAPABILITY: undefined }, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout.trim()).toBe("memo-ok");
  }
});
