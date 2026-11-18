import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import type { RegistryFile } from "../agent/registry";
import * as scannerProcess from "./process";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-effort-test-"));
let argvByPid = new Map<number, string[]>();

mock.module("./process", () => ({
  ...scannerProcess,
  agentProcesses: () => [],
  argvEngine: () => null,
  isHelperArgv: () => false,
  outputHolders: () => new Map(),
  pidAlive: () => false,
  pidHoldsPath: () => false,
  pidWritesPath: () => false,
  readArgv: (pid: number) => argvByPid.get(pid) ?? [],
  readCmdlineText: () => "",
  readCwd: () => null,
  readEnvVar: () => null,
  readPpid: () => null,
  writingHolders: () => new Map(),
}));

const { entryEffort } = await import("./effort");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  argvByPid = new Map();
});

function entry(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname,
    root: pathname.includes(".codex") ? "codex-sessions" : "claude-projects",
    name: path.basename(pathname),
    project: "proj",
    title: "agent",
    engine: pathname.includes(".codex") ? "codex" : "claude",
    kind: "session",
    fmt: pathname.includes(".codex") ? "codex" : "claude",
    parent: null,
    mtime: 1,
    size: fs.statSync(pathname).size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function writeJsonl(name: string, rows: unknown[]): string {
  const pathname = path.join(SANDBOX, name);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return pathname;
}

describe("entryEffort", () => {
  test("reads Claude thinking blocks from JSONL when argv has no explicit effort", () => {
    const pathname = writeJsonl("claude-thinking.jsonl", [
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: "done" },
          ],
        },
      },
    ]);

    expect(entryEffort(entry(pathname))).toBe("high");
  });

  test("keeps explicit Claude argv effort ahead of JSONL thinking fallback", () => {
    const pathname = writeJsonl("claude-argv.jsonl", [
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "", signature: "sig" }] },
      },
    ]);
    argvByPid.set(42, ["claude", "--effort", "max"]);

    expect(entryEffort(entry(pathname, { pid: 42 }))).toBe("max");
  });
});

/* OpenClaw fixtures (#1207). Every id and level below is invented. */
describe("entryEffort for OpenClaw", () => {
  function openclawEntry(name: string, rows: unknown[]): FileEntry {
    const pathname = writeJsonl(name, rows);
    return entry(pathname, { root: "openclaw-sessions", engine: "openclaw", fmt: "openclaw" });
  }
  const thinkingLevel = (level: string, id: string) => ({
    type: "thinking_level_change",
    id,
    parentId: "oc-parent",
    timestamp: "2026-08-27T09:00:00.000Z",
    thinkingLevel: level,
  });

  test("reads the latest thinking_level_change", () => {
    expect(entryEffort(openclawEntry("openclaw-effort.jsonl", [
      { type: "session", version: 3, id: "oc-session-alpha", timestamp: "2026-08-27T08:59:00.000Z", cwd: SANDBOX },
      thinkingLevel("low", "oc-level-1"),
      thinkingLevel("high", "oc-level-2"),
    ]))).toBe("high");
  });

  test("accepts the two tiers only OpenClaw has", () => {
    expect(entryEffort(openclawEntry("openclaw-off.jsonl", [thinkingLevel("off", "oc-level-off")]))).toBe("off");
    expect(entryEffort(openclawEntry("openclaw-adaptive.jsonl", [thinkingLevel("adaptive", "oc-level-adaptive")])))
      .toBe("adaptive");
  });

  test("an unrecognised level reports no effort", () => {
    expect(entryEffort(openclawEntry("openclaw-unknown.jsonl", [thinkingLevel("turbo", "oc-level-unknown")])))
      .toBeNull();
  });
});

test("service tier reads arbitrary catalog ids from argv and the newest applied thread setting", async () => {
  const { entryServiceTier } = await import("./effort");
  const file = writeJsonl(".codex/service-tier.jsonl", [
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } },
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "ultrafast" } } },
  ]);
  const record = entry(file);
  expect(entryServiceTier(record)).toBe("ultrafast");
  argvByPid.set(987, ["codex", "-c", "service_tier=standard"]);
  expect(entryServiceTier({ ...record, pid: 987 })).toBe("default");
  argvByPid.set(987, ["codex", "-c", "service_tier=ultrafast"]);
  expect(entryServiceTier({ ...record, pid: 987 })).toBe("ultrafast");
});

test("service tier stays unknown after newer settings leave the transcript tail", async () => {
  const { entryServiceTier } = await import("./effort");
  const settings = (tier: string) => ({
    type: "event_msg",
    payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } },
  });
  const file = writeJsonl(".codex/service-tier-scrolled.jsonl", [
    settings("ultrafast"),
    ...Array.from({ length: 50 }, () => ({ type: "event_msg", payload: { type: "task_complete" } })),
    settings("default"),
  ]);
  expect(entryServiceTier(entry(file))).toBe("default");
  fs.appendFileSync(file, Array.from({ length: 150 }, () => JSON.stringify({
    type: "event_msg", payload: { type: "agent_message", message: "x".repeat(1024) },
  })).join("\n") + "\n");
  const grown = entry(file, { mtime: 2 });
  expect(entryServiceTier(grown)).toBeNull();
});

test("a scrolled-out tier uses the durable profile for the pill without reviving stale settings", async () => {
  const { agentRegistry } = await import("../agent/registry");
  const { entryServiceTier } = await import("./effort");
  const { defaults } = await import("@/components/runtimeProfile");
  const settings = (tier: string) => ({
    type: "event_msg",
    payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } },
  });
  const file = writeJsonl(".codex/durable-service-tier.jsonl", [
    settings("ultrafast"),
    ...Array.from({ length: 200 }, () => ({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(1024) } })),
  ]);
  const registry = agentRegistry();
  const conversation = registry.ensureConversation("codex", file, null);
  registry.updateConversationLaunchProfile(conversation.id, {
    model: "gpt-6-astra", effort: "high", fast: true, serviceTier: "ultrafast",
  });
  const record = entry(file, { model: "gpt-6-astra", effort: "high" });
  record.serviceTier = entryServiceTier(record);
  record.fast = record.serviceTier === null ? null : record.serviceTier !== "default";
  expect(record.serviceTier).toBe("ultrafast");
  expect(defaults(record).fast).toBeTrue();
  // A profile change must be visible even when the transcript cache identity stays the same.
  registry.updateConversationLaunchProfile(conversation.id, { model: "gpt-6-astra", effort: "high", fast: false, serviceTier: null });
  expect(entryServiceTier(record)).toBe("default");
  record.serviceTier = entryServiceTier(record);
  record.fast = record.serviceTier === null ? null : record.serviceTier !== "default";
  expect(defaults(record).fast).toBeFalse();
  fs.appendFileSync(file, JSON.stringify(settings("priority")) + "\n");
  expect(entryServiceTier(entry(file, { mtime: 2 }))).toBe("priority");
});

function fullTierWalk(snapshot: RegistryFile): Map<string, string | null> {
  const tiers = new Map<string, string | null>();
  const put = (pathname: string, { serviceTier, fast }: { serviceTier?: string | null; fast?: boolean | null }) => {
    if (tiers.has(pathname)) return;
    const tier = serviceTier && /^[a-z][a-z0-9_-]{0,31}$/.test(serviceTier) ? serviceTier : null;
    tiers.set(pathname, tier === "standard" ? "default" : tier ?? (fast === true ? "priority" : fast === false ? "default" : null));
  };
  for (const row of Object.values(snapshot.conversations)) {
    for (const generation of row.generations) put(generation.path, generation.launchProfile);
    const current = row.generations.at(-1);
    if (current) for (const alias of row.continuityPaths) put(alias, current.launchProfile);
  }
  for (const receipt of Object.values(snapshot.receipts)) {
    if (receipt.artifactPath) put(receipt.artifactPath, receipt.launchProfile);
  }
  return tiers;
}

test.each(["sqlite", "off"] as const)("scanner tiers agree with the full walk across registry changes (%s)", async sqliteMode => {
  const { AgentRegistry, normalizeRegistry, RegistryReadError } = await import("../agent/registry");
  const { SqliteAgentRegistryStore } = await import("../agent/sqliteRegistryStore");
  const { durableServiceTierIndex } = await import("./effort");
  const dir = fs.mkdtempSync(path.join(SANDBOX, "tier-registry-"));
  const json = path.join(dir, "registry.json");
  const sqlite = path.join(dir, "registry.sqlite");
  const at = "2026-01-01T00:00:00.000Z";
  const generation = (name: string, serviceTier: string | null, fast: boolean | null = null) => ({
    id: name, path: `/fixture/${name}.jsonl`, createdAt: at, launchProfile: { serviceTier, fast },
  });
  const conversation = (id: string, generations: ReturnType<typeof generation>[], continuityPaths: string[] = []) => ({
    id, engine: "codex", createdAt: at, updatedAt: at, generations, continuityPaths,
  });
  const older = generation("older", "standard");
  const current = generation("current", "invalid tier", true);
  const collision = generation("collision", "default");
  const alias = "/fixture/continuity.jsonl";
  const receiptPath = "/fixture/receipt.jsonl";
  const receipt = (launchId: string, artifactPath: string | null, serviceTier: string) => ({
    launchId, conversationId: "conversation_receipt", engine: "codex", createdAt: at, state: "completed",
    artifactPath, launchProfile: { serviceTier },
  });
  const initial = normalizeRegistry({ version: 2, entries: {}, conversations: {
    conversation_primary: conversation("conversation_primary", [older, current], [alias, collision.path, older.path]),
    conversation_later: conversation("conversation_later", [collision]),
    conversation_empty: conversation("conversation_empty", [], [receiptPath]),
    conversation_unknown: conversation("conversation_unknown", [generation("unknown", null)]),
    ...Object.fromEntries(Array.from({ length: 256 }, (_, n) => {
      const id = `conversation_history_${n}`;
      return [id, conversation(id, [generation(`history-${n}`, "default")])];
    })),
  }, receipts: {
    first: receipt("first", older.path, "ultrafast"),
    later: receipt("later", older.path, "default"),
    archived: receipt("archived", receiptPath, "ultrafast"),
    unknown: receipt("unknown", "/fixture/unknown.jsonl", "priority"),
    noPath: receipt("noPath", null, "priority"),
    ...Object.fromEntries(Array.from({ length: 256 }, (_, n) => {
      const id = `receipt-history-${n}`;
      return [id, receipt(id, `/fixture/${id}.jsonl`, "default")];
    })),
  } });
  const paths = [
    older.path, current.path, alias, collision.path, receiptPath, "/fixture/unknown.jsonl",
    ...Array.from({ length: 30 }, (_, n) => `/fixture/missing-${n}.jsonl`),
  ];
  const peer = sqliteMode === "sqlite" ? new SqliteAgentRegistryStore(sqlite, { initialSnapshot: initial, normalize: normalizeRegistry }) : null;
  const saveJson = () => {
    fs.writeFileSync(`${json}.next`, JSON.stringify(initial));
    fs.renameSync(`${json}.next`, json);
  };
  if (peer) {
    while (peer.archiveInactive(250)) { /* Populate real cold mappings. */ }
    const db = new Database(sqlite, { readonly: true });
    try {
      expect(db.query("SELECT collection, count(*) AS count FROM registry_cold GROUP BY collection ORDER BY collection").all())
        .toEqual([{ collection: "conversations", count: 260 }, { collection: "receipts", count: 261 }]);
    } finally { db.close(); }
  } else saveJson();
  let loads = 0, conversationReads = 0, receiptReads = 0;
  const open = () => new AgentRegistry(json, undefined, undefined, {
    sqliteMode, sqliteFilename: sqlite, deferColdKeyInitialization: true, now: () => Date.parse(at),
    onSqliteSnapshotLoad: () => { loads++; },
    onSqliteRowPayloadRead: (collection, count) => {
      if (collection === "conversations") conversationReads += count;
      if (collection === "receipts") receiptReads += count;
    },
  });
  let registry = open();
  const edit = (change: (file: RegistryFile) => void) => {
    if (peer) peer.mutate(change, false);
    else { change(initial); saveJson(); }
  };
  const compare = async (expected: (string | null)[]) => {
    const full = fullTierWalk(peer ? peer.readOnlySnapshot().file : registry.readOnlySnapshot());
    for (let scan = 0; scan < 2; scan++) {
      loads = conversationReads = receiptReads = 0;
      const actual = await durableServiceTierIndex(paths, registry);
      expect(actual).toEqual(new Map(paths.map(pathname => [pathname, full.get(pathname) ?? null])));
      expect(paths.slice(0, expected.length).map(pathname => actual.get(pathname))).toEqual(expected);
      expect(loads).toBe(0);
      expect(conversationReads).toBeLessThanOrEqual(6);
      expect(receiptReads).toBeLessThanOrEqual(2);
    }
  };
  try {
    await compare(["default", "priority", "priority", "priority", "ultrafast", null]);
    edit(file => {
      file.conversations.conversation_primary!.generations.at(-1)!.launchProfile = {
        ...file.conversations.conversation_primary!.generations.at(-1)!.launchProfile, serviceTier: null, fast: false,
      };
    });
    await compare(["default", "default", "default", "default", "ultrafast", null]);
    edit(file => {
      delete file.conversations.conversation_primary;
      delete file.receipts.archived;
    });
    await compare(["ultrafast", null, null, "default", null, null]);
    edit(file => { delete file.receipts.first; });
    await compare(["default", null, null, "default", null, null]);
    registry.close();
    registry = open();
    await compare(["default", null, null, "default", null, null]);
    const unreadable = spyOn(registry, "launchTierProfilesForPaths").mockImplementation(() => { throw new RegistryReadError("unreadable fixture"); });
    expect((await durableServiceTierIndex(paths, registry)).size).toBe(0);
    unreadable.mockImplementation(() => { throw new Error("unexpected fixture error"); });
    await expect(durableServiceTierIndex(paths, registry)).rejects.toThrow("unexpected fixture error");
    unreadable.mockRestore();
  } finally {
    registry.close();
    peer?.close();
  }
});
