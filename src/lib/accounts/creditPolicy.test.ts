import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { createManagedCodexAccount, setCodexAccountSpendCredits } from "./codex";
import { selectProjectAccount } from "./projectSelection";
import { accountCreditGuardBlock } from "./creditPolicy";
import { proactiveAccountReserveError } from "./proactiveReserve";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { enforceAccountCreditGuard } from "@/lib/runtime/accountCreditGuard";
import { bindStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliverySignal";
import { conversationProjectKey } from "./conversationProject";
import { applySeatTickSettingsChange, defaultSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { turboCreditExemptFor } from "./turboCreditExemption";
import type { DurableQuotaObservation } from "./migration/contracts";

const now = Date.parse("2026-11-03T12:00:00Z");
const roots: string[] = [];
const oldState = process.env.LLV_STATE_DIR;
afterEach(() => {
  closeAgentRegistryForTests();
  if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "credit-policy-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const a = createManagedCodexAccount("Credit fixture A", { id: "account-a" });
  const b = createManagedCodexAccount("Credit fixture B", { id: "account-b" });
  const observation = (id: string, used: number, hasCredits = true): DurableQuotaObservation => ({
    engine: "codex", accountId: id, authenticated: true, observedAt: new Date(now).toISOString(), authCheckedAt: new Date(now).toISOString(), bootId: "credit-fixture",
    provenance: { source: "live", reason: null, staleSince: null },
    limits: { session: { usedPercent: used, resetsAt: now / 1000 + 3600 }, weekly: { usedPercent: used, resetsAt: now / 1000 + 3600 },
      plan: "pro", capturedAt: now / 1000, credits: { hasCredits, balance: hasCredits ? "12" : "0", unlimited: false } },
  });
  return { a, b, observation };
}

function approveTurbo(project: string, accountIds: string[]) {
  const applied = applySeatTickSettingsChange(defaultSeatTickSettings(project), { turbo: {
    enabled: true, hours: 1, credits: true, creditAccounts: accountIds,
  } }, {
    at: new Date(now).toISOString(),
    actor: { kind: "gateway", project: null, conversationId: null, seatEpoch: null },
    turbo: { allowedAccounts: accountIds, plan: accountIds.map(accountId => ({ accountId, label: accountId,
      plan: "pro", tiers: { "gpt-5.6-sol": "priority" }, hadCredits: true })) },
  });
  if (!applied.ok) throw new Error(applied.error);
  writeSeatTickSettings(project, applied.settings);
}

test("Turbo approval cannot bypass the account opt-in in project selection", () => {
  const { a, b, observation } = fixture();
  const project = "credit-policy-turbo-selection";
  approveTurbo(project, [a.id, b.id]);
  const input = { project, engine: "codex" as const, accounts: [a, b].map(account => ({ ...account, authPresent: true })),
    observations: [observation(a.id, 100), observation(b.id, 100)], bindings: [], now, requireCapacity: true };
  expect(turboCreditExemptFor(project, b.id, now)).toBe(false);
  expect(selectProjectAccount(input).kind).toBe("exhausted");
  setCodexAccountSpendCredits(a.id, true);
  expect(selectProjectAccount(input)).toEqual({ kind: "available", accountId: a.id });
  expect(selectProjectAccount({ ...input, requestedId: b.id, requestedChoice: "explicit" }).kind).toBe("exhausted");
});

test.each([99, 100])("selection and reserve use only the opted-in account at %s percent, until credits end", used => {
  const { a, b, observation } = fixture();
  const input = { project: null, engine: "codex" as const, accounts: [a, b].map(account => ({ ...account, authPresent: true })),
    observations: [observation(a.id, used), observation(b.id, used)], bindings: [], now, requireCapacity: true };
  expect(selectProjectAccount(input).kind).toBe("exhausted");
  setCodexAccountSpendCredits(a.id, true);
  expect(selectProjectAccount(input)).toEqual({ kind: "available", accountId: a.id });
  expect(selectProjectAccount({ ...input, requestedId: b.id, requestedChoice: "explicit" }).kind).toBe("exhausted");
  expect(proactiveAccountReserveError(a.id, null, input.observations[0], now)).toBeNull();
  expect(proactiveAccountReserveError(b.id, null, input.observations[1], now)).not.toBeNull();
  const empty = observation(a.id, 100, false);
  expect(selectProjectAccount({ ...input, observations: [empty], requestedId: a.id }).kind).toBe("exhausted");
  setCodexAccountSpendCredits(a.id, false);
  expect(selectProjectAccount(input).kind).toBe("exhausted");
  expect(accountCreditGuardBlock("codex", a.id, input.observations[0]!.limits)).not.toBeNull();
});

test.each([99, 100])("the real runtime stop pass honors and rechecks the account opt-in at %s percent", async used => {
  const { a, b, observation } = fixture();
  const f = migrationDeliveryFixture();
  const project = conversationProjectKey(f.registry.conversation(f.conversation.id)!.projectOwnership,
    f.registry.conversation(f.conversation.id)!.generations.at(-1)!.launchProfile);
  if (!project) throw new Error("fixture conversation has no project key");
  approveTurbo(project, [a.id, b.id]);
  f.registry.recordQuotaObservation(observation(a.id, used));
  f.registry.recordQuotaObservation(observation(b.id, used));
  const health = f.host.health.bind(f.host);
  f.host.health = async () => ({ ...await health(), status: "active", activeTurnRef: "paid-turn" });
  let stops = 0;
  const run = () => enforceAccountCreditGuard(f.registry, [{ key: f.key, host: f.host }], async () => { stops++; return false; }, async () => false, async () => null);
  try {
    setCodexAccountSpendCredits(a.id, true);
    await run();
    expect(stops).toBe(0);
    setCodexAccountSpendCredits(a.id, false);
    await expect(run()).rejects.toThrow("termination remains pending");
    expect(stops).toBe(1);
    f.host.health = async () => {
      setCodexAccountSpendCredits(a.id, true);
      return { ...await health(), status: "active", activeTurnRef: "paid-turn" };
    };
    await run();
    expect(stops).toBe(1);
  } finally { await f.cleanup(); }
});

test("native runtime dispatch rechecks paid spending for each send", async () => {
  const { a, observation } = fixture();
  const f = migrationDeliveryFixture();
  const conversation = f.registry.conversation(f.conversation.id)!;
  const project = conversationProjectKey(conversation.projectOwnership, conversation.generations.at(-1)!.launchProfile);
  if (!project) throw new Error("fixture conversation has no project key");
  approveTurbo(project, [a.id]);
  f.registry.recordQuotaObservation(observation(a.id, 100));
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client });
    const send = async (operationId: string) => {
      f.journal.executeOperation({ kind: "send", operationId, idempotencyKey: operationId,
        conversationId: f.conversation.id, text: "Continue the fixture", policy: "queue" });
      await kickStructuredDeliveryQueue();
      return f.journal.operationResult(operationId);
    };
    await send("paid-off");
    expect(f.host.ledger.writes).toHaveLength(0);
    setCodexAccountSpendCredits(a.id, true);
    await send("paid-on");
    expect(f.host.ledger.writes).toHaveLength(1);
    setCodexAccountSpendCredits(a.id, false);
    await send("paid-revoked");
    expect(f.host.ledger.writes).toHaveLength(1);
  } finally { await f.cleanup(); }
});
