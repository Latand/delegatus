import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-effort-test-"));
let argvByPid = new Map<number, string[]>();

mock.module("./process", () => ({
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

test("a scan indexes durable tiers once for registered and missing paths, then refreshes on the next scan", async () => {
  const { agentRegistry } = await import("../agent/registry");
  const { durableServiceTierIndex, entryServiceTier } = await import("./effort");
  const registry = agentRegistry();
  const file = writeJsonl(".codex/indexed-tier.jsonl", []);
  const alias = writeJsonl(".codex/indexed-alias.jsonl", []);
  const missing = writeJsonl(".codex/indexed-missing.jsonl", []);
  const conversation = registry.ensureConversation("codex", file, null);
  registry.updateConversationLaunchProfile(conversation.id, { model: "gpt-6-astra", effort: "high", fast: true, serviceTier: "ultrafast" });
  const snapshot = structuredClone(registry.readOnlySnapshot());
  const original = snapshot.conversations[conversation.id]!;
  const synthetic = { ...snapshot, conversations: { [original.id]: { ...original, continuityPaths: [alias] } }, receipts: {} };
  for (let i = 0; i < 2000; i += 1) {
    synthetic.conversations[`conversation_synthetic-${i}`] = { ...original, id: `conversation_synthetic-${i}`, generations: [{ ...original.generations[0]!, path: `synthetic/${i}.jsonl` }], continuityPaths: [] };
  }
  const receipt = { artifactPath: file, launchProfile: { serviceTier: "priority" } };
  synthetic.receipts = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`receipt-${i}`, { ...receipt, artifactPath: i === 0 ? file : `receipt/${i}.jsonl` }])) as typeof snapshot.receipts;
  const reads = spyOn(registry, "readOnlySnapshot").mockReturnValue(synthetic);
  const lookup = spyOn(registry, "launchProfileForPath").mockImplementation(() => { throw new Error("scan performed a linear lookup"); });
  try {
    const tiers = durableServiceTierIndex(registry);
    const registeredEntry = entry(file), missingEntry = entry(missing);
    for (let i = 0; i < 2000; i += 1) {
      expect(entryServiceTier(i % 2 ? missingEntry : registeredEntry, tiers)).toBe(i % 2 ? null : "ultrafast");
    }
    expect(entryServiceTier(entry(alias), tiers)).toBe("ultrafast");
    expect(tiers.get("receipt/1.jsonl")).toBe("priority");
    expect(reads).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    synthetic.conversations[original.id]!.generations[0]!.launchProfile = { ...original.generations[0]!.launchProfile, serviceTier: "default" };
    const refreshed = durableServiceTierIndex(registry);
    expect(entryServiceTier(entry(file), refreshed)).toBe("default");
  } finally {
    reads.mockRestore(); lookup.mockRestore();
  }
});
