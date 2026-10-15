import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "login-limits-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");
const { createManagedClaudeAccount } = await import("./claude");
const { agentRegistry } = await import("@/lib/agent/registry");
const { refreshAccountLimits, recordLiveObservation, exhaustionNeedsLiveRead } = await import("./liveLimits");
const { readClaudeAccountLimits, cachedLimitsProvenance } = await import("@/lib/limits");
const { QuotaController, claudeQuotaObservation, durableQuotaObservation } = await import("./migration/quotaController");
const { realClaudeLoginPorts } = await import("./claudeLogin");
const { accountProjection } = await import("./accountProjection");
type QuotaProbePort = import("./migration/quotaController").QuotaProbePort;

test("paid metadata survives a window-only read; a proved reset restores admission", () => {
  const now = Date.now();
  const registry = agentRegistry();
  const observation = { engine: "codex" as const, accountId: "account-a", authenticated: true, authCheckedAt: now, observedAt: now,
    provenance: { source: "live" as const, reason: null, staleSince: null }, limits: {
      session: null, weekly: { usedPercent: 99, resetsAt: now / 1000 - 1 }, plan: "pro", capturedAt: now / 1000,
      credits: { hasCredits: true, balance: "10", unlimited: false } } };
  const first = recordLiveObservation(observation, "managed", { registry });
  expect(exhaustionNeedsLiveRead(first, now)).toBe(true);
  const next = recordLiveObservation({ ...observation, limits: { ...observation.limits, credits: undefined,
    weekly: { usedPercent: 1, resetsAt: now / 1000 + 3600 } } }, "managed", { registry });
  expect(next.limits?.credits?.hasCredits).toBe(true);
  expect(exhaustionNeedsLiveRead(next, now)).toBe(false);
  expect(recordLiveObservation({ ...observation, limits: { ...observation.limits,
    credits: { hasCredits: false, balance: "0", unlimited: false } } }, "managed", { registry }).limits?.credits?.hasCredits).toBe(false);
});

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true });
});

test("login-complete bypasses a cached pre-login failure and the next controller tick keeps live auth", async () => {
  const account = createManagedClaudeAccount("Account B");
  const registry = agentRegistry();
  let now = Date.now();
  registry.recordQuotaObservation(durableQuotaObservation({ engine: "claude", accountId: account.id,
    authenticated: false, authCheckedAt: now, observedAt: now, limits: null,
    provenance: { source: "unavailable", reason: "fixture signed out", staleSince: null },
  }, "fixture-before"));
  expect(accountProjection(registry.quotaObservations("claude")[0], true, now).auth.state).toBe("error");
  // The real shared cache records missing credentials with a future retryAt.
  expect((await readClaudeAccountLimits(account, { now: () => now })).data).toBeNull();
  expect(Date.parse(cachedLimitsProvenance("claude", account.id)!.retryAt!)).toBeGreaterThan(now);
  fs.writeFileSync(path.join(account.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: ["fixture", "oauth"].join("-"), subscriptionType: "max",
  } }), { mode: 0o600 });
  let reads = 0;
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => {
    reads += 1;
    return new Response(JSON.stringify({ five_hour: { utilization: 7 }, seven_day: { utilization: 31 } }));
  }) as unknown as typeof globalThis.fetch);
  const status = spyOn(realClaudeLoginPorts, "status").mockResolvedValue({ loggedIn: true, method: null, email: null, plan: "max" });
  const probe: QuotaProbePort = {
    list: () => [account], active: () => account.id, credentialIdentity: () => "fixture-credential",
    probe: async (_engine, candidate, at, options) => claudeQuotaObservation(candidate as typeof account, at,
      { ...options, authStatus: async () => ({ loggedIn: true }) }),
  };
  try {
    expect((await readClaudeAccountLimits(account, { now: () => now })).data).toBeNull();
    expect(reads).toBe(0);
    await realClaudeLoginPorts.observeSignedIn(account.id);
    now = Date.now();
    expect(reads).toBe(1);
    expect(accountProjection(registry.quotaObservations("claude")[0], true, now)).toMatchObject({
      auth: { state: "authenticated", plan: "max" }, limits: { state: "fresh", weekly: { usedPercent: 31 } },
    });
    now += 1_000;
    await new QuotaController(registry, probe, "fixture-after", () => now).tick("claude");
    expect(reads).toBe(1);
    expect(accountProjection(registry.quotaObservations("claude")[0], true, now).auth.state).toBe("authenticated");
  } finally { fetch.mockRestore(); status.mockRestore(); }
});

test("a login-complete probe timeout is bounded and reports its failed read", async () => {
  const account = createManagedClaudeAccount("Timeout account");
  const result = await refreshAccountLimits("claude", account.id, { phase: "login-complete", timeoutMs: 5,
    probe: { list: () => [account], active: () => account.id, probe: () => new Promise(() => {}) },
  });
  expect(result).toEqual({ kind: "probe_failed", detail: "quota-probe-timeout" });
});
