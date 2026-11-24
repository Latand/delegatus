import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import type { CodexAccount } from "@/lib/accounts/codex";
import type { ClaudeAccount } from "@/lib/accounts/claude";

import type { QuotaProbePort } from "./quotaController";

const QUOTA_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-controller-suite-"));
const PREVIOUS_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(QUOTA_SANDBOX, "state");

const { AgentRegistry } = await import("@/lib/agent/registry");
const { withAccountMutationLock, withAccountMutationLockAsync } = await import("@/lib/accounts/accountMutation");
const { QuotaController, codexObservationFromProbe, durableQuotaObservation } = await import("./quotaController");

afterAll(() => {
  if (PREVIOUS_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = PREVIOUS_STATE;
  fs.rmSync(QUOTA_SANDBOX, { recursive: true, force: true });
});

test("controller keeps a successful provider authentication with unknown limits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-quota-tick-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const account: ClaudeAccount = { id: "provider", label: "Provider", kind: "managed", home: path.join(root, "account"),
      projectsDir: path.join(root, "account", "projects"), authPresent: true, createdAt: 1,
      provider: { baseUrl: "http://127.0.0.1:9876", model: "fixture-model", smallFastModel: null } };
    const controller = new QuotaController(registry, {
      list: () => [account], active: () => account.id, credentialIdentity: () => "unchanged-fixture",
      async probe(engine, candidate, now) {
        return { engine, accountId: candidate.id, authenticated: true, authCheckedAt: now, limits: null,
          provenance: { source: "unavailable", reason: "provider limits unknown", staleSince: null }, observedAt: now };
      },
    });
    await controller.tick("claude");
    expect(registry.snapshot().quotaObservations.claude.provider).toMatchObject({ authenticated: true, limits: null,
      provenance: { reason: "provider limits unknown" } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
    const data = { responseUsage: {}, requestMessages: "fixture body", quotaSnapshots: { chat: { entitlementRequests: 200, remainingPercentage: 84, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false } }, requestId: crypto.randomUUID(), copilotUsage: {} };
    fs.writeFileSync(path.join(session, "events.jsonl"), `${JSON.stringify({ type: "model.model_call_success", data, id: crypto.randomUUID(), timestamp: "2026-09-20T10:00:00.000Z", parentId: null })}\n`);
    const observation = await liveQuotaProbe.probe("copilot", {
      id: "copilot",
      label: "Copilot",
      kind: "managed",
      home,
      sessionStateDir: sessions,
      createdAt: 1,
      auth: "signed_in",
    }, Date.now());
    expect(observation).toMatchObject({ engine: "copilot", authenticated: true, provenance: { source: "transcript" }, limits: { weekly: { usedPercent: 16 } } });
    expect(spawnProbe).not.toHaveBeenCalled();
  } finally {
    spawnProbe.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity quota probe reads transcript exhaustion with zero process spawns and clears after resetsAt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-antigravity-transcript-"));
  const { liveQuotaProbe } = await import("./quotaController");
  const { managedCodexRuntime } = await import("@/lib/accounts/codexRuntime");
  const runtime = managedCodexRuntime();
  const spawnProbe = spyOn(runtime, "probeQuota").mockImplementation(async () => { throw new Error("Antigravity quota checks must not spawn a process"); });
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, {
    sqliteMode: "sqlite",
    sqliteFilename: path.join(root, "registry.sqlite"),
  });
  const secondReader = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, {
    sqliteMode: "sqlite",
    sqliteFilename: path.join(root, "registry.sqlite"),
  });
  try {
    const home = path.join(root, "home");
    const sessions = path.join(home, "sessions");
    const session = path.join(sessions, crypto.randomUUID());
    fs.mkdirSync(session, { recursive: true });
    const observedMs = Date.parse("2026-11-24T01:00:00.000Z");
    const observedSec = Math.floor(observedMs / 1000);
    const resetsAt = observedSec + 7200;
    fs.writeFileSync(
      path.join(session, "events.jsonl"),
      `${JSON.stringify({
        type: "session.quota_exhausted",
        timestamp: new Date(observedMs).toISOString(),
        data: {
          message: "RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h",
          resetsAt,
          windowMinutes: 300,
          usedPercent: 100,
          observedAt: observedSec,
        },
      })}\n`,
    );
    const account = {
      id: "default",
      label: "Default",
      kind: "legacy" as const,
      home,
      sessionsDir: sessions,
      createdAt: 0,
      auth: "signed_in" as const,
      tierName: "Pro",
    };

    const activeObs = await liveQuotaProbe.probe("antigravity", account, observedMs + 60_000);
    expect(activeObs).toMatchObject({
      engine: "antigravity",
      accountId: "default",
      authenticated: true,
      limitReached: true,
      provenance: { source: "transcript" },
      limits: { session: { usedPercent: 100, resetsAt, windowMinutes: 300 }, plan: "Pro" },
    });
    expect(spawnProbe).not.toHaveBeenCalled();

    let clock = observedMs + 60_000;
    const controller = new QuotaController(registry, {
      list: () => [account],
      active: () => account.id,
      credentialIdentity: () => "ag-cred-v1",
      probe: (engine, candidate, now) => liveQuotaProbe.probe(engine, candidate, now),
    }, "boot-ag", () => clock);

    await controller.tick("antigravity");
    expect(secondReader.quotaObservations("antigravity")[0]).toMatchObject({
      engine: "antigravity",
      accountId: "default",
      limitReached: true,
      limits: { session: { usedPercent: 100, resetsAt } },
    });

    // Once resetsAt elapses, a subsequent tick clears the expired 100% exhaustion.
    clock = resetsAt * 1000 + 1000;
    await controller.tick("antigravity");
    expect(secondReader.quotaObservations("antigravity")[0]).toMatchObject({
      engine: "antigravity",
      accountId: "default",
      limitReached: false,
      limits: null,
      provenance: { source: "unavailable", reason: "antigravity quota reset window elapsed" },
    });
  } finally {
    registry.close();
    secondReader.close();
    spawnProbe.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity EIO isolation preserves auth & HTTP 200, keeps host exhaustion past 5 newer files/older events, aligns 5h cutoff, and avoids readOnlySnapshot", async () => {
  const { setSystemTime } = await import("bun:test");
  const { GET } = await import("@/app/api/limits/route");
  const { setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { accountManager } = await import("@/lib/accounts/manager");
  const { antigravityDefaultSessionsDir, recordAntigravityAuthState } = await import("@/lib/accounts/antigravity");
  const { accountLimitRows } = await import("@/lib/mcp/compactAnswers");
  const { liveQuotaProbe } = await import("./quotaController");

  const root = fs.mkdtempSync(path.join(QUOTA_SANDBOX, "ag-hardening-"));
  const prevStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, {
    sqliteMode: "sqlite",
    sqliteFilename: path.join(root, "registry.sqlite"),
  });
  setAgentRegistryForTests(registry);

  const at = Date.parse("2026-11-24T01:00:00.000Z");
  const atSec = Math.floor(at / 1000);
  let clock = at + 60_000;
  setSystemTime(new Date(clock));
  recordAntigravityAuthState({ authenticated: true, checkedAt: new Date(at).toISOString(), tierName: "Pro", tierId: null });

  const sessionsDir = antigravityDefaultSessionsDir();
  const primaryDir = path.join(sessionsDir, "fixture-primary");
  fs.mkdirSync(primaryDir, { recursive: true });
  const primaryFile = path.join(primaryDir, "events.jsonl");

  const hostObs = {
    engine: "antigravity" as const,
    accountId: "default",
    authenticated: true,
    authCheckedAt: new Date(at).toISOString(),
    observedAt: new Date(at).toISOString(),
    bootId: "antigravity-acp-host",
    provenance: { source: "transcript" as const, reason: null, staleSince: null },
    limits: {
      session: { usedPercent: 100, resetsAt: atSec + 12_000, windowMinutes: 300, observedAt: atSec, source: "account" as const },
      weekly: null,
      tiers: [],
      plan: "Pro",
      capturedAt: atSec,
    },
    resetCredits: null,
    limitReached: true,
  };
  const controller = new QuotaController(registry, liveQuotaProbe, "ag-hardening", () => clock);

  try {
    // 1. Neither GET /api/limits nor accountManager.status("antigravity", "default") calls readOnlySnapshot().
    registry.recordQuotaObservation(hostObs);
    fs.writeFileSync(primaryFile, "{}\n");
    let snapshots = 0;
    const origSnap = registry.readOnlySnapshot.bind(registry);
    registry.readOnlySnapshot = function () { snapshots += 1; return origSnap(); };
    try {
      const resp = await GET();
      expect(resp.status).toBe(200);
      expect(snapshots).toBe(0);
      await accountManager.status("antigravity", "default", false);
      expect(snapshots).toBe(0);
    } finally {
      registry.readOnlySnapshot = origSnap;
    }

    // 2. Five newer-mtime session files with an OLDER expired event MUST NOT erase an active host exhaustion.
    fs.utimesSync(primaryFile, 1, 1);
    for (let i = 0; i < 5; i += 1) {
      const d = path.join(sessionsDir, `recent-${i}`);
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, "events.jsonl");
      const oldMs = at - 7_200_000;
      const line = i === 0
        ? { type: "session.quota_exhausted", timestamp: new Date(oldMs).toISOString(), data: { message: "Individual quota reached", resetsAt: atSec - 10, observedAt: Math.floor(oldMs / 1000), windowMinutes: 300 } }
        : { type: "session.start", data: {} };
      fs.writeFileSync(f, `${JSON.stringify(line)}\n`);
      fs.utimesSync(f, 10 + i, 10 + i);
    }
    await controller.tick("antigravity");
    const afterSixth = registry.quotaObservations("antigravity").find((row) => row.accountId === "default");
    expect(afterSixth?.limitReached).toBe(true);
    expect(afterSixth?.limits?.session?.usedPercent).toBe(100);
    const httpSixth = await (await GET()).json() as { antigravity?: { session?: { usedPercent: number } } | null };
    expect(httpSixth.antigravity?.session?.usedPercent).toBe(100);

    // 3. EIO on one transcript MUST NOT fail GET /api/limits or flip stored authenticated=true to false.
    registry.recordQuotaObservation({ ...hostObs, limits: null, limitReached: false });
    const recent0 = path.join(sessionsDir, "recent-0", "events.jsonl");
    fs.appendFileSync(recent0, "{}\n");
    const r0Stat = fs.statSync(recent0);
    const origRead = fs.readSync;
    fs.readSync = function (fd: number, ...args: unknown[]) {
      const s = fs.fstatSync(fd);
      if (s.ino === r0Stat.ino && s.dev === r0Stat.dev) {
        throw Object.assign(new Error("fixture quota read"), { code: "EIO" });
      }
      return (origRead as (...a: unknown[]) => number).call(fs, fd, ...args);
    } as typeof fs.readSync;
    try {
      const res = await GET();
      expect(res.status).toBe(200);
      await controller.tick("antigravity");
    } finally {
      fs.readSync = origRead;
    }
    const afterIo = registry.quotaObservations("antigravity").find((row) => row.accountId === "default");
    expect(afterIo?.authenticated).toBe(true);

    // 4. Unified 5-hour cutoff when resetsAt is null across GET /api/limits, MCP account_limits, and accountManager.status
    //    (including after a failing probe a day later).
    const noResetObs = {
      ...hostObs,
      limits: { ...hostObs.limits, session: { ...hostObs.limits.session, resetsAt: null } },
    };
    registry.recordQuotaObservation(noResetObs);
    for (const [deltaSec, expected] of [[17_999, 100], [18_000, null], [18_001, null]] as const) {
      clock = at + deltaSec * 1000;
      setSystemTime(new Date(clock));
      const apiBody = await (await GET()).json() as { antigravity?: { session?: { usedPercent: number } } | null };
      const statusSummary = await accountManager.status("antigravity", "default", false);
      const obsRow = registry.quotaObservations("antigravity").find((row) => row.accountId === "default");
      const mcpRows = accountLimitRows({
        engine: "antigravity",
        accounts: { claude: [], codex: [], copilot: [], antigravity: [{ accountId: "default", authPresent: true }] },
        active: { claude: null, codex: null, copilot: null, antigravity: "default" },
        observations: { claude: {}, codex: {}, copilot: {}, antigravity: obsRow ? { default: obsRow } : {} },
        now: clock,
      });
      expect(apiBody.antigravity?.session?.usedPercent ?? null).toBe(expected);
      expect(statusSummary.limits.session?.usedPercent ?? null).toBe(expected);
      expect(mcpRows[0]?.session?.usedPercent ?? null).toBe(expected);
    }

    // Even a day later with a failing probe, accountManager.status and GET /api/limits still clear the expired window.
    clock = at + 86_400_000;
    setSystemTime(new Date(clock));
    const failingController = new QuotaController(
      registry,
      { ...liveQuotaProbe, probe: async () => { throw new Error("test disk error"); } },
      "ag-hardening-fail",
      () => clock,
    );
    await failingController.tick("antigravity");
    expect(((await (await GET()).json()) as { antigravity?: unknown }).antigravity ?? null).toBeNull();
    expect((await accountManager.status("antigravity", "default", false)).limits.session).toBeNull();

    // 5. After a newer observation's reset passes, an older transcript with a LATER reset
    //    must NEVER resurrect exhaustion on GET /api/limits, QuotaController.tick, or MCP,
    //    and must NEVER move observedAt backwards.
    for (const entry of fs.readdirSync(sessionsDir)) {
      fs.rmSync(path.join(sessionsDir, entry), { recursive: true, force: true });
    }
    const olderObservedMs = Date.parse("2026-11-24T06:27:54.000Z");
    const olderObservedSec = Math.floor(olderObservedMs / 1000);
    const olderResetSec = olderObservedSec + 5 * 3600; // 11:27:54 UTC (still in future!)
    const newerObservedMs = Date.parse("2026-11-24T06:59:54.000Z");
    const newerObservedSec = Math.floor(newerObservedMs / 1000);
    const newerResetSec = newerObservedSec + 30 * 60; // 07:29:54 UTC

    const oldSessionDir = path.join(sessionsDir, "older-longer-reset");
    fs.mkdirSync(oldSessionDir, { recursive: true });
    const oldSessionFile = path.join(oldSessionDir, "events.jsonl");
    fs.writeFileSync(
      oldSessionFile,
      `${JSON.stringify({
        type: "session.quota_exhausted",
        timestamp: new Date(olderObservedMs).toISOString(),
        data: {
          code: "RESOURCE_EXHAUSTED",
          message: "Individual quota reached. Resets in 5h",
          resetsAt: olderResetSec,
          windowMinutes: 300,
          usedPercent: 100,
          observedAt: olderObservedSec,
        },
      })}\n`,
    );
    fs.utimesSync(oldSessionFile, olderObservedSec, olderObservedSec);
    registry.recordQuotaObservation({
      engine: "antigravity",
      accountId: "default",
      authenticated: true,
      authCheckedAt: new Date(newerObservedMs).toISOString(),
      observedAt: new Date(newerObservedMs).toISOString(),
      bootId: "antigravity-acp-host",
      provenance: { source: "transcript", reason: null, staleSince: null },
      limits: {
        session: { usedPercent: 100, resetsAt: newerResetSec, windowMinutes: 300, observedAt: newerObservedSec, source: "account" },
        weekly: null,
        tiers: [],
        plan: "Pro",
        capturedAt: newerObservedSec,
      },
      resetCredits: null,
      limitReached: true,
    });

    // 1 second AFTER newer reset (07:29:55 UTC), STILL 4 hours BEFORE older transcript's reset (11:27:54 UTC).
    clock = (newerResetSec + 1) * 1000;
    setSystemTime(new Date(clock));
    const httpBeforeTick = await (await GET()).json() as { antigravity?: unknown };
    expect(httpBeforeTick.antigravity ?? null).toBeNull();

    await controller.tick("antigravity");
    const afterResurrectionTick = registry.quotaObservations("antigravity").find((row) => row.accountId === "default");
    expect(afterResurrectionTick?.limitReached).toBe(false);
    expect(afterResurrectionTick?.limits).toBeNull();
    expect(Date.parse(afterResurrectionTick!.observedAt)).toBeGreaterThanOrEqual(newerObservedMs);

    const httpAfterTick = await (await GET()).json() as { antigravity?: unknown };
    expect(httpAfterTick.antigravity ?? null).toBeNull();
    const mcpAfterTick = accountLimitRows({
      engine: "antigravity",
      accounts: { claude: [], codex: [], copilot: [], antigravity: [{ accountId: "default", authPresent: true }] },
      active: { claude: null, codex: null, copilot: null, antigravity: "default" },
      observations: { claude: {}, codex: {}, copilot: {}, antigravity: afterResurrectionTick ? { default: afterResurrectionTick } : {} },
      now: clock,
    });
    expect(mcpAfterTick[0]?.session ?? null).toBeNull();
    expect(afterResurrectionTick?.lastQuotaEventAt).toBe(newerObservedSec);

    // 5b. An intervening empty poll (5 newer sessions push the older transcript out of top-5)
    //     changes provenance.reason to "no quota exhaustion in newest 5 session files"
    //     WITHOUT clearing `lastQuotaEventAt`, so when the older transcript later re-enters
    //     top-5, neither GET /api/limits (before tick) nor QuotaController.tick nor MCP
    //     can resurrect the already-reset account.
    const fillerDirs: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const fillerDir = path.join(sessionsDir, `filler-empty-${i}`);
      fillerDirs.push(fillerDir);
      fs.mkdirSync(fillerDir, { recursive: true });
      const fillerFile = path.join(fillerDir, "events.jsonl");
      fs.writeFileSync(fillerFile, '{"type":"session.start","data":{}}\n');
      fs.utimesSync(fillerFile, newerResetSec + 100 + i, newerResetSec + 100 + i);
    }
    clock = (newerResetSec + 200) * 1000;
    setSystemTime(new Date(clock));
    await controller.tick("antigravity");
    const afterEmptyPoll = registry.quotaObservations("antigravity").find((row) => row.accountId === "default");
    expect(afterEmptyPoll?.provenance.reason).toBe("no quota exhaustion in newest 5 session files");
    expect(afterEmptyPoll?.lastQuotaEventAt).toBe(newerObservedSec);
    expect(afterEmptyPoll?.limitReached).toBe(false);

    // Remove the 5 fillers so `older-longer-reset` re-enters the top-5 window.
    for (const fillerDir of fillerDirs) fs.rmSync(fillerDir, { recursive: true, force: true });
    clock = (newerResetSec + 300) * 1000;
    setSystemTime(new Date(clock));

    // BEFORE tick: GET /api/limits MUST still return null (not 100% from older transcript).
    expect(((await (await GET()).json()) as { antigravity?: unknown }).antigravity ?? null).toBeNull();

    // ON tick: durable observation stays cleared, observedAt never moves backwards, watermark preserved.
    await controller.tick("antigravity");
    const afterReenter = registry.quotaObservations("antigravity").find((row) => row.accountId === "default");
    expect(afterReenter?.limitReached).toBe(false);
    expect(afterReenter?.limits).toBeNull();
    expect(afterReenter?.lastQuotaEventAt).toBe(newerObservedSec);
    expect(Date.parse(afterReenter!.observedAt)).toBeGreaterThanOrEqual(newerObservedMs);
    expect(((await (await GET()).json()) as { antigravity?: unknown }).antigravity ?? null).toBeNull();
    const mcpAfterReenter = accountLimitRows({
      engine: "antigravity",
      accounts: { claude: [], codex: [], copilot: [], antigravity: [{ accountId: "default", authPresent: true }] },
      active: { claude: null, codex: null, copilot: null, antigravity: "default" },
      observations: { claude: {}, codex: {}, copilot: {}, antigravity: afterReenter ? { default: afterReenter } : {} },
      now: clock,
    });
    expect(mcpAfterReenter[0]?.session ?? null).toBeNull();

    // 5c. A genuine newer exhaustion occurring AFTER the expired window (+120s)
    //     but BEFORE an empty poll (+240s) and stale rejection (+250s) MUST NOT
    //     be hidden by the empty poll's `observedAt` clock: `lastQuotaEventAt`
    //     and `observedAt` stay separate clocks so +180s is accepted immediately.
    const lateEventSec = newerObservedSec + 180;
    const lateResetSec = newerObservedSec + 3700;
    fs.writeFileSync(
      oldSessionFile,
      `${JSON.stringify({
        type: "session.quota_exhausted",
        timestamp: new Date(lateEventSec * 1000).toISOString(),
        data: {
          code: "RESOURCE_EXHAUSTED",
          message: "Individual quota reached. Resets in 1h",
          resetsAt: lateResetSec,
          windowMinutes: 300,
          usedPercent: 100,
          observedAt: lateEventSec,
        },
      })}\n`,
    );
    fs.utimesSync(oldSessionFile, lateEventSec, lateEventSec);
    clock = (newerResetSec + 400) * 1000;
    setSystemTime(new Date(clock));

    const httpBeforeLateTick = await (await GET()).json() as { antigravity?: { session?: { usedPercent?: number } } | null };
    expect(httpBeforeLateTick.antigravity?.session?.usedPercent).toBe(100);

    await controller.tick("antigravity");
    const afterLateTick = registry.quotaObservations("antigravity").find((row) => row.accountId === "default");
    expect(afterLateTick?.limitReached).toBe(true);
    expect(afterLateTick?.limits?.session?.usedPercent).toBe(100);
    expect(afterLateTick?.lastQuotaEventAt).toBe(lateEventSec);
    const mcpAfterLateTick = accountLimitRows({
      engine: "antigravity",
      accounts: { claude: [], codex: [], copilot: [], antigravity: [{ accountId: "default", authPresent: true }] },
      active: { claude: null, codex: null, copilot: null, antigravity: "default" },
      observations: { claude: {}, codex: {}, copilot: {}, antigravity: afterLateTick ? { default: afterLateTick } : {} },
      now: clock,
    });
    expect(mcpAfterLateTick[0]?.session?.usedPercent).toBe(100);

    // 5d. First read of an already-expired quota event MUST still carry and
    //     persist its event time (`lastQuotaEventAt`) in BOTH cases:
    //     (a) with prior history (0s -> expired event at +180s first seen at +240s
    //         blocks an older +100s active event), and
    //     (b) on a fresh empty registry (expired event at 0s first seen at +240s
    //         persists `lastQuotaEventAt=0` so a genuine +180s active event is NOT hidden).
    for (const withHistory of [true, false]) {
      const subRoot = fs.mkdtempSync(path.join(os.tmpdir(), `llv-expired-first-seen-${withHistory}-`));
      const subState = path.join(subRoot, "state");
      const subHome = path.join(subRoot, "agy-home");
      const subSessions = path.join(subHome, "sessions");
      fs.mkdirSync(subSessions, { recursive: true });
      fs.writeFileSync(path.join(subHome, "auth.json"), JSON.stringify({ refresh_token: "fixture" }));
      const subReg = new AgentRegistry(path.join(subState, "registry.json"));
      const prevEnv: string | undefined = process.env.LLV_STATE_DIR;
      process.env.LLV_STATE_DIR = subState;
      setAgentRegistryForTests(subReg);
      try {
        const t0 = Math.floor(Date.parse("2026-11-24T09:00:00.000Z") / 1000);
        let subClock = t0 * 1000;
        const subAccount = {
          id: "default",
          label: "Default",
          kind: "legacy" as const,
          home: subHome,
          sessionsDir: subSessions,
          auth: "signed_in" as const,
          tierName: "Pro",
          createdAt: 0,
        };
        const subController = new QuotaController(subReg, {
          list: () => [subAccount],
          active: () => "default",
          credentialIdentity: () => "stable-ag-cred",
          probe: async (_e, acc, now) => {
            const read = (await import("@/lib/limits/antigravityTranscriptLimits")).readAntigravityTranscriptLimits(
              subAccount.sessionsDir,
              now,
              { tierName: subAccount.tierName },
            );
            return {
              engine: "antigravity",
              accountId: acc.id,
              authenticated: true,
              authCheckedAt: now,
              limits: read.data,
              provenance: { source: read.source, reason: read.reason, staleSince: null },
              observedAt: read.data?.capturedAt ? read.data.capturedAt * 1000 : now,
              limitReached: read.data !== null,
              ...(read.lastQuotaEventAt === undefined ? {} : { lastQuotaEventAt: read.lastQuotaEventAt }),
            };
          },
        }, "boot-expired-first-seen", () => subClock);

        const subFile = path.join(subSessions, "sess-main", "events.jsonl");
        fs.mkdirSync(path.dirname(subFile), { recursive: true });
        const writeEvt = (evSec: number, resSec: number) => {
          fs.writeFileSync(
            subFile,
            `${JSON.stringify({
              type: "session.quota_exhausted",
              timestamp: new Date(evSec * 1000).toISOString(),
              data: {
                code: "RESOURCE_EXHAUSTED",
                message: "Individual quota reached",
                resetsAt: resSec,
                windowMinutes: 300,
                usedPercent: 100,
                observedAt: evSec,
              },
            })}\n`,
          );
          fs.utimesSync(subFile, evSec, evSec);
        };

        if (withHistory) {
          subReg.recordQuotaObservation({
            engine: "antigravity",
            accountId: "default",
            authenticated: true,
            authCheckedAt: new Date(t0 * 1000).toISOString(),
            limits: {
              session: { usedPercent: 100, resetsAt: t0 + 60, windowMinutes: 300, observedAt: t0, source: "account" },
              weekly: null,
              tiers: [],
              plan: "Pro",
              capturedAt: t0,
            },
            provenance: { source: "transcript", reason: null, staleSince: null },
            observedAt: new Date(t0 * 1000).toISOString(),
            bootId: "boot-prev",
            limitReached: true,
          });
        }

        const expiredSec = withHistory ? t0 + 180 : t0;
        const expiredReset = withHistory ? t0 + 200 : t0 + 120;
        writeEvt(expiredSec, expiredReset);
        subClock = (t0 + 240) * 1000;
        setSystemTime(new Date(subClock));
        await subController.tick("antigravity");
        const afterExpired = subReg.quotaObservations("antigravity").find((r) => r.accountId === "default");
        expect(afterExpired?.lastQuotaEventAt).toBe(expiredSec);
        expect(afterExpired?.limitReached).toBe(false);

        const incomingSec = withHistory ? t0 + 100 : t0 + 180;
        writeEvt(incomingSec, t0 + 3700);
        subClock = (t0 + 250) * 1000;
        setSystemTime(new Date(subClock));
        await subController.tick("antigravity");
        const afterIncoming = subReg.quotaObservations("antigravity").find((r) => r.accountId === "default");
        if (withHistory) {
          expect(afterIncoming?.limitReached).toBe(false);
          expect(afterIncoming?.lastQuotaEventAt).toBe(t0 + 180);
        } else {
          expect(afterIncoming?.limitReached).toBe(true);
          expect(afterIncoming?.limits?.session?.usedPercent).toBe(100);
          expect(afterIncoming?.lastQuotaEventAt).toBe(t0 + 180);
        }
      } finally {
        subReg.close();
        process.env.LLV_STATE_DIR = prevEnv;
        setAgentRegistryForTests(registry);
        fs.rmSync(subRoot, { recursive: true, force: true });
      }
    }
  } finally {
    setSystemTime();
    setAgentRegistryForTests(null);
    registry.close();
    if (prevStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = prevStateDir;
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

test("paid credits survive window-only and failed periodic reads and accept an explicit removal", async () => {
  const registry = new AgentRegistry(path.join(QUOTA_SANDBOX, "paid-credits.json"));
  const account: CodexAccount = { id: "account-a", label: "Account A", kind: "managed", home: QUOTA_SANDBOX,
    sessionsDir: QUOTA_SANDBOX, authPresent: true, loginPane: null, createdAt: 1 };
  let credits: { hasCredits: boolean; balance: string; unlimited: boolean } | undefined = { hasCredits: true, balance: "10", unlimited: false };
  let fail = false;
  const controller = new QuotaController(registry, { list: () => [account], active: () => account.id,
    async probe(engine, candidate, now) {
      if (fail) throw Error("offline");
      return { engine, accountId: candidate.id, authenticated: true, authCheckedAt: now, observedAt: now,
        provenance: { source: "live", reason: null, staleSince: null }, limits: { session: null,
          weekly: { usedPercent: 99, resetsAt: now / 1000 + 86400 }, plan: "pro", capturedAt: now / 1000, credits } };
    } });
  await controller.tick("codex");
  credits = undefined;
  await controller.tick("codex");
  expect(registry.quotaObservations("codex")[0]?.limits?.credits?.hasCredits).toBe(true);
  fail = true;
  await controller.tick("codex");
  expect(registry.quotaObservations("codex")[0]?.limits?.credits?.hasCredits).toBe(true);
  fail = false; credits = { hasCredits: false, balance: "0", unlimited: false };
  await controller.tick("codex");
  expect(registry.quotaObservations("codex")[0]?.limits?.credits?.hasCredits).toBe(false);
});

test.each(["session", "weekly"] as const)("periodic refresh retains a missing blocked %s window", async blocked => {
  const { selectHeadlessAccount } = await import("../headlessSelection");
  const registry = new AgentRegistry(path.join(QUOTA_SANDBOX, `guard-${blocked}.json`));
  const account: CodexAccount = { id: "account-a", label: "Account A", kind: "managed", home: QUOTA_SANDBOX,
    sessionsDir: QUOTA_SANDBOX, authPresent: true, loginPane: null, createdAt: 1 };
  let now = Date.now();
  let limits: import("@/lib/types").EngineLimits = { session: { usedPercent: 99, resetsAt: null },
    weekly: { usedPercent: 99, resetsAt: null }, plan: "pro", capturedAt: now / 1000,
    credits: { hasCredits: true, balance: "10", unlimited: false } };
  const controller = new QuotaController(registry, { list: () => [account], active: () => account.id,
    credentialIdentity: () => "fixture", probe: async engine => ({ engine, accountId: account.id, authenticated: true,
      authCheckedAt: now, observedAt: now, provenance: { source: "live", reason: null, staleSince: null }, limits }) }, "fixture", () => now);
  const selection = () => selectHeadlessAccount([account], registry.quotaObservations("codex"), account.id, [], now).kind;
  try {
    await controller.tick("codex");
    for (const partial of [{ session: null, weekly: null }, { session: { usedPercent: 1, resetsAt: null }, weekly: { usedPercent: 1, resetsAt: null }, [blocked]: null }]) {
      limits = { ...limits, ...partial, credits: undefined }; now += 1000;
      await controller.tick("codex"); expect(selection()).toBe("exhausted");
    }
    limits = { ...limits, session: { usedPercent: 1, resetsAt: null }, weekly: { usedPercent: 1, resetsAt: null } }; now += 1000;
    await controller.tick("codex"); expect(selection()).toBe("available");
  } finally { registry.close(); }
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


test("a quota probe still in flight leaves resume, send and spawn admission available", async () => {
  const registry = new AgentRegistry(path.join(QUOTA_SANDBOX, "slow-probe-registry.json"));
  const conversation = registry.ensureConversation("codex", "/fixture/session.jsonl", "default");
  const account: CodexAccount = { id: "default", label: "Account A", kind: "legacy", home: "/fixture/home", sessionsDir: "/fixture/home/sessions", authPresent: true, loginPane: null, createdAt: 0 };
  let entered!: () => void;
  let finishProbe!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const probeHeld = new Promise<void>((resolve) => { finishProbe = resolve; });
  const controller = new QuotaController(registry, {
    list: () => [account], active: () => "default",
    async probe(engine, candidate, now) {
      entered();
      /* Held until every admission below has answered, so none of them can
         have waited for the probe to finish. */
      await probeHeld;
      return { engine, accountId: candidate.id, authenticated: true, limits: null, provenance: { source: "live", reason: null, staleSince: null }, observedAt: now };
    },
  });
  const tick = controller.tick("codex");
  await started;
  try {
    const resume = registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", conversationId: conversation.id, purpose: "resume-successor", origin: { kind: "successor" }, launchProfile: { title: "Slow probe resume" } });
    const send = withAccountMutationLock(() => registry.holdDelivery(conversation.id, "hello", "slow-probe-send"));
    const spawn = registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Slow probe spawn" } });
    expect(resume.kind).toBe("created");
    expect(send.id).toBeTruthy();
    expect(spawn.kind).toBe("created");
  } finally {
    finishProbe();
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


test("a long provider wait never becomes an account mutation lease", async () => {
  const { ManagedCodexRuntime } = await import("@/lib/accounts/codexRuntime");
  const registry = new AgentRegistry(path.join(QUOTA_SANDBOX, "long-probe", "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const account: CodexAccount = { id: "default", label: "Account A", kind: "legacy", home: path.join(QUOTA_SANDBOX, "home"), sessionsDir: path.join(QUOTA_SANDBOX, "home", "sessions"), authPresent: true, loginPane: null, createdAt: 0 };
  let entered!: () => void;
  let finishProvider!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  /* The provider waits until the test lets it go, which stands for a wait of
     any length (the incident's was eleven seconds). */
  const providerHeld = new Promise<void>((resolve) => { finishProvider = resolve; });
  let providerDone = false;
  const runtime = new ManagedCodexRuntime({ startClient: async () => {
    entered();
    await providerHeld;
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
  const tick = controller.tick("codex");
  try {
    await ready;
    expect(fs.existsSync(lock)).toBeFalse();
    const admissions = await Promise.all([1, 2].map((number) => registry.beginSpawnRequestAsync({
      engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default",
      clientAttemptId: `parallel-stage-${number}`, launchProfile: { title: "Parallel stage admission" },
    })));
    expect(admissions.map((entry) => entry.kind)).toEqual(["created", "created"]);
    /* The provider is still waiting and no lease is open: every lease taken so
       far was released before this point, so none spans the wait. */
    expect(providerDone).toBeFalse();
    expect(fs.existsSync(lock)).toBeFalse();
    expect(acquiredAt).toBeNull();
    finishProvider();
    await tick;
    expect(holds.length).toBeGreaterThanOrEqual(4);
    expect(registry.quotaObservations("codex")[0]?.provenance.reason).toBe("quota-probe-failed");
    // Hold times are reported, never asserted (#1761).
    console.info(JSON.stringify({ measurement: "slow-provider-lock", holds: holds.length, maxHoldMs: Math.round(Math.max(...holds) * 100) / 100 }));
  } finally {
    finishProvider();
    await tick;
    openSpy.mockRestore(); removeSpy.mockRestore();
  }
}, 15_000);

test("a Codex probe records the provider's reached-limit marker beside the percentages it read", async () => {
  const sessionsDir = path.join(QUOTA_SANDBOX, "reached-sessions");
  const account = { id: "managed", kind: "managed", home: path.join(QUOTA_SANDBOX, "reached-home"), sessionsDir } as CodexAccount;
  const probe = (limitReached?: boolean) => ({
    account: { account: null, requiresOpenaiAuth: true },
    rateLimits: { primary: { usedPercent: 10, resetsAt: null, windowDurationMins: 300 }, secondary: null, planType: "pro" },
    resetCredits: null, authenticated: true, envelope: null, ...(limitReached === undefined ? {} : { limitReached }),
  });
  const now = Date.now();
  const reached = durableQuotaObservation(await codexObservationFromProbe(account, probe(true), now), "boot-reached-test");
  expect(reached).toMatchObject({ limitReached: true, limits: { session: { usedPercent: 10 } } });
  expect(durableQuotaObservation(await codexObservationFromProbe(account, probe(false), now), "boot-reached-test")).toMatchObject({ limitReached: false });
  expect(durableQuotaObservation(await codexObservationFromProbe(account, probe(), now), "boot-reached-test")).not.toHaveProperty("limitReached");
});


test("identical cached quota observations do not rewrite registry history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-idle-quota-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  let now = Date.parse("2026-10-16T00:00:00Z");
  const account: CodexAccount = { id: "account-a", label: "Fixture", kind: "managed", home: path.join(root, "account"),
    sessionsDir: path.join(root, "account/sessions"), authPresent: true, loginPane: null, createdAt: 1 };
  const controller = new QuotaController(registry, { list: () => [account], active: () => account.id, credentialIdentity: () => "fixture",
    probe: async engine => ({ engine, accountId: account.id, authenticated: true, authCheckedAt: now,
      limits: { session: { usedPercent: 10, resetsAt: null }, weekly: null, plan: "pro", capturedAt: now / 1000 },
      provenance: { source: "cache", reason: null, staleSince: null }, observedAt: now }),
  }, "fixture-boot", () => now);
  try {
    await controller.tick("codex");
    const revision = registry.storageDiagnostics().revision;
    await controller.tick("codex");
    expect(registry.storageDiagnostics().revision).toBe(revision);
    const observations = registry.quotaObservations("codex");
    registry.recordQuotaEvaluation({ engine: "codex", observations, signature: "fixture-sustain", bootId: "fixture-boot",
      now: new Date(now).toISOString(), minimumGapMs: 60000 });
    await controller.tick("codex");
    expect(registry.autoBalancePolicy("codex").sustain).toBeNull();
    now += 60000;
    await controller.tick("codex");
    expect(registry.quotaObservations("codex")[0]!.authCheckedAt).toBe(new Date(now).toISOString());
  } finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
});


test("a Codex tick batches only authenticated live observations into forward history", async () => {
  const { readHistory } = await import("@/lib/limitsHistoryStore");
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"quota-history-"));
  const now=Date.parse("2026-10-18T12:00:00Z");
  try {
    let registry=new AgentRegistry(path.join(root,"registry.json"));
    const ids=["live-history","transcript-history","cached-history","unsigned-history"];
    const accounts:CodexAccount[]=ids.map(id=>({id,label:"Fixture",kind:"managed",home:path.join(root,id),sessionsDir:path.join(root,id,"sessions"),authPresent:true,loginPane:null,createdAt:1}));
    const probe: QuotaProbePort = {
      list:()=>accounts, active:()=>ids[0]!,credentialIdentity:()=>"stable-fixture",
      async probe(engine,account) { return {engine,accountId:account.id,authenticated:account.id!==ids[3],authCheckedAt:now,
        limits:{session:null,weekly:{usedPercent:25,resetsAt:now/1000+3600},plan:"pro",capturedAt:now/1000},
        provenance:{source:account.id===ids[2]?"cache":account.id===ids[1]?"transcript":"live",reason:null,staleSince:null},observedAt:now}; },
    };
    const controller=new QuotaController(registry,probe,"fixture-boot",()=>now);
    await controller.tick("codex");
    const history=readHistory();
    expect(history.series[`codex|${ids[0]}|weekly`]).toEqual([{t:now/1000,remaining:75}]);
    // A transcript window is revocable custody evidence; the backfill rereads it.
    expect(history.series[`codex|${ids[1]}|weekly`]).toBeUndefined();
    expect(history.series[`codex|${ids[2]}|weekly`]).toBeUndefined(); expect(history.series[`codex|${ids[3]}|weekly`]).toBeUndefined();
    await controller.tick("codex");
    expect(readHistory()).toEqual(history);
    registry.close();
    registry=new AgentRegistry(path.join(root,"registry.json"));
    await new QuotaController(registry,probe,"reopened-fixture-boot",()=>now).tick("codex");
    expect(readHistory()).toEqual(history);
    registry.close();
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
