import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, normalizeRegistry, type RegistryFile } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { runStructuredHostRetirementSweep } from "./structuredHostRetirement";
import { pipelineStartupMemberships, pipelineStartupMembershipsAsync, startupConversationRows } from "./startup";
import { demoteSkippedStructuredRegistryHosts } from "./registry";
import { determined } from "./determinable";

const NOW = Date.parse("2026-10-16T00:00:00Z");
const CREATED = new Date(NOW).toISOString();
function seeded(root: string, history: number) {
  const seed = new AgentRegistry(path.join(root, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = seed.ensureConversation("codex", "/fixture/template.jsonl", null);
  const receipt = seed.beginSpawn("codex", "/fixture", { title: "Reader fixture" });
  seed.close();
  const file = normalizeRegistry({ version: 2, entries: {}, receipts: {} });
  for (let n = 0; n <= history; n++) {
    const id = `conversation_reader_${n}` as `conversation_${string}`, session = `reader-${n}`;
    file.conversations[id] = { ...conversation, id, createdAt: CREATED, updatedAt: CREATED, generations: [{ ...conversation.generations[0]!, createdAt: CREATED, id: session, path: `/fixture/${n}.jsonl` }],
      turn: { ...conversation.turn, state: "idle" } };
    file.entries[`codex:${session}`] = { key: { engine: "codex", sessionId: session }, artifactPath: `/fixture/${n}.jsonl`, cwd: "/fixture", accountId: null,
      status: n ? "dead" : "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, updatedAt: "2026-10-01T00:00:00Z",
      ...(n ? {} : { structuredHost: { kind: "codex-app-server", endpoint: "fixture", process: { pid: 990001, startIdentity: "fixture", bootEpoch: "fixture" },
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] } }) };
    file.receipts[`reader-receipt-${n}`] = { ...receipt, createdAt: CREATED, launchId: `reader-receipt-${n}`, conversationId: id, key: { engine: "codex", sessionId: session }, state: "completed" };
    file.memberships[id] = [{ conversationId: id, kind: "pipeline", containerId: `lane-${n}`, role: "builder", slot: "build", stageId: "build", stageOrder: 0, round: 1, parentConversationId: null, createdAt: CREATED }];
  }
  const alias = "conversation_reader_alias";
  file.conversationAliases[alias] = "conversation_reader_0";
  file.memberships[alias] = [{ ...file.memberships["conversation_reader_0"]![0]!, conversationId: alias }];
  const pending = "conversation_reader_pending";
  file.receipts["pending"] = { ...receipt, createdAt: CREATED, launchId: "pending", conversationId: pending, state: "starting", key: null, transport: "structured" };
  file.memberships[pending] = [{ ...file.memberships["conversation_reader_0"]![0]!, conversationId: pending, containerId: "lane-pending" }];
  return file;
}
test("retirement and startup membership payload reads stay flat across tenfold registry history, cold and reopened", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-readers-"));
  const results: number[][] = [];
  try {
    for (const history of [10, 100]) {
      const directory = path.join(root, String(history)); fs.mkdirSync(directory);
      const initial = seeded(directory, history);
      const counts: number[] = [];
      for (let reopened = 0; reopened < 2; reopened++) {
        let reads = 0;
        const filename = path.join(directory, "registry.sqlite");
        const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry,
          onRowPayloadRead: (_collection, count) => { reads += count; } });
        try {
          while (store.archiveInactive(1000)) { /* Archive the generated history. */ }
          const snapshot = store.readOnlySnapshot().file; reads = 0;
          const report = await runStructuredHostRetirementSweep({ now: () => NOW, snapshot: () => snapshot,
            publicationState: () => "ready", handoffRows: () => determined([]), orchestratorSeatConversations: () => determined(new Set()), revokedSeatConversations: () => determined(new Set()),
            durableEventTail: () => determined(0), realtimeBound: () => determined(false), transcriptStat: () => determined({ mtimeMs: NOW - 24 * 3_600_000 }),
            processIdentity: () => determined("fixture"), bootEpoch: () => determined("fixture"), owned: () => false, record: () => {} });
          expect(report.evaluated).toBe(1); expect(report.retired).toEqual([]);
          counts.push(reads);
          // Exercise the production startup selector over the same indexed view.
          const registry = { readOnlySnapshot: () => snapshot,
            structuredHostEntries: () => [snapshot.entries["codex:reader-0"]!] } as AgentRegistry;
          reads = 0;
          const selected = pipelineStartupMemberships(registry);
          expect(Object.keys(selected.memberships)).toEqual(["conversation_reader_0", "conversation_reader_alias", "conversation_reader_pending"]);
          expect(selected.byPipeline.get("lane-pending")).toEqual(["conversation_reader_pending"]);
          expect(selected.resolve("conversation_reader_alias")).toBe("conversation_reader_0");
          expect([...selected.selectedIds]).toEqual(["conversation_reader_0", "conversation_reader_alias", "conversation_reader_pending"]);
          expect(selected.byPipeline.get("lane-0")).toEqual(["conversation_reader_0", "conversation_reader_alias"]);
          counts.push(reads);
        } finally { store.close(); }
      }
      results.push(counts);
    }
    expect(results[1]).toEqual(results[0]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("a host ownership recheck reads only its current memberships, including aliases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-keyed-"));
  try {
    const file = seeded(root, 32);
    for (const entry of Object.values(file.entries)) entry.structuredHost = { ...file.entries["codex:reader-0"]!.structuredHost! };
    const registry = { readOnlySnapshot: () => file } as AgentRegistry;
    const entry = file.entries["codex:reader-0"]!;
    // Other resident hosts and pending launches belong to the bulk selection,
    // never to one host's fresh authorization check.
    const selected = pipelineStartupMemberships(registry, entry);
    expect([...selected.selectedIds]).toEqual(["conversation_reader_0", "conversation_reader_alias"]);
    expect([...selected.byPipeline.keys()]).toEqual(["lane-0"]);
    file.memberships["conversation_reader_0"]![0]!.containerId = "replacement-lane";
    expect(pipelineStartupMemberships(registry, entry).byPipeline.has("replacement-lane")).toBe(true);
    delete file.conversations["conversation_reader_0"];
    expect(pipelineStartupMemberships(registry, entry).selectedIds.size).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("bulk membership preparation yields, validates its revision and observes cancellation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-slices-"));
  try {
    const file = seeded(root, 128);
    for (const entry of Object.values(file.entries)) entry.structuredHost = { ...file.entries["codex:reader-0"]!.structuredHost! };
    let current = file;
    const registry = { readOnlySnapshot: () => current } as AgentRegistry;
    let serviced = false;
    setImmediate(() => { serviced = true; });
    const selected = await pipelineStartupMembershipsAsync(registry);
    expect(serviced).toBe(true);
    expect(selected.selectedIds.size).toBe(131);
    setImmediate(() => { current = { ...file, conversationRevision: { ...file.conversationRevision, codex: file.conversationRevision.codex + 1 } }; });
    await expect(pipelineStartupMembershipsAsync(registry)).rejects.toThrow("changed");
    const abort = new AbortController();
    setImmediate(() => abort.abort(new Error("cancelled census")));
    await expect(pipelineStartupMembershipsAsync(registry, { signal: abort.signal })).rejects.toThrow("cancelled census");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("reconciliation services the loop while selecting hosts, before any mutation", async () => {
  const row = { key: { engine: "codex", sessionId: "released" }, status: "dead", claimOwner: null,
    structuredHost: { process: null, endpoint: "stdio:released", activeTurnRef: null, pendingAttention: [], activeFlags: [] } } as unknown as RegistryFile["entries"][string];
  const entries = Array.from({ length: 512 }, () => row);
  const registry = { structuredHostEntries: () => entries } as unknown as AgentRegistry;
  let examined = 0, observed = -1, mutations = 0;
  setImmediate(() => { observed = examined; });
  await demoteSkippedStructuredRegistryHosts(registry, () => { examined++; return false; }, async () => { mutations++; return undefined; });
  expect(observed).toBeGreaterThanOrEqual(0);
  expect(observed).toBeLessThan(512);
  expect(examined).toBe(512);
  expect(mutations).toBe(0);
});


test("retained startup conversation traversal yields without omitting history and cancels at a slice boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-conversations-"));
  try {
    const file = seeded(root, 256);
    let examined = 0, observed = -1;
    setImmediate(() => { observed = examined; });
    const ids: string[] = [];
    for await (const conversation of startupConversationRows(file)) { ids.push(conversation.id); examined++; }
    expect(ids).toEqual(Object.keys(file.conversations));
    expect(observed).toBeGreaterThanOrEqual(0);
    expect(observed).toBeLessThan(examined);
    const abort = new AbortController();
    setImmediate(() => abort.abort(new Error("cancelled history traversal")));
    await expect((async () => {
      for await (const _row of startupConversationRows(file, { signal: abort.signal })) { /* no effect */ }
    })()).rejects.toThrow("cancelled history traversal");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
