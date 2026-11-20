import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { McpGrantPolicy } from "./mcpAllowlist";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
const registries: AgentRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(options: { mcpGrantPolicy?: McpGrantPolicy } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-immutable-keyed-"));
  directories.push(directory);
  const initial = normalizeRegistry({
    version: 2,
    entries: {},
    receipts: Object.fromEntries(
      ["first", "second", "third"].map(launchId => [launchId, {
        launchId,
        conversationId: `conversation_${launchId}`,
        engine: "codex",
        cwd: "/registry-fixture",
        createdAt: "2026-10-01T00:00:00.000Z",
        state: "starting",
        error: null,
        pathCorrelation: { cwd: "/registry-fixture", startedAt: "2026-10-01T00:00:00.000Z" },
        launchProfile: emptyLaunchProfile({ cwd: "/registry-fixture", title: "Immutable keyed read fixture", mcpServers: ["viewer"] }, options.mcpGrantPolicy),
      }]),
    ),
  }, options.mcpGrantPolicy);
  let parses = 0;
  const filename = path.join(directory, "registry.sqlite");
  const store = new SqliteAgentRegistryStore(filename, {
    initialSnapshot: initial,
    normalize: (value, mode) => normalizeRegistry(value, options.mcpGrantPolicy, mode),
    mcpGrantPolicy: options.mcpGrantPolicy,
    onRowPayloadParse: (_collection, count) => { parses += count; },
  });
  stores.push(store);
  return { directory, filename, store, initial, getParses: () => parses, resetParses: () => { parses = 0; } };
}

for (const skipColdKeyInitialization of [false, true]) {
  for (const enumerate of [false, true]) {
    test(`readImmutable skips structuredClone and reparsing on warm hot rows (skipCold=${skipColdKeyInitialization}, enumerate=${enumerate})`, () => {
      const { store, initial, getParses, resetParses } = fixture();
      const warm = store.readImmutable(file => Object.values(file.receipts));
      expect(warm).toHaveLength(3);
      resetParses();

      const clones = spyOn(globalThis, "structuredClone");
      let rows: readonly unknown[];
      try {
        rows = store.readImmutable(file => {
          const first = file.receipts.first!;
          expect(file.receipts.missing).toBeUndefined();
          const second = file.receipts.first!;
          expect(second).toBe(first);
          return enumerate ? Object.values(file.receipts) : [first];
        }, { skipColdKeyInitialization });
        expect(clones).toHaveBeenCalledTimes(0);
      } finally {
        clones.mockRestore();
      }
      expect(getParses()).toBe(0);
      expect(JSON.stringify(rows)).toBe(JSON.stringify(enumerate ? Object.values(initial.receipts) : [initial.receipts.first]));
      expect(Object.isFrozen(rows[0])).toBe(true);
      const firstRow = rows[0] as { pathCorrelation: { cwd: string } };
      expect(Object.isFrozen(firstRow.pathCorrelation)).toBe(true);
      expect(() => {
        firstRow.pathCorrelation.cwd = "/should-throw";
      }).toThrow(TypeError);
    });
  }
}

test("readImmutable enforces immutability at root file, collection proxies, rows, beyond-baseline rows and meta fields", () => {
  const { store, initial } = fixture();
  store.mutate(file => {
    file.receipts.forged = {
      ...structuredClone(initial.receipts.first!),
      launchId: "forged",
      conversationId: "conversation_forged",
      agentRole: "worker",
      delegationDepth: 1,
      parentConversationId: "conversation_first",
      launchProfile: emptyLaunchProfile({
        cwd: "/registry-fixture",
        title: "Forged grant fixture",
        parentConversationId: "conversation_first",
        mcpServers: ["viewer", "telegram"],
      }),
    };
  }, false);

  store.readImmutable(file => {
    const rawFile = file as unknown as Record<string, unknown>;
    const rawReceipts = file.receipts as unknown as Record<string, unknown>;
    // Top-level file rejects reassignment and new properties.
    expect(() => { rawFile.receipts = {}; }).toThrow(TypeError);
    expect(() => { rawFile.engineRouting = {}; }).toThrow(TypeError);
    expect(() => { rawFile.extraField = 1; }).toThrow(TypeError);

    // Collection proxy rejects all write traps (set, delete, defineProperty, setPrototypeOf)
    // and reports writable: false on property descriptors.
    expect(() => { rawReceipts.extra = {}; }).toThrow(TypeError);
    expect(() => { delete rawReceipts.first; }).toThrow(TypeError);
    expect(() => { Object.defineProperty(rawReceipts, "defined", { value: {} }); }).toThrow(TypeError);
    expect(() => { Object.setPrototypeOf(rawReceipts, null); }).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(file.receipts, "first")?.writable).toBe(false);

    // Hot baseline row, beyond-baseline decided row, and meta fields are all deeply frozen.
    expect(Object.isFrozen(file.receipts.first)).toBe(true);
    expect(Object.isFrozen(file.receipts.forged)).toBe(true);
    expect(file.receipts.forged!.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(() => { (file.receipts.forged!.launchProfile.mcpServers as string[]).push("telegram"); }).toThrow(TypeError);
    expect(Object.isFrozen(file.engineRouting)).toBe(true);
    expect(Object.isFrozen(file.engineRouting.codex)).toBe(true);
    expect(() => { (file.engineRouting.codex as { revision: number }).revision = 999; }).toThrow(TypeError);
  });

  // Mutable store.read remains caller-owned and independent.
  const copy = store.read(file => {
    const receipt = file.receipts.first!;
    receipt.error = "local-edit";
    receipt.launchProfile.mcpServers.push("local-only");
    return receipt;
  });
  expect(copy.error).toBe("local-edit");
  expect(copy.launchProfile.mcpServers).toContain("local-only");
  expect(store.readImmutable(file => file.receipts.first!.error)).toBeNull();
  expect(store.readImmutable(file => file.receipts.first!.launchProfile.mcpServers)).toEqual(["viewer"]);
});

test("readImmutable observes concurrent store commits, nested reads inside mutate, and raw second-connection SQLite updates", () => {
  const { store, filename, initial } = fixture();
  expect(store.readImmutable(file => file.receipts.first!.error)).toBeNull();
  const routingBefore = store.readImmutable(file => file.engineRouting.codex.revision);

  const clones = spyOn(globalThis, "structuredClone");
  try {
    expect(store.readImmutable(file => file.engineRouting.codex.revision)).toBe(routingBefore);
    expect(clones).toHaveBeenCalledTimes(0);
  } finally {
    clones.mockRestore();
  }

  // Same-store mutation invalidates the row and meta caches; nested readImmutable inside mutate sees committed SQLite state cleanly.
  store.mutate(file => {
    expect(store.readImmutable(inner => inner.receipts.first!.error)).toBeNull();
    file.receipts.first!.error = "updated-local";
    file.engineRouting.codex.revision = routingBefore + 1;
  }, false);
  expect(store.readImmutable(file => file.receipts.first!.error)).toBe("updated-local");
  expect(store.readImmutable(file => file.engineRouting.codex.revision)).toBe(routingBefore + 1);

  // Second SqliteAgentRegistryStore connection commit is observed immediately.
  const peer = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry });
  stores.push(peer);
  peer.mutate(file => {
    file.receipts.first!.error = "updated-peer";
    file.engineRouting.codex.revision = routingBefore + 2;
  }, false);
  expect(store.readImmutable(file => file.receipts.first!.error)).toBe("updated-peer");
  expect(store.readImmutable(file => file.engineRouting.codex.revision)).toBe(routingBefore + 2);

  // Raw second SQLite connection updating registry_rows and registry_meta directly without bumping revision.
  const rawPeer = new Database(filename);
  const rawReceipt = rawPeer.query<{ value_json: string }, [string, string]>(
    "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
  ).get("receipts", "first")!;
  const updatedReceipt = { ...(JSON.parse(rawReceipt.value_json) as Record<string, unknown>), error: "updated-raw-sqlite" };
  rawPeer.query("UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
    .run(JSON.stringify(updatedReceipt), "receipts", "first");
  const rawRouting = rawPeer.query<{ value: string }, [string]>(
    "SELECT value FROM registry_meta WHERE key = ?",
  ).get("engineRouting")!;
  const updatedRouting = JSON.parse(rawRouting.value) as { codex: { activeAccountId: string | null; revision: number } };
  updatedRouting.codex.revision = routingBefore + 7;
  rawPeer.query("UPDATE registry_meta SET value = ? WHERE key = ?")
    .run(JSON.stringify(updatedRouting), "engineRouting");
  rawPeer.close();

  expect(store.readImmutable(file => file.receipts.first!.error)).toBe("updated-raw-sqlite");
  expect(store.readImmutable(file => file.engineRouting.codex.revision)).toBe(routingBefore + 7);
});

test("readImmutable enforces MCP grant bounds on rows claiming beyond-baseline servers", () => {
  const { store, initial } = fixture();
  store.mutate(file => {
    file.receipts.forged = {
      ...structuredClone(initial.receipts.first!),
      launchId: "forged",
      conversationId: "conversation_forged",
      agentRole: "worker",
      delegationDepth: 1,
      parentConversationId: "conversation_first",
      launchProfile: emptyLaunchProfile({
        cwd: "/registry-fixture",
        title: "Forged grant fixture",
        parentConversationId: "conversation_first",
        mcpServers: ["viewer", "telegram"],
      }),
    };
  }, false);

  for (const skipColdKeyInitialization of [false, true]) {
    const result = store.readImmutable(file => ({
      baseline: file.receipts.first!.launchProfile.mcpServers,
      forged: file.receipts.forged!.launchProfile.mcpServers,
    }), { skipColdKeyInitialization });
    expect(result.baseline).toEqual(["viewer"]);
    expect(result.forged).toEqual(["viewer"]);
  }
});

test("public agentStateRead preserves caller-owned mutable copies without affecting durable data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-agent-state-read-mutable-"));
  directories.push(directory);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  registries.push(registry);
  const conversation = registry.ensureConversation("codex", "/tmp/mutable-1.jsonl", null);
  const id = conversation.id;

  const copy = registry.agentStateRead(file => file.conversations[id]!);
  copy.continuityPaths.push("/tmp/local-only-appended.jsonl");
  copy.generations[0]!.path = "/tmp/local-only-rewritten.jsonl";
  expect(copy.continuityPaths).toContain("/tmp/local-only-appended.jsonl");
  expect(copy.generations[0]!.path).toBe("/tmp/local-only-rewritten.jsonl");

  const fresh = registry.agentStateRead(file => file.conversations[id]!);
  expect(fresh.continuityPaths).toEqual([]);
  expect(fresh.generations[0]!.path).toBe("/tmp/mutable-1.jsonl");
});

test("audited AgentRegistry keyed readers reuse frozen rows internally while returning caller-owned mutable copies", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-agent-immutable-"));
  directories.push(directory);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  registries.push(registry);
  expect(fs.existsSync(path.join(directory, "agent-registry.sqlite"))).toBe(true);
  const conversation = registry.ensureConversation("codex", "/tmp/warm-1.jsonl", null);
  const id = conversation.id;

  // Warm caches via immutable keyed paths.
  expect(registry.conversationTranscriptPaths(id)).toEqual(["/tmp/warm-1.jsonl"]);
  expect(registry.canonicalConversationId(id)).toBe(id);
  expect(registry.readImmutable(file => file.conversations[id]?.engine)).toBe("codex");

  const clones = spyOn(globalThis, "structuredClone");
  try {
    expect(registry.conversationTranscriptPaths(id)).toEqual(["/tmp/warm-1.jsonl"]);
    expect(registry.canonicalConversationId(id)).toBe(id);
    expect(registry.readImmutable(file => file.conversations[id]?.engine)).toBe("codex");
    expect(clones).toHaveBeenCalledTimes(0);
  } finally {
    clones.mockRestore();
  }

  // Public methods that return objects must return caller-owned mutable copies.
  const convCopy = registry.conversation(id)!;
  convCopy.continuityPaths.push("/tmp/caller-mutated.jsonl");
  convCopy.generations[0]!.path = "/tmp/caller-rewritten.jsonl";
  expect(registry.conversation(id)!.continuityPaths).toEqual([]);
  expect(registry.conversation(id)!.generations[0]!.path).toBe("/tmp/warm-1.jsonl");

  const pathCopy = registry.conversationForPath("/tmp/warm-1.jsonl")!;
  pathCopy.continuityPaths.push("/tmp/path-mutated.jsonl");
  expect(registry.conversationForPath("/tmp/warm-1.jsonl")!.continuityPaths).toEqual([]);

  const routingCopy = registry.engineRouting("codex");
  routingCopy.revision = 9999;
  expect(registry.engineRouting("codex").revision).not.toBe(9999);
});

test("readImmutable normalizes legacy migration continuity paths identically to mutable read", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-legacy-immutable-"));
  directories.push(directory);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  registries.push(registry);
  const conversation = registry.ensureConversation("codex", "/tmp/legacy-current.jsonl", null);
  const id = conversation.id;

  // Rewrite the stored conversation row via a second SQLite connection to store a
  // legacy migration continuity path that is absent from top-level continuityPaths.
  const sqliteFile = path.join(directory, "agent-registry.sqlite");
  const rawPeer = new Database(sqliteFile);
  const stored = rawPeer.query<{ value_json: string }, [string]>(
    "SELECT value_json FROM registry_rows WHERE collection = 'conversations' AND row_key = ?",
  ).get(id)!;
  const legacyRow = JSON.parse(stored.value_json) as Record<string, unknown>;
  legacyRow.continuityPaths = [];
  legacyRow.migration = {
    intentId: "intent_legacy_imm",
    targetId: "acct-b",
    phase: "committed",
    revision: 1,
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    continuityPaths: ["/tmp/legacy-migrated.jsonl"],
  };
  rawPeer.query("UPDATE registry_rows SET value_json = ? WHERE collection = 'conversations' AND row_key = ?")
    .run(JSON.stringify(legacyRow), id);
  rawPeer.close();

  const mutablePaths = registry.agentStateRead(file => file.conversations[id]!.continuityPaths);
  const immutablePaths = registry.readImmutable(file => [...file.conversations[id]!.continuityPaths]);
  expect(immutablePaths).toEqual(mutablePaths);
  expect(immutablePaths).toContain("/tmp/legacy-migrated.jsonl");
  expect(registry.conversationTranscriptPaths(id)).toEqual(["/tmp/legacy-migrated.jsonl", "/tmp/legacy-current.jsonl"]);
});
