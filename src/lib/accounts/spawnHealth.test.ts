import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON } from "@/lib/types";

import type { ClaudeAccount } from "./claude";

const NOW = Date.parse("2026-07-14T09:00:00.000Z");
const STATE_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-health-state-"));
const PREVIOUS_STATE = process.env.LLV_STATE_DIR;
const PREVIOUS_HOME = process.env.LLV_CLAUDE_HOME;
const PREVIOUS_FETCH = globalThis.fetch;
let providerReads = 0;
let providerReply: (() => Response | Promise<Response>) | null = null;
process.env.LLV_STATE_DIR = path.join(STATE_SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(STATE_SANDBOX, "legacy-claude");
globalThis.fetch = (async () => {
  providerReads += 1;
  if (providerReply) return providerReply();
  return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401, headers: { "content-type": "application/json" } });
}) as unknown as typeof globalThis.fetch;
const { claudeValidityFromLimitRead, NoHealthyClaudeAccountError, selectHealthyClaudeAccount } = await import("./spawnHealth");
const { withAccountMutationLockAsync } = await import("./accountMutation");
const { seedAccountRegistry } = await import("./accountsStoreFixture");
const { closeAgentRegistryForTests } = await import("@/lib/agent/registry");
/* The process-wide registry keeps its SQLite store open; close it before the
   store's directory goes, or macOS answers the next query with
   SQLITE_IOERR_VNODE. */
function removeStateDir() {
  closeAgentRegistryForTests();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
}
const homes: string[] = [];
const current = () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null } as const);
const lastKnown = () => ({ kind: "admissible", basis: "last-known", stale: true, retryAt: null } as const);
const unavailable = () => ({ kind: "unavailable", reason: "auth-failed", stale: false, retryAt: null } as const);

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  if (PREVIOUS_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = PREVIOUS_STATE;
  if (PREVIOUS_HOME === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = PREVIOUS_HOME;
  globalThis.fetch = PREVIOUS_FETCH;
  closeAgentRegistryForTests();
  fs.rmSync(STATE_SANDBOX, { recursive: true, force: true });
});

function account(id: string, expiresAt: number, authPresent = true, refreshable = true): ClaudeAccount {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `llv-spawn-health-${id}-`));
  homes.push(home);
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      ["access" + "Token"]: crypto.randomUUID(),
      ...(refreshable ? { refreshToken: crypto.randomUUID() } : {}),
      expiresAt,
    },
  }), { mode: 0o600 });
  return { id, label: id, kind: "managed", home, projectsDir: path.join(home, "projects"), authPresent, createdAt: 0 };
}

for (const kind of ["legacy", "managed"] as const) {
  for (const uncertainty of ["discovery", "metadata"] as const) {
    test("production spawn caller refuses " + kind + " requested account uncertainty at " + uncertainty, async () => {
      const store = await import("./claudeCredentials");
      const originalRead = store.readClaudeCredentials;
      const read = spyOn(store, "readClaudeCredentials").mockImplementation((home) => originalRead(home, {
        platform: "linux", security: () => { throw new Error("unexpected Keychain access"); },
      }));
      const { createManagedClaudeAccount, listClaudeAccounts } = await import("./claude");
      const { resolveHealthySpawnAccount } = await import("./manager");
      removeStateDir();
      fs.mkdirSync(process.env.LLV_CLAUDE_HOME!, { recursive: true, mode: 0o700 });
      const requested = kind === "legacy" ? listClaudeAccounts()[0] : createManagedClaudeAccount("Account A");
      const fallback = createManagedClaudeAccount("Account B");
      const document = { claudeAiOauth: { ["access" + "Token"]: crypto.randomUUID(), expiresAt: Date.now() + 3600_000 } };
      let requestedReads = 0;
      read.mockImplementation((home) => {
        if (home === requested.home) {
          requestedReads += 1;
          // The manager discovers the catalog twice before metadata is read.
          if (uncertainty === "discovery" || requestedReads > 2) return { state: "unknown" };
        }
        if (home === requested.home || home === fallback.home) return { state: "present", source: "keychain", document };
        return { state: "absent" };
      });
      providerReply = () => Response.json({ five_hour: { utilization: 1, resets_at: new Date(Date.now() + 3600_000).toISOString() } });
      try {
        const outcome = await resolveHealthySpawnAccount("claude", requested.id).then(
          (selected) => ({ selectedAccountId: selected.accountId }), (error: unknown) => ({ error }),
        );
        expect("error" in outcome).toBe(true);
        expect((outcome as { error: Error }).error.name).toBe("ClaudeCredentialUnavailableError");
        expect((outcome as { error: Error }).error.message).toContain("credential store is unavailable");
        expect(requestedReads).toBe(uncertainty === "discovery" ? 2 : 3);

        // Prove the alternate account really can pass the production caller.
        const healthy = await resolveHealthySpawnAccount("claude", fallback.id);
        expect(healthy.accountId).toBe(fallback.id);
        expect(healthy.requestedAdmission).toMatchObject({ kind: "admissible", basis: "current" });

        // Proven absence retains the existing fallback behavior.
        read.mockImplementation((home) => home === fallback.home
          ? { state: "present", source: "keychain", document } : { state: "absent" });
        expect((await resolveHealthySpawnAccount("claude", requested.id)).accountId).toBe(fallback.id);

        read.mockReturnValue({ state: "unknown" });
        await expect(resolveHealthySpawnAccount("claude")).rejects.toThrow("credential store is unavailable");
      } finally {
        read.mockRestore();
        providerReply = null;
        removeStateDir();
      }
    });
  }
}

for (const [healthyKind, kind] of [["legacy", "managed"], ["managed", "legacy"], ["managed", "managed"]] as const) {
  for (const phase of ["discovery", "metadata", "probe", "refresh", "probe-before-refresh"] as const) {
    test("production caller keeps " + healthyKind + " healthy despite unrelated " + kind + " uncertainty at " + phase, async () => {
      const store = await import("./claudeCredentials");
      const read = spyOn(store, "readClaudeCredentials").mockReturnValue({ state: "absent" });
      const { createManagedClaudeAccount, listClaudeAccounts } = await import("./claude");
      const { resolveHealthySpawnAccount } = await import("./manager");
      removeStateDir();
      fs.mkdirSync(process.env.LLV_CLAUDE_HOME!, { recursive: true, mode: 0o700 });
      const uncertain = kind === "legacy" ? listClaudeAccounts()[0] : createManagedClaudeAccount("Account B");
      const healthy = healthyKind === "legacy" ? listClaudeAccounts()[0] : createManagedClaudeAccount("Account A");
      const reads = new Map<string, number>();
      let injectUnknown = false;
      let healthyPresent = true;
      let injectedReads = 0;
      const expiry = Date.now() + 3600_000;
      const document = { claudeAiOauth: {
        ["access" + "Token"]: crypto.randomUUID(),
        ["refresh" + "Token"]: crypto.randomUUID(),
        expiresAt: expiry,
      } };
      read.mockImplementation((home) => {
        if (home !== uncertain.home && home !== healthy.home) return { state: "absent" };
        if (home === healthy.home && !healthyPresent) return { state: "absent" };
        const count = (reads.get(home) ?? 0) + 1;
        reads.set(home, count);
        // Two catalog reads precede metadata. Probe/refresh first re-read the
        // catalog under the mutation lock, then read this account's store.
        const threshold = phase === "discovery" ? 0 : phase === "metadata" ? 2 : 3;
        if (injectUnknown && home === uncertain.home && count > threshold) {
          injectedReads += 1;
          return { state: "unknown" };
        }
        // Expired at metadata, then concurrently rotated before refresh. This
        // exercises the real refresh lock, store read and subsequent live probe.
        const expired = (phase === "refresh" || (phase === "probe-before-refresh" && home === healthy.home)) && count <= 3;
        return { state: "present", source: "keychain", document: {
          claudeAiOauth: { ...document.claudeAiOauth, expiresAt: expired ? Date.now() - 60_000 : expiry },
        } };
      });
      providerReply = () => Response.json({ five_hour: { utilization: 1, resets_at: new Date(expiry).toISOString() } });
      const resolve = async (requested?: string) => {
        reads.clear();
        injectedReads = 0;
        return resolveHealthySpawnAccount("claude", requested);
      };
      try {
        // Control: both candidates can pass the same production caller.
        expect((await resolve(healthy.id)).accountId).toBe(healthy.id);
        expect((await resolve(uncertain.id)).accountId).toBe(uncertain.id);
        injectUnknown = true;
        const selected = await resolve(healthy.id);
        expect(selected.accountId).toBe(healthy.id);
        expect(selected.requestedAdmission).toMatchObject({ kind: "admissible", basis: "current" });
        if (phase !== "refresh") expect(injectedReads).toBeGreaterThan(0);

        // Automatic routing exercises the aggregate refresh pass as well as
        // proving the unknown candidate cannot win an unpinned selection.
        expect((await resolve()).accountId).toBe(healthy.id);
        expect(injectedReads).toBeGreaterThan(0);

        // The same uncertainty on the named account must refuse substitution.
        await expect(resolve(uncertain.id)).rejects.toThrow("credential store is unavailable");
        expect(injectedReads).toBeGreaterThan(0);

        // With no healthy candidate left, preserve the uncertainty diagnosis.
        healthyPresent = false;
        await expect(resolve()).rejects.toThrow("credential store is unavailable");
        expect(injectedReads).toBeGreaterThan(0);
      } finally {
        read.mockRestore();
        providerReply = null;
        removeStateDir();
      }
    });
  }
}

test("spawn selection skips an unrefreshable expired preferred Claude account and probes a healthy fallback", async () => {
  const expired = account("expired", NOW - 1, true, false);
  const healthy = account("healthy", NOW + 60_000);
  const probed: string[] = [];

  const selected = await selectHealthyClaudeAccount([expired, healthy], "expired", {
    now: () => NOW,
    probe: async (candidate) => {
      probed.push(candidate.id);
      return current();
    },
    refresh: async () => unavailable(),
  });

  expect(selected.account.id).toBe("healthy");
  expect(probed).toEqual(["healthy"]);
});

test("spawn selection does not await an expired account when a current account can launch", async () => {
  const expired = account("expired", NOW - 1);
  const healthy = account("healthy", NOW + 60_000);
  let refreshCalls = 0;

  const selected = await selectHealthyClaudeAccount([expired, healthy], "healthy", {
    now: () => NOW,
    probe: async () => current(),
    refresh: async () => {
      refreshCalls += 1;
      await new Promise(() => {});
      return lastKnown();
    },
  });

  expect(selected.account.id).toBe("healthy");
  expect(refreshCalls).toBe(0);
});

test("live usage evidence retains spawn validity classifications", () => {
  expect(claudeValidityFromLimitRead({ source: "live", reason: null, data: null }, NOW)).toMatchObject({ kind: "admissible", basis: "current", stale: false });
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: LIMITS_RATE_LIMITED_REASON, data: null, retryAt: NOW + 60_000 }, NOW)).toEqual({
    kind: "admissible",
    basis: "last-known",
    stale: true,
    retryAt: null,
  });
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: LIMITS_REAUTH_REQUIRED_REASON, data: null }, NOW)).toMatchObject({ kind: "unavailable", reason: "auth-failed" });
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: "credentials missing access token", data: null }, NOW)).toMatchObject({ kind: "unavailable", reason: "auth-failed" });
  expect(() => claudeValidityFromLimitRead({ source: "unavailable", reason: "credentials unreadable: test fixture", data: null }, NOW)).toThrow("credential store is unavailable");
  expect(() => claudeValidityFromLimitRead({ source: "unavailable", reason: "credential store unavailable", data: null }, NOW)).toThrow("credential store is unavailable");
  expect(claudeValidityFromLimitRead({ source: "unavailable", reason: "request timed out", data: null }, NOW)).toMatchObject({ kind: "admissible", basis: "last-known", stale: true });
  const retryAt = Math.floor(NOW / 1_000) + 900;
  expect(claudeValidityFromLimitRead({
    source: "live",
    reason: null,
    data: {
      session: { usedPercent: 100, resetsAt: retryAt },
      weekly: { usedPercent: 20, resetsAt: retryAt + 3_600 },
      plan: "pro",
      capturedAt: Math.floor(NOW / 1_000),
    },
  }, NOW)).toEqual({
    kind: "retry-at",
    reason: "hard-limit",
    stale: false,
    retryAt: new Date(retryAt * 1_000).toISOString(),
  });
});

test("an exhausted explicit account exposes its retry deadline while routing finds a healthy fallback", async () => {
  const pinned = account("account-a", NOW + 60_000);
  const fallback = account("account-b", NOW + 60_000);
  const retryAt = Math.floor(NOW / 1_000) + 900;
  const selected = await selectHealthyClaudeAccount([pinned, fallback], pinned.id, {
    now: () => NOW,
    probe: async (candidate) => candidate.id === pinned.id
      ? claudeValidityFromLimitRead({
          source: "live",
          reason: null,
          data: {
            session: { usedPercent: 100, resetsAt: retryAt },
            weekly: null,
            plan: "pro",
            capturedAt: Math.floor(NOW / 1_000),
          },
        }, NOW)
      : current(),
    refresh: async () => unavailable(),
  });

  expect(selected.account.id).toBe(fallback.id);
  expect(selected.requestedAdmission).toMatchObject({
    kind: "retry-at",
    retryAt: new Date(retryAt * 1_000).toISOString(),
  });
});

test("an unavailable explicit pin falls back to the healthy active account before account-id ordering", async () => {
  const requested = account("account-z", NOW + 60_000);
  const lexicalFirst = account("account-a", NOW + 60_000);
  const active = account("account-b", NOW + 60_000);

  const selected = await selectHealthyClaudeAccount([
    requested,
    lexicalFirst,
    active,
  ], requested.id, {
    now: () => NOW,
    probe: async (candidate) => candidate.id === requested.id ? unavailable() : current(),
    refresh: async () => unavailable(),
  }, true, active.id);

  expect(selected.account.id).toBe(active.id);
  expect(selected.requestedAdmission).toEqual(unavailable());
});

test("a self-throttled prober launches the preferred account from last-known stale state", async () => {
  const accounts = [account("account-a", NOW + 60_000), account("account-b", NOW + 60_000)];
  const retryAt = NOW + 5 * 60_000;

  const selected = await selectHealthyClaudeAccount(accounts, "account-b", {
    now: () => NOW,
    probe: async () => claudeValidityFromLimitRead({
      source: "unavailable",
      reason: LIMITS_RATE_LIMITED_REASON,
      data: null,
      retryAt,
    }, NOW),
    refresh: async () => { throw new Error("refresh should not run"); },
  });

  expect(selected.account.id).toBe("account-b");
  expect(selected.admission).toEqual({
    kind: "admissible",
    basis: "last-known",
    stale: true,
    retryAt: null,
  });
});

test("spawn selection refreshes an expired preferred Claude account before admission", async () => {
  const expired = account("expired", NOW - 1);
  const refreshed: string[] = [];

  const selected = await selectHealthyClaudeAccount([expired], "expired", {
    now: () => NOW,
    probe: async () => {
      throw new Error("current-access probe should not run");
    },
    refresh: async (candidate) => {
      refreshed.push(candidate.id);
      return current();
    },
  });

  expect(selected.account.id).toBe("expired");
  expect(refreshed).toEqual(["expired"]);
});

test("Claude provider checks waiting behind deletion re-resolve retired accounts before activity", async () => {
  const stateFile = path.join(process.env.LLV_STATE_DIR!, "claude-accounts.json");
  const managedAccount = (id: string, expiresAt: number): ClaudeAccount => {
    const home = path.join(STATE_SANDBOX, "accounts", "claude", id);
    fs.mkdirSync(path.join(home, "projects"), { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        ["access" + "Token"]: crypto.randomUUID(),
        ["refresh" + "Token"]: crypto.randomUUID(),
        expiresAt,
      },
    }), { mode: 0o600 });
    return { id, label: id, kind: "managed", home, projectsDir: path.join(home, "projects"), authPresent: true, createdAt: 1 };
  };
  const observedNow = Date.now();
  const expired = managedAccount("refresh-stale", observedNow - 1);
  const currentAccount = managedAccount("probe-stale", observedNow + 60_000);
  const activeRegistry = {
    version: 1,
    active: "default",
    accounts: [expired, currentAccount].map(({ id, label, kind, createdAt }) => ({ id, label, kind, createdAt })),
    retired: [],
  };
  const retiredRegistry = {
    version: 1,
    active: "default",
    accounts: [],
    retired: [expired, currentAccount].map(({ id, label }) => ({ id, label, retiredAt: 2 })),
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  seedAccountRegistry("claude", activeRegistry);
  providerReads = 0;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withAccountMutationLockAsync(async () => {
    entered();
    await held;
    seedAccountRegistry("claude", retiredRegistry);
  });
  await acquired;

  const refreshResult = selectHealthyClaudeAccount([expired], expired.id).then(() => null, (error: unknown) => error);
  const probeResult = selectHealthyClaudeAccount([currentAccount], currentAccount.id).then(() => null, (error: unknown) => error);
  await Bun.sleep(10);
  expect(providerReads).toBe(0);
  release();
  await holder;

  expect(await refreshResult).toBeInstanceOf(Error);
  expect(await probeResult).toBeInstanceOf(Error);
  expect(providerReads).toBe(0);
});

test("a validity probe whose catalog revision moved returns replayable admission contention", async () => {
  const { createManagedClaudeAccount, listClaudeAccounts } = await import("./claude");
  const created = createManagedClaudeAccount("Revision fixture");
  fs.writeFileSync(path.join(created.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { ["access" + "Token"]: crypto.randomUUID(), expiresAt: Date.now() + 60_000 } }), { mode: 0o600 });
  const selected = listClaudeAccounts().find(candidate => candidate.id === created.id)!;
  providerReply = () => {
    createManagedClaudeAccount("Concurrent catalog writer");
    return new Response(JSON.stringify({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 } }), { headers: { "content-type": "application/json" } });
  };
  try {
    await expect(selectHealthyClaudeAccount([selected], selected.id)).rejects.toMatchObject({ name: "AccountAdmissionChangedError" });
  } finally { providerReply = null; }
});

test.each(["revision", "busy"] as const)("automatic bound-project admission preserves replayable %s failures", async (failure) => {
  const { createManagedClaudeAccount } = await import("./claude");
  const { bindAccountToProject } = await import("./projectBindings");
  const { resolveHealthySpawnAccount } = await import("./manager");
  const { ACCOUNT_MUTATION_WAIT_MS, ACCOUNT_STORE_BUSY_MESSAGE } = await import("./accountMutation");
  const { foreignAccountHolder } = await import("./accountMutation.fixture");
  const created = createManagedClaudeAccount("Bound admission fixture");
  fs.writeFileSync(path.join(created.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { ["access" + "Token"]: crypto.randomUUID(), expiresAt: Date.now() + 60_000 } }), { mode: 0o600 });
  const project = `repo-bound-admission-${failure}`;
  expect(bindAccountToProject("claude", created.id, project).ok).toBe(true);
  let holder: Awaited<ReturnType<typeof foreignAccountHolder>> | undefined;
  providerReply = async () => {
    if (failure === "revision") createManagedClaudeAccount("Concurrent bound-project writer");
    else {
      holder = await foreignAccountHolder();
      holder.releaseAfter(ACCOUNT_MUTATION_WAIT_MS + 150);
    }
    return Response.json({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 } });
  };
  try {
    const error = await resolveHealthySpawnAccount("claude", undefined, project).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({
      name: failure === "revision" ? "AccountAdmissionChangedError" : "AccountMutationBusyError",
      message: failure === "revision" ? "The account changed while preparing the launch; try again shortly." : ACCOUNT_STORE_BUSY_MESSAGE,
    });
    expect((error as Error).message).not.toMatch(/pid|claude|codex|held by|account mutation/i);
  } finally {
    providerReply = null;
    await holder?.close();
  }
}, 20_000);

test("concurrent admissions coalesce refresh validation for one account", async () => {
  const expired = account("concurrent", NOW - 1);
  let refreshCalls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const dependencies = {
    now: () => NOW,
    probe: async () => unavailable(),
    refresh: async () => {
      refreshCalls += 1;
      await held;
      return current();
    },
  };

  const first = selectHealthyClaudeAccount([expired], expired.id, dependencies);
  const second = selectHealthyClaudeAccount([expired], expired.id, dependencies);
  await Promise.resolve();
  await Promise.resolve();

  expect(refreshCalls).toBe(1);
  release();
  expect((await first).account.id).toBe(expired.id);
  expect((await second).account.id).toBe(expired.id);
});

test("three expired accounts deterministically select the sole refreshable account", async () => {
  const accounts = [account("charlie", NOW - 1), account("alpha", NOW - 1), account("bravo", NOW - 1)];

  const selected = await selectHealthyClaudeAccount(accounts, "charlie", {
    now: () => NOW,
    probe: async () => unavailable(),
    refresh: async (candidate) => candidate.id === "bravo" ? current() : unavailable(),
  });

  expect(selected.account.id).toBe("bravo");
});

test("requested-account routing breaks ties inside one health tier", async () => {
  const accounts = [account("charlie", NOW + 60_000), account("alpha", NOW + 60_000), account("bravo", NOW + 60_000)];
  const dependencies = {
    now: () => NOW,
    probe: async () => current(),
    refresh: async () => unavailable(),
  };

  expect((await selectHealthyClaudeAccount(accounts, "charlie", dependencies)).account.id).toBe("charlie");
  expect((await selectHealthyClaudeAccount(accounts, null, dependencies)).account.id).toBe("alpha");
});

test("missing and non-refreshable credentials stay fenced without validation calls", async () => {
  const missing = account("missing", NOW + 60_000, false);
  const expired = account("no-refresh", NOW - 1, true, false);
  let calls = 0;

  await expect(selectHealthyClaudeAccount([missing, expired], null, {
    now: () => NOW,
    probe: async () => { calls += 1; return current(); },
    refresh: async () => { calls += 1; return current(); },
  })).rejects.toBeInstanceOf(NoHealthyClaudeAccountError);

  expect(calls).toBe(0);
});

test("an unpinned routed account yields to current evidence when its last-known state is stale", async () => {
  const stale = account("stale", NOW + 60_000);
  const confirmed = account("confirmed", NOW + 60_000);

  const selected = await selectHealthyClaudeAccount([stale, confirmed], "stale", {
    now: () => NOW,
    probe: async (candidate) => candidate.id === "confirmed" ? current() : lastKnown(),
    refresh: async () => unavailable(),
  }, false);

  expect(selected.account.id).toBe("confirmed");
  expect(selected.requestedAdmission).toBeUndefined();
});

test("spawn selection reports every dead account when none can launch", async () => {
  const expired = account("expired", NOW - 1);
  const rejected = account("rejected", NOW + 60_000);

  try {
    await selectHealthyClaudeAccount([expired, rejected], "expired", {
      now: () => NOW,
      probe: async () => unavailable(),
      refresh: async () => unavailable(),
    });
    throw new Error("expected selection to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(NoHealthyClaudeAccountError);
    expect((error as Error).message).toContain("expired");
    expect((error as Error).message).toContain("rejected");
    expect((error as Error).message).toContain("Re-login");
  }
});


test("shared refresh is classified separately for Fable and Sonnet without another usage read", async () => {
  const candidate = account("shared-tier", NOW - 1000);
  let refreshes = 0;
  const dependencies = {
    now: () => NOW,
    probe: async () => { throw new Error("expired account must refresh"); },
    refresh: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const limitRead = { source: "live" as const, reason: null, data: {
        session: { usedPercent: 10, resetsAt: NOW / 1000 + 3600 },
        weekly: { usedPercent: 20, resetsAt: NOW / 1000 + 86400 },
        tiers: [{ tier: "fable", usedPercent: 100, resetsAt: NOW / 1000 + 86400 }],
        plan: "max", capturedAt: NOW / 1000,
      } };
      return { ...claudeValidityFromLimitRead(limitRead, NOW), limitRead };
    },
  };
  const results = await Promise.allSettled([
    selectHealthyClaudeAccount([candidate], candidate.id, dependencies, true, candidate.id, "fable"),
    selectHealthyClaudeAccount([candidate], candidate.id, dependencies, true, candidate.id, "sonnet"),
  ]);
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("fulfilled");
  expect(refreshes).toBe(1);
});

for (const change of ["unrelated", "catalog during refresh", "removed during refresh", "credentials during refresh"] as const)
for (const withFallback of [false, true]) test(`a pinned expired Claude account fences ${change} (fallback: ${withFallback})`, async () => {
  const { createManagedClaudeAccount, listClaudeAccounts } = await import("./claude");
  const { recordSpawnAdmissionRejection } = await import("@/lib/agent/spawnAdmission");
  const { readAccountSource, writeAccountSource } = await import("./accountsStore");
  removeStateDir();
  const created = createManagedClaudeAccount("Expired pinned fixture");
  fs.writeFileSync(path.join(created.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    ["access" + "Token"]: crypto.randomUUID(), refreshToken: crypto.randomUUID(), expiresAt: Date.now() - 1,
  } }), { mode: 0o600 });
  if (withFallback) {
    const fallback = createManagedClaudeAccount("Current refresh fallback");
    fs.writeFileSync(path.join(fallback.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      ["access" + "Token"]: crypto.randomUUID(), expiresAt: Date.now() + 60_000,
    } }), { mode: 0o600 });
  }
  let requests = 0;
  providerReply = () => {
    requests += 1;
    if (requests === 1) {
      if (change === "credentials during refresh") {
        fs.writeFileSync(path.join(created.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
          ["access" + "Token"]: crypto.randomUUID(), refreshToken: crypto.randomUUID(), expiresAt: Date.now() + 60_000,
        } }), { mode: 0o600 });
      } else if (change !== "unrelated") {
        const read = readAccountSource("claude-accounts.json");
        if (read.kind !== "collection") throw new Error("Missing fixture catalog");
        const catalog = read.body as { accounts: { id: string; label: string }[] };
        if (change === "catalog during refresh") catalog.accounts.find(row => row.id === created.id)!.label = "Changed refresh pin";
        else catalog.accounts = catalog.accounts.filter(row => row.id !== created.id);
        writeAccountSource("claude-accounts.json", catalog);
      }
      const fresh = crypto.randomUUID();
      return Response.json({ access_token: fresh, expires_in: 3_600 });
    }
    if (requests === 2) recordSpawnAdmissionRejection({ clientAttemptId: "unrelated-refresh-key", requestDigest: "a".repeat(64), status: 400, error: "role is not offered" }, () => null);
    return Response.json({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 } });
  };
  try {
    const selection = selectHealthyClaudeAccount(listClaudeAccounts(), created.id);
    if (change === "unrelated") {
      const selected = await selection;
      expect(selected.account.id).toBe(created.id);
      expect(selected.admission).toMatchObject({ kind: "admissible", basis: "current" });
      expect(requests).toBe(3);
    } else {
      await expect(selection).rejects.toMatchObject({ name: "AccountAdmissionChangedError" });
      expect(requests).toBe(1);
    }
  } finally { providerReply = null; removeStateDir(); }
});

for (const outcome of ["invalid", "unknown"] as const) test(`a changed expired pin stays unreserved after ${outcome} refresh`, async () => {
  const { createManagedClaudeAccount } = await import("./claude");
  const { readAccountSource, writeAccountSource } = await import("./accountsStore");
  const { accountManager, resolveHealthySpawnAccount } = await import("./manager");
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/spawn/route");
  const { clearAccountTestState } = await import("./accountsStoreFixture");
  clearAccountTestState(process.env.LLV_STATE_DIR!);
  const { resetLegacyDocumentStoresForTests } = await import("@/lib/state/legacyDocumentStore");
  resetLegacyDocumentStoresForTests();
  const pin = createManagedClaudeAccount("Rejected refresh pin");
  const fallback = createManagedClaudeAccount("Rejected refresh fallback");
  fs.writeFileSync(path.join(pin.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    ["access" + "Token"]: crypto.randomUUID(), refreshToken: crypto.randomUUID(), expiresAt: Date.now() - 1,
  } }), { mode: 0o600 });
  fs.writeFileSync(path.join(fallback.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    ["access" + "Token"]: crypto.randomUUID(), expiresAt: Date.now() + 60_000,
  } }), { mode: 0o600 });
  const cwd = fs.mkdtempSync(path.join(STATE_SANDBOX, "rejected-refresh-"));
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "closed.sock");
  let requests = 0;
  providerReply = () => {
    requests += 1;
    if (requests === 1) {
      const read = readAccountSource("claude-accounts.json");
      if (read.kind !== "collection") throw new Error("Missing fixture catalog");
      const catalog = read.body as { accounts: { id: string; label: string }[] };
      catalog.accounts.find(row => row.id === pin.id)!.label = "Changed rejected pin";
      writeAccountSource("claude-accounts.json", catalog);
      return Response.json({ error: outcome === "invalid" ? "invalid_grant" : "temporarily_unavailable" }, { status: outcome === "invalid" ? 401 : 500 });
    }
    return Response.json({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 } });
  };
  try {
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ engine: "claude", accountId: pin.id, cwd, title: "Rejected refresh fixture", prompt: "Review", clientAttemptId: `rejected-refresh-${outcome}` }),
    }), { registry: () => registry, runtimeHostClient: () => ({} as never), storeImages: () => [], spawnStructuredConversation: async () => { throw new Error("deferred launch must not run"); }, engineReadiness: () => "connected", assertStructuredRuntime: () => {}, defer: () => {}, resolveHealthySpawnAccount, resolveSpawnAccount: (engine, id) => accountManager.resolveSpawn(engine, id) });
    expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 503, body: { code: "account_admission_changed", retrySafe: true, retryable: true } });
    expect(Object.keys(registry.readOnlySnapshot().receipts)).toHaveLength(0);
  } finally {
    providerReply = null;
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT; else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    clearAccountTestState(process.env.LLV_STATE_DIR!);
  }
});
