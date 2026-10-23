import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchClaudeLimits, adoptClaudeLimitsSnapshot } from "./limits";
import * as headlessCli from "./agent/claudeHeadless";
import { claudeQuotaObservation, durableQuotaObservation } from "./accounts/migration/quotaController";
import { accountProjection } from "./accounts/accountProjection";
import { AgentRegistry } from "./agent/registry";
import { accountLimitRows } from "./mcp/compactAnswers";
import { subscriptionApiConsent } from "./accounts/subscriptionApiConsent";
import type { ClaudeHeadlessResult } from "./agent/claudeHeadless";

const old = process.env.LLV_STATE_DIR;
const roots: string[] = [];
afterEach(() => { process.env.LLV_STATE_DIR = old; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const unavailable = async (): Promise<ClaudeHeadlessResult> => ({ status: "failed", records: [] });
function isolated(enabled?: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "limits-consent-")); roots.push(root); process.env.LLV_STATE_DIR = root;
  if (enabled !== undefined) fs.writeFileSync(path.join(root, "subscription-api-consent.json"), JSON.stringify({ version: 1, enabled, source: "operator" }));
  const file = path.join(root, ".credentials.json");
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "fixture", subscriptionType: "max" } }), { mode: 0o600 });
  return file;
}
test("cache rewrites preserve the old installation's migration proof first", () => {
  const file = isolated(); const root = path.dirname(file);
  fs.writeFileSync(path.join(root, "limits-cache.json"), JSON.stringify({ version: 2, engines: { claude: { sample: { parser: 2, data: { session: { usedPercent: 12 } }, provenance: { source: "live" } } } } }));
  delete (globalThis as { __llvLimitsCache?: unknown }).__llvLimitsCache;
  adoptClaudeLimitsSnapshot("sample", { session: { usedPercent: 15, resetsAt: null }, weekly: null, plan: null, capturedAt: null }, 1_800_000_000_000);
  expect(subscriptionApiConsent()).toMatchObject({ enabled: true, source: "migration" });
});
test("new installs cannot call the direct endpoint when the CLI has no limits", async () => {
  const file = isolated(); let calls = 0;
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => { calls++; throw Error("forbidden endpoint"); }) as unknown as typeof fetch);
  try {
    const result = await fetchClaudeLimits(file, () => 1_800_000_000_000, 8000, { run: unavailable });
    expect(result.data).toBeNull(); expect(calls).toBe(0);
  } finally { request.mockRestore(); }
});
test("structured CLI rows win even when direct API consent is on", async () => {
  const file = isolated(true); let calls = 0;
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => { calls++; throw Error("endpoint must not be reached"); }) as unknown as typeof fetch);
  try {
    const result = await fetchClaudeLimits(file, () => 1_800_000_000_000, 8000, { run: async () => ({ status: "done", records: [
      { type: "assistant", usage_report: { rate_limits: { limits: [
        { kind: "session", group: "session", percent: 23, resets_at: "2027-01-16T10:00:00Z" },
        { kind: "weekly_all", group: "weekly", percent: 42, resets_at: "2027-01-20T10:00:00Z" },
        { kind: "weekly_scoped", group: "weekly", percent: 71, resets_at: "2027-01-20T10:00:00Z", scope: { model: { display_name: "Opus" } } },
      ] } } }, { type: "result", subtype: "success", is_error: false, local_command: "usage", num_turns: 0 },
    ] }) });
    expect(result).toMatchObject({ source: "live", data: { session: { usedPercent: 23 }, weekly: { usedPercent: 42 }, tiers: [{ tier: "opus", usedPercent: 71 }] } });
    expect(calls).toBe(0);
  } finally { request.mockRestore(); }
});

test("Claude CLI usage becomes durable fresh windows and a failed refresh retains their original time", async () => {
  const file = isolated(false);
  const now = 1_800_000_000_000;
  const sessionReset = new Date(now + 3_600_000).toISOString();
  const weeklyReset = new Date(now + 3 * 86_400_000).toISOString();
  const tierReset = new Date(now + 2 * 86_400_000).toISOString();
  const account = { id: "cli-window-fixture", home: path.dirname(file), authPresent: true };
  const cli = spyOn(headlessCli, "runHeadlessClaudeOnce").mockResolvedValue({ status: "done", records: [
    { type: "assistant", usage_report: { rate_limits: { limits: [
      { kind: "session", percent: 23, resets_at: sessionReset },
      { kind: "weekly_all", percent: 42, resets_at: weeklyReset },
      { kind: "weekly_scoped", percent: 61, resets_at: tierReset, scope: { model: { display_name: "Opus" } } },
    ] } } },
    { type: "result", subtype: "success", is_error: false, local_command: "usage", num_turns: 0 },
  ] });
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => { throw Error("unexpected provider call"); }) as unknown as typeof fetch);
  try {
    const observation = await claudeQuotaObservation(account, now, { authStatus: async () => ({ loggedIn: true }) });
    const expected = { session: { usedPercent: 23, resetsAt: Date.parse(sessionReset) / 1000 },
      weekly: { usedPercent: 42, resetsAt: Date.parse(weeklyReset) / 1000 },
      tiers: [{ tier: "opus", usedPercent: 61, resetsAt: Date.parse(tierReset) / 1000 }] };
    expect(observation).toMatchObject({ authenticated: true, observedAt: now, provenance: { source: "live" }, limits: expected });
    const registryFile = path.join(path.dirname(file), "quota-registry.json");
    new AgentRegistry(registryFile).recordQuotaObservation(durableQuotaObservation(observation, "fixture-boot"));
    const saved = new AgentRegistry(registryFile).quotaObservations("claude")[0]!;
    expect(accountProjection(saved, true, now)).toMatchObject({ limits: { state: "fresh", ...expected } });
    const compact = (row: typeof saved, at: number) => accountLimitRows({
      engine: "claude", accounts: { claude: [{ accountId: account.id }], codex: [], copilot: [] },
      active: { claude: account.id, codex: null, copilot: null },
      observations: { claude: { [account.id]: row }, codex: {}, copilot: {} }, now: at,
    })[0];
    expect(compact(saved, now)).toMatchObject({ fresh: true, session: { resetsAt: sessionReset },
      weekly: { resetsAt: weeklyReset }, tiers: [{ tier: "opus", resetsAt: tierReset }] });
    expect((await claudeQuotaObservation(account, now + 1_000, { authStatus: async () => ({ loggedIn: true }) })).observedAt).toBe(now);
    expect(cli).toHaveBeenCalledTimes(1);
    expect(cli.mock.calls[0]![0]).toMatchObject({ prompt: "/usage", account: { home: account.home } });
    cli.mockResolvedValue({ status: "failed", records: [] });
    const failed = await claudeQuotaObservation(account, now + 60_000, { authStatus: async () => ({ loggedIn: true }) });
    expect(failed).toMatchObject({ observedAt: now, provenance: { source: "cache" }, limits: expected });
    expect(accountProjection(durableQuotaObservation(failed, "fixture-boot"), true, now + 60_000).limits.state).toBe("stale");
    expect(compact(durableQuotaObservation(failed, "fixture-boot"), now + 60_000)?.fresh).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(cli).toHaveBeenCalledTimes(2);
  } finally {
    cli.mockRestore(); request.mockRestore();
    delete (globalThis as { __llvLimitsCache?: unknown }).__llvLimitsCache;
    delete (globalThis as { __llvLimitsInflight?: unknown }).__llvLimitsInflight;
  }
});
test("explicit consent permits the direct fallback, and revocation before dispatch stops it", async () => {
  const file = isolated(true); let calls = 0;
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => { calls++; return Response.json({ five_hour: { utilization: 17 } }); }) as unknown as typeof fetch);
  try {
    expect((await fetchClaudeLimits(file, () => 1_800_000_000_000, 8000, { run: unavailable })).data?.session?.usedPercent).toBe(17);
    expect(calls).toBe(1);
    await fetchClaudeLimits(file, () => 1_800_000_000_000, 8000, { run: async () => {
      fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "subscription-api-consent.json"), JSON.stringify({ version: 1, enabled: false, source: "operator" }));
      return unavailable();
    } });
    expect(calls).toBe(1);
  } finally { request.mockRestore(); }
});
test("the direct fallback reads credentials again after the CLI wait", async () => {
  const file = isolated(true);
  const request = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer after");
    return Response.json({ five_hour: { utilization: 17 } });
  }) as unknown as typeof fetch);
  try {
    await fetchClaudeLimits(file, () => 1_800_000_000_000, 8000, { run: async () => {
      fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "after", subscriptionType: "max" } }), { mode: 0o600 });
      return unavailable();
    } });
    expect(request).toHaveBeenCalledTimes(1);
  } finally { request.mockRestore(); }
});
