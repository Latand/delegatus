import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* The chart for any listed account: a named account answers from its stored
   history and the registry's latest observation, and makes no provider read. */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-burndown-test-"));
const OLD_ENV = {
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  LLV_CODEX_HOME: process.env.LLV_CODEX_HOME,
  LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME,
};
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy-codex");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");
fs.mkdirSync(process.env.LLV_CLAUDE_HOME, { recursive: true });

const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { agentRegistry } = await import("@/lib/agent/registry");
const { recordLimitSample } = await import("./limitsHistoryStore");
const { readAccountBurndown } = await import("./limits");
const historyRoute = await import("@/app/api/limits/history/route");
const { attributeQuotaFixture } = await import("./limitsQuota.fixture");

const NOW = Math.round(Date.now() / 1000);
const WEEK = 7 * 86_400;

let claudeId = "";
let codexId = "";
let codexSessions = "";
const fetchCalls: string[] = [];
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
  fetchCalls.push(String(input));
  throw new Error("no provider read is allowed here");
}) as unknown as typeof fetch);

function observe(engine: "claude" | "codex", accountId: string, usedPercent: number, observedSecondsAgo: number): void {
  const observedAt = NOW - observedSecondsAgo;
  agentRegistry().recordQuotaObservation({
    engine,
    accountId,
    authenticated: true,
    authCheckedAt: new Date(observedAt * 1000).toISOString(),
    limits: { session: null, weekly: { usedPercent, resetsAt: NOW + 4 * 86_400, windowMinutes: 10_080 }, plan: "pro", capturedAt: observedAt },
    provenance: { source: "live", reason: null, staleSince: null },
    observedAt: new Date(observedAt * 1000).toISOString(),
    bootId: "test-boot",
  });
}

beforeAll(() => {
  claudeId = createManagedClaudeAccount("Claude Two").id;
  const codex = createManagedCodexAccount("Codex Two");
  codexId = codex.id;
  codexSessions = codex.sessionsDir;
});

afterEach(() => {
  fetchCalls.length = 0;
});

afterAll(() => {
  fetchSpy.mockRestore();
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("an inactive Claude account charts its stored history plus the registry observation, with no provider read", async () => {
  recordLimitSample("claude", claudeId, { session: null, weekly: { usedPercent: 20, resetsAt: NOW + 4 * 86_400, windowMinutes: 10_080 }, plan: "pro", capturedAt: NOW - 7_200 }, "live", (NOW - 7_200) * 1000);
  observe("claude", claudeId, 35, 300);
  const payload = await readAccountBurndown("claude", claudeId);
  expect(payload).not.toBeNull();
  expect(payload!.claudeAccountId).toBe(claudeId);
  expect(payload!.codexAccountId).toBeNull();
  expect(payload!.codex).toBeNull();
  const weekly = payload!.claude!.weekly;
  expect(weekly.samples.map((sample) => sample.remaining)).toEqual([80, 65]);
  // The observation stands at the time it was taken, five minutes ago, not at now.
  expect(weekly.samples[1]!.t).toBe(NOW - 300);
  expect(weekly.lastReading).toEqual(weekly.samples[1]!);
  expect(fetchCalls).toEqual([]);
});

test("an inactive Claude account the registry never observed answers an empty series, not an error", async () => {
  const other = createManagedClaudeAccount("Claude Unobserved").id;
  const payload = await readAccountBurndown("claude", other);
  expect(payload!.claudeAccountId).toBe(other);
  expect(payload!.claude!.weekly.samples).toEqual([]);
  expect(payload!.claude!.weekly.lastReading).toBeNull();
  expect(fetchCalls).toEqual([]);
});

test("an inactive Codex account adds its transcript backfill to the stored history", async () => {
  observe("codex", codexId, 30, 120);
  const day = new Date((NOW - 3_600) * 1000).toISOString();
  const dir = path.join(codexSessions, day.slice(0, 4), day.slice(5, 7), day.slice(8, 10));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, JSON.stringify({ timestamp: day, payload: { rate_limits: { secondary: { used_percent: 25, window_minutes: 10_080, resets_at: NOW + 4 * 86_400 }, plan_type: "pro" } } }) + "\n");
  attributeQuotaFixture(file, codexId);
  const payload = await readAccountBurndown("codex", codexId);
  expect(payload!.codexAccountId).toBe(codexId);
  expect(payload!.claude).toBeNull();
  expect(payload!.codex!.weekly.samples.map((sample) => sample.remaining)).toEqual([75, 70]);
  expect(fetchCalls).toEqual([]);
});

test("opening the same Codex account history twice reuses its transcript scan", async () => {
  const account = createManagedCodexAccount("Codex Cached Panel");
  const sessions = account.sessionsDir;
  const original = fs.readdirSync;
  let transcriptDirectoryReads = 0;
  const scan = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]).startsWith(sessions)) transcriptDirectoryReads++;
    return original(...args);
  }) as typeof fs.readdirSync);
  try {
    const first = await get(`?engine=codex&account=${encodeURIComponent(account.id)}`);
    expect(first.status).toBe(200);
    const readsAfterFirstOpen = transcriptDirectoryReads;
    expect(readsAfterFirstOpen).toBeGreaterThan(0);

    const second = await get(`?engine=codex&account=${encodeURIComponent(account.id)}`);
    expect(second.status).toBe(200);
    expect(transcriptDirectoryReads).toBe(readsAfterFirstOpen);
  } finally {
    scan.mockRestore();
  }
});

test("an unknown or hostile id is not an account", async () => {
  for (const id of ["nope", "../x", "%00", "claude-two/../../etc", ""]) {
    expect(await readAccountBurndown("claude", id)).toBeNull();
    expect(await readAccountBurndown("codex", id)).toBeNull();
  }
  // An id that exists for one engine is not an account of the other.
  expect(await readAccountBurndown("codex", claudeId)).toBeNull();
  expect(await readAccountBurndown("claude", codexId)).toBeNull();
});

test("the engine's active account answers through the live path, stamped with its id", async () => {
  const payload = await readAccountBurndown("claude", "default");
  expect(payload?.claudeAccountId).toBe("default");
  expect(payload?.claude).not.toBeNull();
});

const get = (query: string) => historyRoute.GET(new Request(`http://127.0.0.1/api/limits/history${query}`));

test("the history route answers 400 for a lone or malformed parameter", async () => {
  expect((await get("?engine=claude")).status).toBe(400);
  expect((await get("?account=x")).status).toBe(400);
  expect((await get("?engine=copilot&account=x")).status).toBe(400);
  expect((await get("?engine=claude&account=")).status).toBe(400);
  expect((await get(`?engine=claude&account=${"a".repeat(201)}`)).status).toBe(400);
});

test("the history route answers 404 for an unknown or hostile account and 200 with the stamped id for a listed one", async () => {
  expect((await get("?engine=codex&account=nope")).status).toBe(404);
  expect((await get(`?engine=claude&account=${encodeURIComponent("../../x")}`)).status).toBe(404);
  expect((await get(`?engine=claude&account=${encodeURIComponent("\0")}`)).status).toBe(404);
  const ok = await get(`?engine=claude&account=${encodeURIComponent(claudeId)}`);
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.claudeAccountId).toBe(claudeId);
  expect(body.codexAccountId).toBeNull();
  expect(fetchCalls).toEqual([]);
});
