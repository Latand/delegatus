import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import * as scannerProcess from "./process";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-effort-test-"));
let argvByPid = new Map<number, string[]>();

const readArgv = spyOn(scannerProcess, "readArgv").mockImplementation((pid) => argvByPid.get(pid) ?? []);

const { entryEffort } = await import("./effort");

afterAll(() => {
  readArgv.mockRestore();
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

test("the scanner reads recorded tiers for generation, alias and receipt paths and sees profile updates", async () => {
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { durableServiceTierIndexForPaths } = await import("./effort");
  const filename = path.join(SANDBOX, "keyed-tiers.json");
  const generation = writeJsonl(".codex/generation-tier.jsonl", []);
  const alias = writeJsonl(".codex/alias-tier.jsonl", []);
  const receiptPath = writeJsonl(".codex/receipt-tier.jsonl", []);
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  const conversation = seed.ensureConversation("codex", generation, null);
  seed.updateConversationLaunchProfile(conversation.id, { model: null, effort: null, fast: true, serviceTier: "ultrafast" });
  const begun = seed.beginSpawnRequest({
    engine: "codex",
    cwd: SANDBOX,
    launchProfile: { title: "Record receipt tier", serviceTier: "priority" },
  });
  const snapshot = seed.snapshot();
  seed.close();
  snapshot.conversations[conversation.id]!.continuityPaths.push(alias);
  snapshot.receipts[begun.receipt.launchId]!.artifactPath = receiptPath;
  fs.writeFileSync(filename, JSON.stringify(snapshot));

  let snapshotLoads = 0;
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "sqlite",
    onSqliteSnapshotLoad: () => { snapshotLoads += 1; },
  });
  try {
    const missing = Array.from({ length: 30 }, (_, index) => path.join(SANDBOX, `missing-${index}.jsonl`));
    const paths = [generation, ...missing.slice(0, 15), receiptPath, ...missing.slice(15), alias];
    const readTiers = async () => {
      const loadsBefore = snapshotLoads;
      const tiers = await durableServiceTierIndexForPaths(paths, registry);
      expect(snapshotLoads).toBe(loadsBefore);
      expect(tiers.size).toBe(paths.length);
      for (const pathname of missing) expect(tiers.get(pathname)).toBeNull();
      expect(tiers.get(receiptPath)).toBe("priority");
      return tiers;
    };
    const tiers = await readTiers();
    expect(tiers.get(generation)).toBe("ultrafast");
    expect(tiers.get(alias)).toBe("ultrafast");

    registry.updateConversationLaunchProfile(conversation.id, { model: null, effort: null, fast: false, serviceTier: "default" });
    const refreshed = await readTiers();
    expect(refreshed.get(generation)).toBe("default");
    expect(refreshed.get(alias)).toBe("default");
  } finally { registry.close(); }
});
