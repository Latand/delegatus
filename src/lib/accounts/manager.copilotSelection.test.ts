import { afterAll, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-manager-selection-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");

const { copilotSignedInUser, createManagedCopilotAccount, listCopilotAccounts, setActiveCopilotAccount } = await import("./copilot");
const { accountManager, resolveContinuityAccount, resolveHealthySpawnAccount } = await import("./manager");
const { agentRegistry } = await import("@/lib/agent/registry");

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true });
});

function signIn(home: string): void {
  fs.writeFileSync(path.join(home, "config.json"), `// Copilot config\n${JSON.stringify({
    lastLoggedInUser: { host: "github.com", login: "placeholder" },
    loggedInUsers: [{ host: "github.com", login: "placeholder" }],
  })}`);
}

test("Copilot config login parsing requires the last user to remain in loggedInUsers", () => {
  const home = path.join(root, "config-fixture");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), `// Copilot config\n${JSON.stringify({
    lastLoggedInUser: { host: "github.com", login: "placeholder" },
    loggedInUsers: [{ host: "github.com", login: "placeholder" }],
  })}`);
  expect(copilotSignedInUser(home)).toBe("placeholder");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    lastLoggedInUser: { host: "github.com", login: "placeholder" },
    loggedInUsers: [],
  }));
  expect(copilotSignedInUser(home)).toBeNull();
  fs.writeFileSync(path.join(home, "config.json"), "malformed");
  expect(copilotSignedInUser(home)).toBeNull();
  expect(copilotSignedInUser(path.join(root, "missing"))).toBeNull();
});

test("Copilot chooses its active authenticated account before quota observations exist", () => {
  const first = createManagedCopilotAccount("first");
  const second = createManagedCopilotAccount("second");
  signIn(first.home);
  signIn(second.home);
  setActiveCopilotAccount(first.id);
  expect(accountManager.resolveHeadlessSpawn("copilot", null, [], null).kind).toBe("available");
  expect(accountManager.resolveHeadlessSpawn("copilot", null, [], null)).toMatchObject({ account: { accountId: first.id } });
});

test("Copilot skips a fresh exhausted account and picks the account with headroom", async () => {
  const accounts = agentRegistry();
  const [first, second] = listCopilotAccounts().filter((account) => account.kind === "managed");
  const now = Date.now();
  const observation = (accountId: string, usedPercent: number) => ({
    engine: "copilot" as const,
    accountId,
    authenticated: true,
    authCheckedAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    bootId: "quota-selection",
    limits: { session: null, weekly: { usedPercent, resetsAt: Math.floor(now / 1000) + 86_400, windowMinutes: 43_200 }, tiers: [], plan: null, capturedAt: Math.floor(now / 1000) },
    provenance: { source: "transcript" as const, reason: null, staleSince: null },
  });
  accounts.recordQuotaObservation(observation(first!.id, 100));
  accounts.recordQuotaObservation(observation(second!.id, 10));
  setActiveCopilotAccount(first!.id);
  expect(accountManager.resolveHeadlessSpawn("copilot", null, [], null)).toMatchObject({ account: { accountId: second!.id } });
  expect(accountManager.resolveProjectSpawn("copilot", { project: "unbound" })).toMatchObject({ kind: "available", account: { accountId: second!.id } });
  expect(await resolveHealthySpawnAccount("copilot", null, null)).toMatchObject({ accountId: second!.id });
  expect(resolveContinuityAccount("copilot", null, null)).toMatchObject({ accountId: second!.id });
});

test("Copilot capacity flows from transcript probe through the registry into headless selection", async () => {
  const exhausted = createManagedCopilotAccount("z-exhausted");
  const capacity = createManagedCopilotAccount("a-capacity");
  signIn(exhausted.home);
  signIn(capacity.home);
  const now = Date.now();
  const resetDate = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 2, 1)).toISOString();
  const writeQuotaEvent = (home: string, sessionId: string, observedAt: number, remainingPercentage: number) => {
    const sessionDir = path.join(home, "session-state", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const data = {
      responseUsage: {},
      requestMessages: "fixture body",
      quotaSnapshots: {
        chat: { entitlementRequests: 200, remainingPercentage, resetDate, isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
        premium_interactions: { entitlementRequests: 0, remainingPercentage: 0, resetDate, isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
      },
      requestId: crypto.randomUUID(),
      copilotUsage: {},
    };
    const event = { type: "model.model_call_success", data, id: crypto.randomUUID(), timestamp: new Date(observedAt).toISOString(), parentId: null };
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
  };
  const exhaustedAt = now - 10 * 60_000;
  const capacityAt = now - 30_000;
  writeQuotaEvent(exhausted.home, crypto.randomUUID(), exhaustedAt, 0);
  writeQuotaEvent(capacity.home, crypto.randomUUID(), capacityAt, 90);
  setActiveCopilotAccount(exhausted.id);

  const { QuotaController, liveQuotaProbe } = await import("./migration/quotaController");
  const registry = agentRegistry();
  const controller = new QuotaController(registry, {
    list: (engine) => engine === "copilot" ? [exhausted, capacity] : [],
    active: () => exhausted.id,
    credentialIdentity: (engine, account) => liveQuotaProbe.credentialIdentity?.(engine, account) ?? null,
    probe: (engine, account, capturedAt, options) => liveQuotaProbe.probe(engine, account, capturedAt, options),
  }, crypto.randomUUID(), () => now);

  await controller.tick("copilot");
  const observations = registry.readOnlySnapshot().quotaObservations.copilot;
  expect(observations[exhausted.id]?.observedAt).toBe(new Date(exhaustedAt).toISOString());
  expect(observations[capacity.id]?.observedAt).toBe(new Date(capacityAt).toISOString());
  expect(observations[exhausted.id]?.limits?.weekly?.usedPercent).toBe(100);
  expect(observations[capacity.id]?.limits?.weekly?.usedPercent).toBe(10);
  expect(accountManager.resolveHeadlessSpawn("copilot", null, [], null)).toMatchObject({ account: { accountId: capacity.id } });
});
