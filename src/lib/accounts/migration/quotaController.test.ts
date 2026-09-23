import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import type { CodexAccount } from "@/lib/accounts/codex";

import type { QuotaProbePort } from "./quotaController";

const QUOTA_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-controller-suite-"));
const PREVIOUS_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(QUOTA_SANDBOX, "state");

const { AgentRegistry } = await import("@/lib/agent/registry");
const { withAccountMutationLock, withAccountMutationLockAsync } = await import("@/lib/accounts/accountMutation");
const { QuotaController } = await import("./quotaController");

afterAll(() => {
  if (PREVIOUS_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = PREVIOUS_STATE;
  fs.rmSync(QUOTA_SANDBOX, { recursive: true, force: true });
});

test("quota probes wait behind account deletion mutations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-fence-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const account: CodexAccount = { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 };
    let probes = 0;
    const controller = new QuotaController(registry, {
      list: () => [account],
      active: () => account.id,
      async probe(engine, candidate, now) {
        probes += 1;
        return { engine, accountId: candidate.id, authenticated: true, authCheckedAt: now, limits: null, provenance: { source: "live", reason: null, staleSince: null }, observedAt: now };
      },
    });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withAccountMutationLockAsync(async () => { entered(); await held; });
    await acquired;

    const tick = controller.tick("codex");
    await Bun.sleep(10);
    expect(probes).toBe(0);
    release();
    await holder;
    await tick;
    expect(probes).toBe(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot quota probe reads its transcript and never starts an engine probe", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-copilot-transcript-"));
  const { liveQuotaProbe } = await import("./quotaController");
  const { managedCodexRuntime } = await import("@/lib/accounts/codexRuntime");
  const runtime = managedCodexRuntime();
  const spawnProbe = spyOn(runtime, "probeQuota").mockImplementation(async () => { throw new Error("Copilot quota checks must not spawn a process"); });
  try {
    const home = path.join(root, "home");
    const sessions = path.join(home, "session-state");
    const session = path.join(sessions, crypto.randomUUID());
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), `// local config\n${JSON.stringify({ lastLoggedInUser: { host: "github.com", login: "placeholder" }, loggedInUsers: [{ host: "github.com", login: "placeholder" }] })}`);
    fs.writeFileSync(path.join(session, "events.jsonl"), `${JSON.stringify({ timestamp: "2026-09-20T10:00:00.000Z", type: "model.model_call_success", data: { quotaSnapshots: { chat: { entitlementRequests: 200, remainingPercentage: 84, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false } }, requestMessages: "private content" } })}\n`);
    const observation = await liveQuotaProbe.probe("copilot", {
      id: "copilot",
      label: "Copilot",
      kind: "managed",
      home,
      sessionStateDir: sessions,
      createdAt: 1,
    }, Date.now());
    expect(observation).toMatchObject({ engine: "copilot", authenticated: true, provenance: { source: "transcript" }, limits: { weekly: { usedPercent: 16 } } });
    expect(spawnProbe).not.toHaveBeenCalled();
  } finally {
    spawnProbe.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quota visibility remains fresh when automatic balancing is disabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-controller-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    let listed = 0;
    let current = Date.parse("2026-07-10T12:00:00.000Z");
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
      { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 },
    ];
    const probe: QuotaProbePort = {
      list() { listed += 1; return accounts; },
      active() { return "default"; },
      async probe(engine, candidate, now) {
        return {
          engine,
          accountId: candidate.id,
          authenticated: true,
          authCheckedAt: now,
          limits: {
            session: { usedPercent: candidate.id === "default" ? 100 : 10, resetsAt: Math.floor(now / 1000) + 3_600 },
            weekly: null,
            plan: "pro",
            capturedAt: Math.floor(now / 1000),
          },
          provenance: { source: "live", reason: null, staleSince: null },
          observedAt: now,
        };
      },
    };
    const controller = new QuotaController(registry, probe, "boot-visibility-test", () => current);

    registry.setAutoBalancePolicy("codex", false);
    await controller.tick("codex");
    current += 60_000;
    await controller.tick("codex");
    expect(listed).toBe(4);
    expect(registry.snapshot().quotaObservations.codex.default).toMatchObject({
      authenticated: true,
      limits: { session: { usedPercent: 100 } },
    });
    expect(registry.snapshot().quotaObservations.codex.managed).toMatchObject({
      authenticated: true,
      limits: { session: { usedPercent: 10 } },
    });
    expect(Object.values(registry.snapshot().migrationIntents)).toHaveLength(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed probe keeps the last known limits instead of blanking them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-carry-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
    ];
    let current = Date.parse("2026-07-10T12:00:00.000Z");
    let fail = false;
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        if (fail) throw new Error("provider down");
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 30, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "boot-carry-forward-test", () => current);
    await controller.tick("codex");
    const firstObservedAt = registry.snapshot().quotaObservations.codex.default!.observedAt;
    fail = true;
    current += 120_000;
    await controller.tick("codex");
    const carried = registry.snapshot().quotaObservations.codex.default!;
    expect(carried.limits?.session?.usedPercent).toBe(30);
    expect(carried.authenticated).toBeTrue();
    expect(carried.provenance).toMatchObject({ source: "cache", reason: "quota-probe-failed" });
    expect(carried.provenance.staleSince).toBe(firstObservedAt);
    expect(carried.observedAt).toBe(firstObservedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a hung probe times out without delaying or blanking the other accounts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-hang-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
      { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 },
    ];
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        if (account.id === "default") return await new Promise<never>(() => { /* wedged provider */ });
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 40, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "boot-hung-probe-test", () => Date.parse("2026-07-10T12:00:00.000Z"), 50);
    await controller.tick("codex");
    expect(registry.snapshot().quotaObservations.codex.default?.provenance).toMatchObject({ source: "unavailable", reason: "quota-probe-timeout" });
    expect(registry.snapshot().quotaObservations.codex.managed?.limits?.session?.usedPercent).toBe(40);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a live sign-out answer replaces the cached limits instead of hiding behind them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-signout-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
    ];
    let current = Date.parse("2026-07-10T12:00:00.000Z");
    let signedOut = false;
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        if (signedOut) {
          return {
            engine,
            accountId: account.id,
            authenticated: false,
            authCheckedAt: now,
            limits: null,
            provenance: { source: "live" as const, reason: null, staleSince: null },
            observedAt: now,
          };
        }
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 25, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "boot-signout-test", () => current);
    await controller.tick("codex");
    signedOut = true;
    current += 120_000;
    await controller.tick("codex");
    const observation = registry.snapshot().quotaObservations.codex.default!;
    expect(observation.authenticated).toBeFalse();
    expect(observation.limits).toBeNull();
    expect(observation.provenance.source).toBe("live");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed home records a closed code while the controller sweeps later homes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-sweep-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
      { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 },
    ];
    const visited: string[] = [];
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        visited.push(account.id);
        if (account.id === "default") throw new Error("access_token=secret");
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 20, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "boot-sweep-test", () => Date.parse("2026-07-10T12:00:00.000Z"));
    await controller.tick("codex");
    expect(visited.sort()).toEqual(["default", "managed"]);
    expect(registry.snapshot().quotaObservations.codex.default?.provenance.reason).toBe("quota-probe-failed");
    expect(JSON.stringify(registry.snapshot())).not.toContain("secret");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the controller records the probe's reset credits and carries them through a failed tick (#1373)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-reset-credits-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const account: CodexAccount = { id: "credited", label: "Account A", kind: "managed", home: "/homes/credited", sessionsDir: "/homes/credited/sessions", authPresent: true, loginPane: null, createdAt: 1 };
    let fail = false;
    const controller = new QuotaController(registry, {
      list: () => [account],
      active: () => account.id,
      async probe(engine, candidate, now) {
        if (fail) throw new Error("offline");
        return {
          engine,
          accountId: candidate.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: null, weekly: { usedPercent: 100, resetsAt: Math.floor(now / 1000) + 86_400, windowMinutes: 10_080 }, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live", reason: null, staleSince: null },
          observedAt: now,
          resetCredits: { availableCount: 1, expiresAt: Math.floor(now / 1000) + 20 * 86_400 },
        };
      },
    }, "boot-reset-credits");
    await controller.tick("codex");
    expect(registry.quotaObservations("codex")[0]).toMatchObject({ accountId: "credited", resetCredits: { availableCount: 1 } });

    fail = true;
    await controller.tick("codex");
    const carried = registry.quotaObservations("codex")[0]!;
    expect(carried.provenance.source).toBe("cache");
    expect(carried.resetCredits).toMatchObject({ availableCount: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("a two-second quota probe leaves resume, send and spawn admission available", async () => {
  const registry = new AgentRegistry(path.join(QUOTA_SANDBOX, "slow-probe-registry.json"));
  const conversation = registry.ensureConversation("codex", "/fixture/session.jsonl", "default");
  const account: CodexAccount = { id: "default", label: "Account A", kind: "legacy", home: "/fixture/home", sessionsDir: "/fixture/home/sessions", authPresent: true, loginPane: null, createdAt: 0 };
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const controller = new QuotaController(registry, {
    list: () => [account], active: () => "default",
    async probe(engine, candidate, now) {
      entered();
      await Bun.sleep(2_000);
      return { engine, accountId: candidate.id, authenticated: true, limits: null, provenance: { source: "live", reason: null, staleSince: null }, observedAt: now };
    },
  });
  const tick = controller.tick("codex");
  await started;
  try {
    const startedAt = performance.now();
    const resume = registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", conversationId: conversation.id, purpose: "resume-successor", origin: { kind: "successor" }, launchProfile: { title: "Slow probe resume" } });
    const send = withAccountMutationLock(() => registry.holdDelivery(conversation.id, "hello", "slow-probe-send"));
    const spawn = registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Slow probe spawn" } });
    expect(resume.kind).toBe("created");
    expect(send.id).toBeTruthy();
    expect(spawn.kind).toBe("created");
    expect(performance.now() - startedAt).toBeLessThan(500);
  } finally {
    await tick;
  }
});


for (const mutation of ["removed", "switched", "reauthenticated", "keychain", "newer-read"] as const) {
  test(`a quota result is discarded when the account was ${mutation} during the probe`, async () => {
    const root = path.join(QUOTA_SANDBOX, mutation);
    fs.mkdirSync(root, { recursive: true });
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const account: CodexAccount = { id: "default", label: "Account A", kind: "legacy", home: root, sessionsDir: path.join(root, "sessions"), authPresent: true, loginPane: null, createdAt: 0 };
    fs.writeFileSync(path.join(root, "auth.json"), "fixture-before");
    let accounts = [account];
    let credentialGeneration = "before";
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const now = Date.now();
    const controller = new QuotaController(registry, {
      list: () => accounts, active: () => "default",
      credentialIdentity: () => credentialGeneration,
      async probe(engine, candidate) {
        entered(); await held;
        return { engine, accountId: candidate.id, authenticated: true, limits: { session: { usedPercent: 10, resetsAt: null }, weekly: null, plan: "pro", capturedAt: now / 1000 }, provenance: { source: "live", reason: null, staleSince: null }, observedAt: now };
      },
    }, "stale-probe-test", () => now);
    const tick = controller.tick("codex");
    await ready;
    try {
      await withAccountMutationLockAsync(() => {
        if (mutation === "removed") accounts = [];
        if (mutation === "switched") {
          registry.setEngineRouting("codex", "other");
          registry.setEngineRouting("codex", "default");
        }
        if (mutation === "keychain") credentialGeneration = "after";
        if (mutation === "reauthenticated") fs.writeFileSync(path.join(root, "auth.json"), "fixture-after-reauthentication");
        if (mutation === "newer-read") registry.recordQuotaEvaluation({ engine: "codex", observations: [{ engine: "codex", accountId: "default", authenticated: false, authCheckedAt: new Date(now + 1000).toISOString(), limits: null, provenance: { source: "live", reason: null, staleSince: null }, observedAt: new Date(now + 1000).toISOString(), bootId: "newer" }], signature: null, evidence: null, bootId: "newer", now: new Date(now + 1000).toISOString(), minimumGapMs: 0 });
      });
    } finally { release(); await tick; }
    const recorded = registry.snapshot().quotaObservations.codex.default;
    if (mutation === "newer-read") expect(recorded?.authenticated).toBeFalse();
    else expect(recorded).toBeUndefined();
  });
}


test("an eleven-second provider wait never becomes an account mutation lease", async () => {
  const { ManagedCodexRuntime } = await import("@/lib/accounts/codexRuntime");
  const registry = new AgentRegistry(path.join(QUOTA_SANDBOX, "long-probe", "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const account: CodexAccount = { id: "default", label: "Account A", kind: "legacy", home: path.join(QUOTA_SANDBOX, "home"), sessionsDir: path.join(QUOTA_SANDBOX, "home", "sessions"), authPresent: true, loginPane: null, createdAt: 0 };
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let providerDone = false;
  const runtime = new ManagedCodexRuntime({ startClient: async () => {
    entered();
    await Bun.sleep(11_000);
    providerDone = true;
    throw new Error("oauth-rate-limited fixture");
  } });
  const controller = new QuotaController(registry, {
    list: () => { expect(fs.existsSync(lock)).toBeFalse(); return [account]; },
    active: () => { expect(fs.existsSync(lock)).toBeFalse(); return account.id; },
    probe: async () => { await runtime.probeQuota(account); throw new Error("fixture has no response"); },
  });
  const lock = path.join(process.env.LLV_STATE_DIR!, "account-selection.lock");
  const open = fs.openSync;
  const remove = fs.rmSync;
  let acquiredAt: number | null = null;
  const holds: number[] = [];
  const openSpy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (args[0] === lock && args[1] === "wx") acquiredAt = performance.now();
    return fd;
  }) as typeof fs.openSync);
  const removeSpy = spyOn(fs, "rmSync").mockImplementation(((...args: Parameters<typeof fs.rmSync>) => {
    if (args[0] === lock && acquiredAt !== null) { holds.push(performance.now() - acquiredAt); acquiredAt = null; }
    return remove(...args);
  }) as typeof fs.rmSync);
  const startedAt = performance.now();
  const tick = controller.tick("codex");
  try {
    await ready;
    expect(fs.existsSync(lock)).toBeFalse();
    const admissions = await Promise.all([1, 2].map((number) => registry.beginSpawnRequestAsync({
      engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default",
      clientAttemptId: `parallel-stage-${number}`, launchProfile: { title: "Parallel stage admission" },
    })));
    expect(admissions.map((entry) => entry.kind)).toEqual(["created", "created"]);
    expect(providerDone).toBeFalse();
    await tick;
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(11_000);
    expect(holds.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...holds)).toBeLessThan(250);
    expect(registry.quotaObservations("codex")[0]?.provenance.reason).toBe("quota-probe-failed");
    console.info(JSON.stringify({ measurement: "slow-provider-lock", providerWaitMs: 11_000, holds: holds.length, maxHoldMs: Math.round(Math.max(...holds) * 100) / 100 }));
  } finally {
    await tick;
    openSpy.mockRestore(); removeSpy.mockRestore();
  }
}, 15_000);
