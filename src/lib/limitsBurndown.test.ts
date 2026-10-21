import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computePace } from "./burndown";
import { buildSeries, collectCodexRateLimitSeries, readCodexLimits, readCodexTranscriptLimits } from "./limits";
import { agentRegistry, closeAgentRegistryForTests } from "./agent/registry";
import { emptyLaunchProfile } from "./accounts/migration/contracts";
import { attributeQuotaFixture, updateQuotaRegistryFixture } from "./limitsQuota.fixture";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-series-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a Codex session JSONL under YYYY/MM/DD derived from `day`. */
function writeSession(name: string, day: string, events: { ts: string; primary?: [number, number, number]; secondary?: [number, number, number] }[], attributed = true, sessionsRoot = root): void {
  const [y, m, d] = day.split("-");
  const dir = path.join(sessionsRoot, y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const win = (w?: [number, number, number]) =>
    w ? { used_percent: w[0], window_minutes: w[1], resets_at: w[2] } : undefined;
  const lines = events.map((e) =>
    JSON.stringify({
      timestamp: e.ts,
      payload: { rate_limits: { primary: win(e.primary), secondary: win(e.secondary), plan_type: "pro" } },
    }),
  );
  fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n", "utf8");
  if (attributed) attributeQuotaFixture(path.join(dir, name), "fixture");
}

test("reconstructs primary/secondary curves across events with window metadata", () => {
  const reset5h = 1_783_544_991;
  const resetWeek = 1_783_994_379;
  writeSession("s.jsonl", "2026-07-08", [
    { ts: "2026-07-08T15:00:00.000Z", primary: [10, 300, reset5h], secondary: [40, 10080, resetWeek] },
    { ts: "2026-07-08T17:28:49.000Z", primary: [35, 300, reset5h], secondary: [58, 10080, resetWeek] },
  ]);
  const series = collectCodexRateLimitSeries(root, 0, "fixture");
  expect(series.session).toEqual([
    { t: Math.round(Date.parse("2026-07-08T15:00:00.000Z") / 1000), remaining: 90 },
    { t: Math.round(Date.parse("2026-07-08T17:28:49.000Z") / 1000), remaining: 65 },
  ]);
  expect(series.weekly.map((s) => s.remaining)).toEqual([60, 42]);
  // Newest event fixes each window definition.
  expect(series.sessionWindowSeconds).toBe(300 * 60);
  expect(series.weeklyWindowSeconds).toBe(10080 * 60);
  expect(series.sessionResetsAt).toBe(reset5h);
  expect(series.weeklyResetsAt).toBe(resetWeek);
});

test("a weekly-only stream backfills the weekly curve, not the 5h one", () => {
  // The plan behind issue #606 reports a single 10080-minute window, and it
  // arrives in the primary slot: the declared length, not the slot, decides.
  const resetWeek = 1_783_994_379;
  writeSession("weekly-only.jsonl", "2026-07-08", [
    { ts: "2026-07-08T15:00:00.000Z", primary: [15, 10080, resetWeek] },
    { ts: "2026-07-08T17:28:49.000Z", primary: [22, 10080, resetWeek] },
  ]);
  const series = collectCodexRateLimitSeries(root, 0, "fixture");
  expect(series.weekly.map((s) => s.remaining)).toEqual([85, 78]);
  expect(series.weeklyWindowSeconds).toBe(10080 * 60);
  expect(series.weeklyResetsAt).toBe(resetWeek);
  expect(series.session).toEqual([]);
  expect(series.sessionWindowSeconds).toBeNull();
  expect(series.sessionResetsAt).toBeNull();
});

test("drops events older than the cutoff and dedupes identical timestamps", () => {
  const reset = 1_783_544_991;
  writeSession("a.jsonl", "2026-07-08", [
    { ts: "2026-07-08T10:00:00.000Z", primary: [10, 300, reset] },
    { ts: "2026-07-08T12:00:00.000Z", primary: [20, 300, reset] },
    { ts: "2026-07-08T12:00:00.000Z", primary: [99, 300, reset] }, // duplicate second → ignored
  ]);
  const cutoff = Math.round(Date.parse("2026-07-08T11:00:00.000Z") / 1000);
  const series = collectCodexRateLimitSeries(root, cutoff, "fixture");
  expect(series.session).toEqual([{ t: Math.round(Date.parse("2026-07-08T12:00:00.000Z") / 1000), remaining: 80 }]);
});

test("returns empty series for a sessions dir with no transcripts", () => {
  const series = collectCodexRateLimitSeries(path.join(root, "missing"), 0, "fixture");
  expect(series.session).toEqual([]);
  expect(series.weekly).toEqual([]);
  expect(series.sessionResetsAt).toBeNull();
});

test("mixed-store backfill drops foreign, unknown and ambiguous account readings", () => {
  const day = "2026-07-08", ts = `${day}T12:00:00.000Z`;
  for (const [name, used] of [["own", 15], ["foreign", 96], ["unknown", 85], ["ambiguous", 99]] as const) {
    writeSession(`${name}.jsonl`, day, [{ ts, primary: [used, 10080, 1_783_994_379] }], false);
    if (name === "unknown") continue;
    const file = path.join(root, "2026", "07", "08", `${name}.jsonl`);
    const registry = agentRegistry();
    const conversation = registry.ensureConversation("codex", file, name === "foreign" ? "b" : "a");
    updateQuotaRegistryFixture(state => {
      const generation = state.conversations[conversation.id]!.generations[0]!;
      generation.createdAt = `${day}T00:00:00.000Z`;
      generation.host = { kind: "codex-app-server", identity: "fixture-host", epoch: 1, verifiedAt: generation.createdAt,
      };
      if (generation.accountId) generation.quotaCustody = { accountId: generation.accountId, artifactPath: generation.path };
      if (name === "ambiguous") state.conversations[conversation.id]!.generations.push({
        ...generation, id: "second", accountId: "b", quotaCustody: { accountId: "b", artifactPath: file },
      });
    });
  }
  expect(collectCodexRateLimitSeries(root, 0, "a").weekly).toEqual([{ t: Date.parse(ts) / 1000, remaining: 85 }]);
  expect(collectCodexRateLimitSeries(root, 0, "b").weekly).toEqual([{ t: Date.parse(ts) / 1000, remaining: 4 }]);
});

test.each(["unverified", "before-start", "host-after-event", "archived", "continuity", "wrong-engine", "conflict", "unavailable"])("%s custody cannot enter backfill, live reconciliation or offline fallback", async kind => {
  const ts = "2026-07-08T12:00:00.000Z", at = Date.parse(ts);
  writeSession("untrusted.jsonl", "2026-07-08", [{ ts, primary: [100, 10080, at / 1000 + 86400] }]);
  const file = path.join(root, "2026", "07", "08", "untrusted.jsonl"), registry = agentRegistry();
  const conversation = registry.conversationForPath(file)!;
  updateQuotaRegistryFixture(state => {
    const row = state.conversations[conversation.id]!, generation = row.generations[0]!;
    if (kind === "unverified") generation.host = null;
    if (kind === "before-start") generation.createdAt = "2026-07-08T13:00:00.000Z";
    if (kind === "host-after-event") generation.host!.verifiedAt = "2026-07-08T13:00:00.000Z";
    if (kind === "archived") generation.archivedAt = ts;
    if (kind === "continuity") { generation.path = path.join(root, "source.jsonl"); row.continuityPaths.push(file); }
    if (kind === "wrong-engine") row.engine = "claude";
    if (kind === "conflict") row.generations.push({ ...generation, id: "conflict", accountId: "foreign",
      quotaCustody: { accountId: "foreign", artifactPath: file } });
  });
  fs.appendFileSync(file, JSON.stringify({ timestamp: ts, payload: { codex_error_info: "usage_limit_exceeded" } }) + "\n");
  const refused = kind === "unavailable" ? spyOn(registry, "conversationForPath").mockImplementation(() => { throw new Error("fixture registry unavailable"); }) : null;
  try {
    expect(collectCodexRateLimitSeries(root, 0, "fixture").weekly).toEqual([]);
    expect(readCodexTranscriptLimits(root, "fixture").data).toBeNull();
    const account = { id: "fixture", kind: "managed" as const, home: path.dirname(root), sessionsDir: root };
    const live = await readCodexLimits({ account, now: () => at, liveReader: async () => ({
      primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: at / 1000 + 86400 }, secondary: null, planType: "pro",
    }) });
    expect(live.data?.weekly?.usedPercent).toBe(12);
    const offline = await readCodexLimits({ account, now: () => at, liveReader: async () => { throw new Error("fixture offline"); } });
    expect(offline.data).toBeNull();
  } finally { refused?.mockRestore(); }
});

test("same-path account succession attributes events by their generation time", () => {
  const ts = "2026-07-08T12:00:00.000Z", next = "2026-07-08T13:00:00.000Z";
  writeSession("resumed.jsonl", "2026-07-08", [
    { ts, primary: [15, 10080, 1_783_994_379] }, { ts: next, primary: [96, 10080, 1_783_994_379] },
  ]);
  const file = path.join(root, "2026", "07", "08", "resumed.jsonl"), registry = agentRegistry();
  const conversation = registry.conversationForPath(file)!;
  updateQuotaRegistryFixture(state => {
    const row = state.conversations[conversation.id]!, first = row.generations[0]!;
    first.archivedAt = next;
    row.generations.push({ ...first, id: "successor", accountId: "b", createdAt: next, archivedAt: null,
      host: { ...first.host!, verifiedAt: next }, quotaCustody: { accountId: "b", artifactPath: file } });
  });
  expect(collectCodexRateLimitSeries(root, 0, "fixture").weekly.map(s => s.remaining)).toEqual([85]);
  expect(collectCodexRateLimitSeries(root, 0, "b").weekly.map(s => s.remaining)).toEqual([4]);
  expect(readCodexTranscriptLimits(root, "fixture").data?.weekly?.usedPercent).toBe(15);
  expect(readCodexTranscriptLimits(root, "b").data?.weekly?.usedPercent).toBe(96);
});

test("same-path unverified account rebind quarantines old custody for live and offline reads", async () => {
  const before = "2026-07-08T12:00:00.000Z", rebound = "2026-07-08T13:00:00.000Z", after = "2026-07-08T14:00:00.000Z";
  writeSession("rebound.jsonl", "2026-07-08", [
    { ts: before, primary: [15, 10080, 1_783_994_379] },
    { ts: rebound, primary: [90, 10080, 1_783_994_379] },
  ]);
  const file = path.join(root, "2026", "07", "08", "rebound.jsonl"), registry = agentRegistry();
  fs.appendFileSync(file, JSON.stringify({ timestamp: after, payload: { rate_limits: {
    primary: { used_percent: 96, window_minutes: 10080, resets_at: 1_783_994_379 }, plan_type: "pro",
  } } }) + "\n");
  registry.reconcileConversations([{
    engine: "codex", path: file, accountId: "b", launchProfile: emptyLaunchProfile(), observedAt: rebound,
    turn: { state: "idle", source: "empty", terminalAt: null },
  }]);
  const accountA = { id: "fixture", kind: "managed" as const, home: path.dirname(root), sessionsDir: root };
  const accountB = { ...accountA, id: "b" };
  const series = collectCodexRateLimitSeries(root, 0, "fixture");
  expect(series.weekly).toEqual([]);
  expect(collectCodexRateLimitSeries(root, 0, "b").weekly).toEqual([]);
  expect(readCodexTranscriptLimits(root, "fixture").data).toBeNull();
  expect(readCodexTranscriptLimits(root, "b").data).toBeNull();
  expect((await readCodexLimits({ account: accountA, liveReader: async () => { throw new Error("offline"); } })).data).toBeNull();
  expect((await readCodexLimits({ account: accountB, liveReader: async () => { throw new Error("offline"); } })).data).toBeNull();
});

test.each(["changed", "returned", "legacy-returned"] as const)("delayed account-change observation quarantines uncertain custody after reload (%s)", async binding => {
  const before = "2026-07-08T12:00:00.000Z", foreign = "2026-07-08T13:00:00.000Z", observed = "2026-07-08T14:00:00.000Z";
  const reset = Date.parse("2026-07-09T12:00:00.000Z") / 1000;
  writeSession("delayed.jsonl", "2026-07-08", [
    { ts: before, primary: [15, 10080, reset] },
    { ts: foreign, primary: [96, 10080, reset] },
  ]);
  const file = path.join(root, "2026", "07", "08", "delayed.jsonl"), registry = agentRegistry();
  fs.appendFileSync(file, JSON.stringify({ timestamp: foreign, payload: { codex_error_info: "usage_limit_exceeded" } }) + "\n");
  const observation = {
    engine: "codex" as const, path: file, accountId: "b", launchProfile: emptyLaunchProfile(), observedAt: observed,
    turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
  };
  if (binding === "legacy-returned") {
    // Older registries could persist a contradictory binding without endedAt.
    const conversation = registry.conversationForPath(file)!;
    updateQuotaRegistryFixture(state => { state.conversations[conversation.id]!.generations[0]!.accountId = "b"; });
  } else {
    registry.reconcileConversations([observation]);
  }
  if (binding !== "changed") registry.reconcileConversations([{ ...observation, accountId: "fixture", observedAt: "2026-07-08T15:00:00.000Z" }]);
  // Read the persisted custody again, including a binding that returned to A.
  closeAgentRegistryForTests();
  for (const id of ["fixture", "b"]) {
    expect(collectCodexRateLimitSeries(root, 0, id).weekly).toEqual([]);
    const transcript = readCodexTranscriptLimits(root, id);
    expect(transcript.data).toBeNull();
    expect(transcript.rejectedAt).toBeUndefined();
    const account = { id, kind: "managed" as const, home: path.dirname(root), sessionsDir: root };
    const offline = await readCodexLimits({ account, now: () => Date.parse(observed), liveReader: async () => { throw new Error("offline"); } });
    expect(offline.data).toBeNull();
    const live = await readCodexLimits({ account, now: () => Date.parse(observed), liveReader: async () => ({
      primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: reset }, secondary: null, planType: "pro",
    }) });
    expect(live.data?.weekly?.usedPercent).toBe(12);
    expect(live.source).toBe("live");
  }
});

test("overlapping verified custody for different accounts quarantines the transcript event", async () => {
  const ts = "2026-07-08T12:00:00.000Z";
  writeSession("conflicted.jsonl", "2026-07-08", [{ ts, primary: [15, 10080, 1_783_994_379] }]);
  const file = path.join(root, "2026", "07", "08", "conflicted.jsonl"), registry = agentRegistry();
  const conversation = registry.conversationForPath(file)!;
  updateQuotaRegistryFixture(state => {
    const generation = state.conversations[conversation.id]!.generations[0]!;
    state.conversations[conversation.id]!.generations.push({ ...generation, id: "second", accountId: "b",
      quotaCustody: { accountId: "b", artifactPath: file } });
  });
  expect(collectCodexRateLimitSeries(root, 0, "fixture").weekly).toEqual([]);
  expect(collectCodexRateLimitSeries(root, 0, "b").weekly).toEqual([]);
  expect(readCodexTranscriptLimits(root, "fixture").data).toBeNull();
  expect(readCodexTranscriptLimits(root, "b").data).toBeNull();
  for (const id of ["fixture", "b"]) {
    const account = { id, kind: "managed" as const, home: path.dirname(root), sessionsDir: root };
    expect((await readCodexLimits({ account, liveReader: async () => { throw new Error("offline"); } })).data).toBeNull();
  }
});

test("inventory relocation cannot rebind verified quota custody to another account", () => {
  const ts = "2026-07-08T12:00:00.000Z", hex = createHash("sha256").update("quota-custody-relocation-fixture").digest("hex").slice(0, 32);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const sourceRoot = path.join(root, "account-a"), targetRoot = path.join(root, "account-b");
  writeSession(`${id}.jsonl`, "2026-07-08", [{ ts, primary: [15, 10080, 1_783_994_379] }], false, sourceRoot);
  const original = path.join(sourceRoot, "2026", "07", "08", `${id}.jsonl`);
  const relocatedDir = path.join(targetRoot, "2026", "07", "08");
  fs.mkdirSync(relocatedDir, { recursive: true });
  const relocated = path.join(relocatedDir, `${id}.jsonl`);
  const registry = agentRegistry(), conversation = registry.ensureConversation("codex", original, "a");
  updateQuotaRegistryFixture(state => {
    const generation = state.conversations[conversation.id]!.generations[0]!;
    generation.createdAt = "2000-01-01T00:00:00.000Z";
    generation.host = { kind: "codex-app-server", identity: id, epoch: 1, verifiedAt: generation.createdAt };
    generation.quotaCustody = { accountId: "a", artifactPath: original };
  });
  fs.renameSync(original, relocated);
  const inventory = registry.reconcileConversations([{
    engine: "codex", path: relocated, accountId: "b", launchProfile: emptyLaunchProfile(),
    observedAt: "2026-07-08T12:01:00.000Z", turn: { state: "idle", source: "empty", terminalAt: null },
  }]);
  expect(inventory).toBeDefined();
  expect(registry.conversationForPath(relocated)?.generations[0]).toMatchObject({ path: relocated, accountId: "b" });
  expect(collectCodexRateLimitSeries(targetRoot, 0, "a").weekly).toEqual([]);
  expect(collectCodexRateLimitSeries(targetRoot, 0, "b").weekly).toEqual([]);
  expect(readCodexTranscriptLimits(targetRoot, "b").data).toBeNull();
});

test("buildSeries drops pre-reset samples so a draining window after a rollover still projects", () => {
  const windowSeconds = 18_000; // 5h
  const now = 10_000_000;
  const resetsAt = now + 9_000;
  const windowStart = resetsAt - windowSeconds; // now - 9000
  // A low pre-reset sample inside the old 60s grace, then a normal rollover to
  // ~100% and a draining new window.
  const forward = [
    { t: windowStart - 30, remaining: 5 }, // previous window — must be excluded
    { t: windowStart + 100, remaining: 100 },
    { t: windowStart + 4_500, remaining: 90 },
  ];
  const series = buildSeries(forward, [], { usedPercent: 15, resetsAt }, now, windowSeconds, null);
  // The pre-reset value is gone, so there is no boundary rise.
  expect(series.samples.some((s) => s.remaining === 5)).toBe(false);
  expect(series.samples[0].remaining).toBe(100);
  expect(computePace(series, now)!.zeroCrossing).not.toBeNull();
});
