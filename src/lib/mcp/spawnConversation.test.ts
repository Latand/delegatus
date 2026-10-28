import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { retainProviderRedactionSecrets } from "@/lib/accounts/providerSecretRedaction";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { productionLivenessSources } from "@/lib/lifecycle/liveness";
import { loadTasks, loadTasksFile, mutateTasksFile } from "@/lib/tasks/store";
import { statePath } from "@/lib/configDir";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { projectAliasStore } from "@/lib/projects/persistence";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy, type CallerAttribution, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, SqliteMcpReceiptStore, type McpToolCallContext, type McpToolResult } from "./server";
import { currentMcpHttpCaller } from "./callerContext";
import { setMcpHttpDependenciesForTests } from "./http";
import { POST } from "@/app/api/mcp/route";

const now = "2026-10-26T22:30:00.000Z";
const retryAt = "2026-10-26T22:31:00.000Z";
const failure = "native protocol verification failed";
const admissionWait = "runtime host admission is unavailable";
const directories: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
let registry: AgentRegistry | undefined;
let restoreTasks: (() => void) | undefined;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setMcpHttpDependenciesForTests(null);
  registry?.close();
  setAgentRegistryForTests(null);
  restoreTasks?.();
  restoreTasks = undefined;
  setSystemTime();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(mode: "off" | "sqlite", options: { alias?: boolean; parent?: boolean } = {}) {
  setSystemTime(new Date(now));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-conversation-"));
  directories.push(directory);
  const priorTasks = loadTasksFile();
  restoreTasks = () => mutateTasksFile(() => ({ state: priorTasks, result: undefined }));
  const filename = path.join(directory, "registry.json");
  const aliasId = "conversation_accepted_alias";
  if (options.alias) {
    const seed = new AgentRegistry(filename, () => false, undefined, { sqliteMode: "off" });
    const document = seed.readOnlySnapshot();
    seed.close();
    fs.writeFileSync(filename, JSON.stringify({ ...document,
      conversationAliases: { ...document.conversationAliases, [aliasId]: "conversation_accepted_spawn" },
    }));
  }
  const open = () => {
    registry = new AgentRegistry(filename, () => false, undefined, { sqliteMode: mode });
    setAgentRegistryForTests(registry);
    return registry;
  };
  open();
  const parentConversationId = options.parent === false ? null : "conversation_owner";
  const begun = registry!.beginSpawnRequest({
    engine: "codex", cwd: directory, transport: "structured", accountId: "account-a", accountPin: true,
    conversationId: "conversation_accepted_spawn", clientAttemptId: "accepted-spawn",
    parentConversationId,
    launchProfile: { cwd: directory, title: "Read accepted launch", project: "fixture", parentConversationId },
  });
  if (begun.kind !== "created") throw new Error("fixture launch was not created");
  const receipt = begun.receipt;
  const transcriptPath = path.join(process.env.LLV_CODEX_HOME!, "sessions", path.basename(directory), "accepted.jsonl");
  let caller: CallerAttribution = { kind: "agent", conversationId: "conversation_owner", role: "builder" };
  let project: string | null = "fixture";
  const dependencies: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    callerAttribution: () => caller,
    callerProject: () => project,
    completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
    listFiles: async () => { throw new Error("unexpected corpus scan"); },
    livenessSources: () => ({
      ...productionLivenessSources(),
      pipelines: () => [], flows: () => [],
      selectInventory: async () => { throw new Error("unexpected inventory scan"); },
    }),
    refreshLifecycleJournal: () => ({ appended: 0, skipped: 0, throttled: false }),
  };
  const bindings = viewerMcpBindings(undefined, undefined, dependencies);
  const settle = (launchId = receipt.launchId) => registry!.settleSpawn(launchId, {
    key: { engine: "codex", sessionId: "accepted-native-session" }, artifactPath: transcriptPath,
    cwd: directory, accountId: "account-a", status: "unhosted", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  const writeTranscript = () => {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    directories.push(path.dirname(transcriptPath));
    fs.writeFileSync(transcriptPath, [
      { type: "session_meta", payload: { id: "accepted-native-session", cwd: directory } },
      { type: "response_item", timestamp: now, payload: { type: "message", role: "assistant",
        content: [{ type: "output_text", text: "Transcript is ready." }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
  };
  return { directory, receipt, bindings, dependencies, transcriptPath, settle, aliasId, writeTranscript,
    useRegistryProject: () => { delete dependencies.callerProject; },
    as: (next: CallerAttribution, nextProject: string | null) => { caller = next; project = nextProject; },
    restart: () => { registry!.close(); open(); } };
}

function receiptService(f: ReturnType<typeof fixture>, mode: "memory" | "sqlite") {
  const filename = path.join(f.directory, "mcp-receipts.sqlite");
  let store = mode === "sqlite" ? new SqliteMcpReceiptStore(filename) : new MemoryMcpReceiptStore();
  cleanups.push(() => { if (store instanceof SqliteMcpReceiptStore) store.close(); });
  const open = () => createMcpToolService(f.bindings, store, viewerMcpToolPolicy(f.dependencies));
  let service = open();
  return {
    call: (tool: string, args: Record<string, unknown>, context?: McpToolCallContext) => service.callTool(tool, args, context),
    restart: () => {
      if (store instanceof SqliteMcpReceiptStore) { store.close(); store = new SqliteMcpReceiptStore(filename); }
      service = open();
    },
  };
}

const owner: CallerAttribution = { kind: "agent", conversationId: "conversation_owner", role: "builder" };
const foreign: CallerAttribution = { kind: "agent", conversationId: "conversation_foreign", role: "builder" };
const receiptTools = ["get_conversation", "agent_activity"] as const;

function expectPrivateReceipt(result: McpToolResult, tool: typeof receiptTools[number]) {
  expect(result).toMatchObject(tool === "get_conversation"
    ? { ok: true, evidence: "spawn-receipt", state: "failed", reason: failure }
    : { ok: true, count: 1, conversations: [{ evidence: "spawn-receipt", state: "failed", reason: failure }] });
}

function expectNoPrivateReceipt(result: McpToolResult, tool: typeof receiptTools[number]) {
  expect(result).toMatchObject(tool === "get_conversation"
    ? { ok: false, error: "conversation not found" }
    : { ok: true, count: 0, conversations: [] });
  expect(JSON.stringify(result)).not.toContain(failure);
  expect(JSON.stringify(result)).not.toContain("spawn-receipt");
}

for (const registryMode of ["off", "sqlite"] as const) {
  for (const receiptMode of ["memory", "sqlite"] as const) {
    for (const tool of receiptTools) {
      test(`keyed ${tool} partitions private receipts by caller and project (${registryMode}/${receiptMode})`, async () => {
        const f = fixture(registryMode);
        registry!.failSpawn(f.receipt.launchId, failure);
        const before = registry!.readOnlySnapshot();
        const service = receiptService(f, receiptMode);
        const args = { conversationId: f.receipt.conversationId, clientRequestId: "read-pending" };
        expectPrivateReceipt(await service.call(tool, args), tool);
        expect(await service.call(tool, args)).toMatchObject({ replayed: true });
        f.restart();
        service.restart();
        expectPrivateReceipt(await service.call(tool, args), tool);
        expect(await service.call(tool, args)).toMatchObject({ replayed: true });
        for (const [caller, project] of [
          [foreign, "fixture"], [foreign, "other-project"],
          [owner, "other-project"], [owner, null],
          [{ kind: "unidentified", conversationId: null, role: null }, "fixture"],
        ] as const) {
          f.as(caller, project);
          expectNoPrivateReceipt(await service.call(tool, { ...args, clientRequestId: "fresh-refusal" }), tool);
          expectNoPrivateReceipt(await service.call(tool, args), tool);
        }
        f.as(owner, "fixture");
        const replay = await service.call(tool, args);
        expectPrivateReceipt(replay, tool);
        expect(replay).toMatchObject({ replayed: true });
        expect(registry!.readOnlySnapshot().receipts).toEqual(before.receipts);
      });

      test.each(["caller", "project"] as const)(`in-flight ${tool} cannot join another %s (${registryMode}/${receiptMode})`, async changed => {
        const f = fixture(registryMode);
        registry!.failSpawn(f.receipt.launchId, failure);
        const original = f.bindings[tool];
        let entered!: () => void;
        let release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        let calls = 0;
        f.bindings[tool] = Object.assign(async (...args: Parameters<typeof original>) => {
          calls++;
          const answer = await original(...args);
          if (calls === 1) { entered(); await held; }
          return answer;
        }, original);
        const service = receiptService(f, receiptMode);
        const args = { conversationId: f.receipt.conversationId, clientRequestId: "held-read" };
        const pending = service.call(tool, args);
        try {
          await ready;
          f.as(changed === "caller" ? foreign : owner, changed === "project" ? "other-project" : "fixture");
          const other = service.call(tool, args);
          // The foreign call's promise chain reaches joining/dispatch before
          // this next event-loop turn releases the owner's completed payload.
          setImmediate(release);
          expectNoPrivateReceipt(await other, tool);
          expectPrivateReceipt(await pending, tool);
          expect(calls).toBe(2);
        } finally { release(); await pending; }
      });
    }
  }
}

for (const tool of receiptTools) {
  test(`keyed ${tool} replays across canonical project aliases`, async () => {
    const f = fixture("sqlite");
    registry!.failSpawn(f.receipt.launchId, failure);
    const filename = statePath("project-aliases.json");
    const previous = projectAliasStore.readExisting(filename);
    cleanups.push(() => { projectAliasStore.mutate(filename, () => ({ next: previous, result: undefined })); });
    expect(persistProjectAliases([{ source: "fixture-legacy", target: "fixture", displayName: "Fixture" }])).toBe(true);
    const service = receiptService(f, "sqlite");
    const args = { conversationId: f.receipt.conversationId, clientRequestId: "canonical-read" };
    expectPrivateReceipt(await service.call(tool, args), tool);
    f.as(owner, "fixture-legacy");
    const replay = await service.call(tool, args);
    expectPrivateReceipt(replay, tool);
    expect(replay).toMatchObject({ replayed: true });
  });

  test(`HTTP SDK ${tool} keeps persisted receipts private and permits transcript takeover`, async () => {
    const f = fixture("sqlite");
    registry!.failSpawn(f.receipt.launchId, failure);
    const service = receiptService(f, "sqlite");
    const ownerCapability = "a".repeat(43);
    const foreignCapability = "b".repeat(43);
    let ownerProject: string | null = "fixture";
    f.dependencies.callerAttribution = () => currentMcpHttpCaller()?.capability === ownerCapability ? owner : foreign;
    f.dependencies.callerProject = () => currentMcpHttpCaller()?.capability === ownerCapability ? ownerProject : "other-project";
    setMcpHttpDependenciesForTests({
      service: async () => ({ callTool: (name, args, context) => service.call(name, args, context) }),
      conversationForCapability: capability => capability === ownerCapability ? owner.conversationId
        : capability === foreignCapability ? foreign.conversationId : null,
    });
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: request => POST(new NextRequest(request)) });
    cleanups.push(() => { listener.stop(true); });
    const url = new URL(`http://127.0.0.1:${listener.port}/api/mcp`);
    const clients: Client[] = [];
    cleanups.push(async () => { for (const client of clients) await client.close(); });
    for (const capability of [ownerCapability, foreignCapability]) {
      const client = new Client({ name: "receipt-fixture", version: "1" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { "x-llv-spawn-capability": capability } },
      }));
    }
    const args = { conversationId: f.receipt.conversationId, clientRequestId: "sdk-read-pending", full: true };
    const call = async (client: Client, input = args) => (await client.callTool({ name: tool, arguments: input })).structuredContent as McpToolResult;
    expectPrivateReceipt(await call(clients[0]!), tool);
    f.restart();
    service.restart();
    expectPrivateReceipt(await call(clients[0]!), tool);
    expect(await call(clients[0]!)).toMatchObject({ replayed: true });
    expectNoPrivateReceipt(await call(clients[1]!), tool);
    ownerProject = "other-project";
    expectNoPrivateReceipt(await call(clients[0]!), tool);
    ownerProject = "fixture";
    expectPrivateReceipt(await call(clients[0]!), tool);
    // A real transcript remains readable by the other caller, even when the
    // accepted launch's private receipt belongs to the original owner.
    const launched = registry!.beginSpawnRequest({
      engine: "codex", cwd: f.directory, transport: "structured", conversationId: "conversation_transcript_spawn",
      parentConversationId: "conversation_owner",
      launchProfile: { cwd: f.directory, project: "fixture", title: "Transcript takeover" },
    });
    if (launched.kind !== "created") throw new Error("transcript launch was not created");
    expect(f.settle(launched.receipt.launchId).kind).toBe("settled");
    f.writeTranscript();
    const transcript = await call(clients[1]!, { ...args, conversationId: launched.receipt.conversationId, clientRequestId: "sdk-transcript" });
    expect(transcript).toMatchObject(tool === "get_conversation"
      ? { ok: true, messages: [{ text: "Transcript is ready." }] }
      : { ok: true, count: 1, conversations: [{ evidenceSource: "transcript" }] });
    expect(JSON.stringify(transcript)).not.toContain(failure);
  });
}

for (const mode of ["off", "sqlite"] as const) {
  test.each(["starting", "waiting", "failed", "launched"] as const)(`accepted %s is readable before its transcript (${mode})`, async state => {
    const f = fixture(mode);
    if (state === "waiting") registry!.queuePinnedSpawn(f.receipt.launchId, {
      version: 1, retryAt, admissionDeadlineAt: "2026-10-26T22:35:00.000Z", lastAdmissionError: admissionWait,
      accountId: "account-a", locale: "en", prompt: "private launch payload", imageRefs: [],
      parentArtifactPath: null, pipelineSourceConversationId: null,
      spec: { command: "codex", cwd: f.directory, windowName: "accepted", engine: "codex",
        launchProfile: emptyLaunchProfile({ title: "Read accepted launch" }) },
    }, "Admission wait");
    if (state === "failed") registry!.failSpawn(f.receipt.launchId, failure);
    if (state === "launched") f.settle();
    const taskIds = loadTasks().filter(task => task.assignments.some(assignment =>
      assignment.conversationId === f.receipt.conversationId)).map(task => task.id);
    expect(taskIds.length).toBeGreaterThan(0);
    f.restart();
    const before = registry!.readOnlySnapshot();
    for (const tailLines of [0, 10]) {
      expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId, tailLines })).toMatchObject({
        conversationId: f.receipt.conversationId, launchId: f.receipt.launchId, state, taskIds,
        evidence: "spawn-receipt", reason: state === "failed" ? failure : state === "waiting" ? admissionWait : null,
        ...(state === "waiting" ? { retryAt } : {}),
      });
    }
    for (const full of [false, true]) {
      const activity = await f.bindings.agent_activity({ conversationId: f.receipt.conversationId, full });
      expect(activity).toMatchObject({ count: 1, journaled: 0, selection: { scope: "targeted", matched: 1, selected: 1 }, conversations: [{
        conversationId: f.receipt.conversationId, state, taskIds, evidence: "spawn-receipt",
        reason: state === "failed" ? failure : state === "waiting" ? admissionWait : null,
      }] });
      expect(JSON.stringify(activity)).not.toContain("private launch payload");
    }
    expect(registry!.readOnlySnapshot()).toEqual(before);
  });

  test.each(["absent", "recorded"] as const)(`receipt reads enforce caller and project ownership with artifact=%s (${mode})`, async artifact => {
    const f = fixture(mode, { alias: true });
    if (artifact === "recorded") f.settle();
    else expect(registry!.failSpawn(f.receipt.launchId, failure)).toBe(true);
    const expected = artifact === "recorded" ? { state: "launched", reason: null } : { state: "failed", reason: failure };
    f.restart();
    for (const [kind, conversationId, project] of [
      ["agent", "conversation_other", "fixture"],
      ["agent", "conversation_other", "other-project"],
      ["agent", "conversation_owner", "other-project"],
      ["agent", "conversation_owner", null],
      ["unidentified", null, "fixture"],
    ] as const) {
      f.as({ kind, conversationId, role: null }, project);
      for (const target of [f.receipt.conversationId, f.aliasId]) {
        await expect(f.bindings.get_conversation({ conversationId: target })).rejects.toThrow("conversation not found");
        await expect(f.bindings.get_conversation({ conversationId: target, tailLines: 10 })).rejects.toThrow();
        expect(await f.bindings.agent_activity({ conversationId: target })).toMatchObject({ count: 0, conversations: [] });
      }
    }
    f.as({ kind: "agent", conversationId: "conversation_owner", role: "builder" }, "fixture");
    for (const target of [f.receipt.conversationId, f.aliasId]) {
      expect(await f.bindings.get_conversation({ conversationId: target })).toMatchObject(expected);
      expect(await f.bindings.get_conversation({ conversationId: target, tailLines: 10 })).toMatchObject(expected);
      expect(await f.bindings.agent_activity({ conversationId: target })).toMatchObject({ count: 1, conversations: [expected] });
    }
    expect(await f.bindings.agent_activity({ conversationId: f.receipt.conversationId, project: "other-project" })).toMatchObject({ count: 0, conversations: [] });
    f.as({ kind: "gateway", conversationId: "conversation_owner", role: null }, "other-project");
    expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId })).toMatchObject(expected);
    expect(await f.bindings.agent_activity({ conversationId: f.receipt.conversationId })).toMatchObject({ count: 1, conversations: [expected] });
  });

  test(`caller project is read from the durable registry (${mode})`, async () => {
    const f = fixture(mode);
    const parent = registry!.beginSpawnRequest({
      engine: "codex", cwd: f.directory, conversationId: "conversation_owner",
      explicitProject: "fixture",
      launchProfile: { cwd: f.directory, project: "fixture", title: "Launch owner" },
    });
    if (parent.kind !== "created") throw new Error("fixture owner was not created");
    registry!.settleSpawn(parent.receipt.launchId, {
      key: { engine: "codex", sessionId: "owner-native-session" }, artifactPath: path.join(f.directory, "owner.jsonl"),
      cwd: f.directory, accountId: null, status: "unhosted", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    f.restart();
    f.useRegistryProject();
    expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId })).toMatchObject({ state: "starting" });
    expect(await f.bindings.agent_activity({ conversationId: f.receipt.conversationId })).toMatchObject({ count: 1 });
  });

  test(`parentless receipts require the identified gateway (${mode})`, async () => {
    const f = fixture(mode, { parent: false });
    f.restart();
    for (const caller of [
      { kind: "unidentified", conversationId: null, role: null },
      { kind: "agent", conversationId: "conversation_other", role: "builder" },
    ] as const) {
      f.as(caller, "fixture");
      await expect(f.bindings.get_conversation({ conversationId: f.receipt.conversationId })).rejects.toThrow("conversation not found");
      await expect(f.bindings.get_conversation({ conversationId: f.receipt.conversationId, tailLines: 10 })).rejects.toThrow();
      expect(await f.bindings.agent_activity({ conversationId: f.receipt.conversationId })).toMatchObject({ count: 0, conversations: [] });
    }
    f.as({ kind: "gateway", conversationId: "conversation_operator", role: null }, null);
    expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId })).toMatchObject({ state: "starting" });
    expect(await f.bindings.agent_activity({ conversationId: f.receipt.conversationId })).toMatchObject({ count: 1 });
  });

  test(`default activity retains an oversized redacted failure after restart (${mode})`, async () => {
    const f = fixture(mode);
    const sensitive = ["oversized", "provider", "credential"].join("-");
    retainProviderRedactionSecrets([sensitive]);
    const prefix = "Diagnostic detail. ".repeat(1800);
    registry!.failSpawn(f.receipt.launchId, `${prefix}${sensitive} DECISIVE FINAL CAUSE`);
    const taskIds = registry!.readOnlySnapshot().receipts[f.receipt.launchId]!.failureReporting!.taskIds;
    f.restart();
    const conversation = await f.bindings.get_conversation({ conversationId: f.receipt.conversationId });
    expect(String(conversation.reason)).toStartWith(prefix);
    expect(String(conversation.reason)).toEndWith(" DECISIVE FINAL CAUSE");
    expect(String(conversation.reason)).not.toContain(sensitive);
    for (const options of [{}, { full: true }]) {
      const activity = await f.bindings.agent_activity({ conversationId: f.receipt.conversationId, ...options });
      expect(activity).toMatchObject({ count: 1, conversations: [{
        conversationId: f.receipt.conversationId, state: "failed", reason: conversation.reason, taskIds,
      }] });
      expect(JSON.stringify(activity)).not.toContain(sensitive);
    }
  });

  test(`a transcript takes over both reads unchanged (${mode})`, async () => {
    const f = fixture(mode);
    f.settle();
    f.restart();
    expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId })).toMatchObject({ state: "launched" });
    f.writeTranscript();
    f.as({ kind: "agent", conversationId: "conversation_other", role: "builder" }, "other-project");
    const answer = await f.bindings.get_conversation({ conversationId: f.receipt.conversationId });
    expect(answer.messages).toMatchObject([{ text: "Transcript is ready." }]);
    expect(answer).not.toHaveProperty("evidence");
    expect(answer).not.toHaveProperty("state");
    const tail = await f.bindings.get_conversation({ conversationId: f.receipt.conversationId, tailLines: 10 });
    expect(tail).toHaveProperty("tail");
    expect(tail).not.toHaveProperty("state");
    const activity = await f.bindings.agent_activity({ conversationId: f.receipt.conversationId, full: true });
    expect(activity).toMatchObject({ count: 1, conversations: [{ evidenceSource: "transcript" }] });
    expect((activity.conversations as object[])[0]).not.toHaveProperty("state");
  });

  test.each(["quota", "admitting"] as const)(`a %s queue retains its admission facts (${mode})`, async kind => {
    const f = fixture(mode);
    const reason = "Pinned account capacity is unavailable";
    registry!.queuePinnedSpawn(f.receipt.launchId, {
      version: 1, retryAt, accountId: "account-a", locale: "en", prompt: "queued launch", imageRefs: [],
      ...(kind === "admitting" ? { admissionDeadlineAt: "2026-10-26T22:35:00.000Z" } : {}),
      parentArtifactPath: null, pipelineSourceConversationId: null,
      spec: { command: "codex", cwd: f.directory, windowName: "accepted", engine: "codex",
        launchProfile: emptyLaunchProfile({ title: "Read accepted launch" }) },
    }, reason);
    f.restart();
    const expected = { state: kind === "quota" ? "waiting" : "starting", reason: kind === "quota" ? reason : null };
    expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId })).toMatchObject(expected);
    expect(await f.bindings.agent_activity({ conversationId: f.receipt.conversationId })).toMatchObject({ conversations: [expected] });
  });

  test(`unknown ids retain the existing missing answers (${mode})`, async () => {
    const f = fixture(mode);
    await expect(f.bindings.get_conversation({ conversationId: "conversation_unknown" })).rejects.toThrow("conversation not found");
    await expect(f.bindings.get_conversation({ conversationId: "conversation_unknown", tailLines: 10 })).rejects.toThrow("no Viewer conversation has that id");
    expect(await f.bindings.agent_activity({ conversationId: "conversation_unknown" })).toMatchObject({ count: 0, conversations: [] });
  });

  test(`receipt errors are redacted on every fallback read (${mode})`, async () => {
    const f = fixture(mode);
    const sensitive = ["provider", "fixture", "credential", "value"].join("-");
    retainProviderRedactionSecrets([sensitive]);
    registry!.failSpawn(f.receipt.launchId, `Verification failed: ${sensitive}`);
    f.restart();
    const answers = [
      await f.bindings.get_conversation({ conversationId: f.receipt.conversationId }),
      await f.bindings.get_conversation({ conversationId: f.receipt.conversationId, tailLines: 10 }),
      await f.bindings.agent_activity({ conversationId: f.receipt.conversationId }),
    ];
    for (const answer of answers) {
      const rendered = JSON.stringify(answer);
      expect(rendered).toContain("Verification failed:");
      expect(rendered).not.toContain(sensitive);
    }
  });

  test(`a rejected reservation never becomes an accepted conversation (${mode})`, async () => {
    const f = fixture(mode);
    const reviewer = registry!.beginSpawnRequest({
      engine: "codex", cwd: f.directory, role: "reviewer", conversationId: "conversation_reviewer",
      reviewsConversationId: f.receipt.conversationId,
      launchProfile: { title: "Review accepted launch" },
    });
    if (reviewer.kind !== "created") throw new Error("fixture reviewer was not created");
    f.settle(reviewer.receipt.launchId);
    expect(() => registry!.beginSpawnRequest({
      engine: "codex", cwd: f.directory, conversationId: "conversation_rejected",
      launchProfile: { title: "Rejected child launch" },
      origin: { kind: "agent", conversationId: reviewer.receipt.conversationId },
    })).toThrow();
    f.restart();
    await expect(f.bindings.get_conversation({ conversationId: "conversation_rejected" })).rejects.toThrow("conversation not found");
    expect(await f.bindings.agent_activity({ conversationId: "conversation_rejected" })).toMatchObject({ count: 0, conversations: [] });
  });
}
