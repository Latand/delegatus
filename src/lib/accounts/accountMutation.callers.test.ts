import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-sync-callers-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Each row reaches a distinct synchronous call site through its public API.
// Process isolation also keeps catalog constants and store caches private.
const registrySetup = `
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const registry = new AgentRegistry(path.join(state, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
`;
const seatSetup = `
  const seats = await import("@/lib/orchestrator/seats");
  const intent = { project: "proj-fixture", mandate: "Run the board", clientRequestId: "caller-fixture-intent", mode: "spawn" };
  const completion = { project: intent.project, clientRequestId: intent.clientRequestId, conversationId: "conversation_fixture", path: null, launchId: "fixture-launch" };
`;
const activeSeatSetup = `${seatSetup}
  seats.beginOrchestratorSeatIntent(intent);
  seats.completeOrchestratorSeatIntent(completion);
`;

const cases: Array<{ name: string; setup: string; run: string; check: string }> = [
  { name: "registry.beginSpawnRequest", setup: registrySetup,
    run: `const result = registry.beginSpawnRequest({ engine: "codex", cwd: state, transport: "structured", accountId: null, clientAttemptId: "fixture-spawn-attempt", launchProfile: { title: "Caller fixture" } });`,
    check: `assert.equal(result.kind, "created"); assert.equal(Object.keys(registry.readOnlySnapshot().receipts).length, 1);` },
  { name: "registry.runIdentityWaveMigration", setup: registrySetup,
    run: `const result = registry.runIdentityWaveMigration({ now: new Date().toISOString(), transcriptTitle: () => null, sharedPathForLegacy: () => null, orchestratorSeats: [], commitExternalPathRekeys: () => {} });`,
    check: `assert.equal(result.alreadyCompleted, false);` },
  { name: "registry.setEngineRouting", setup: registrySetup,
    run: `registry.setEngineRouting("codex", "account-b");`,
    check: `assert.equal(registry.engineRouting("codex").activeAccountId, "account-b");` },
  { name: "registry.retireAccount", setup: `${registrySetup} registry.setEngineRouting("codex", "account-a");`,
    run: `registry.retireAccount("codex", "account-a", "default");`,
    check: `assert.equal(registry.engineRouting("codex").activeAccountId, "default");` },
  { name: "registry.rewriteAccountPaths", setup: `${registrySetup}
      const begun = registry.beginSpawnRequest({ engine: "codex", cwd: state, transport: "structured", accountId: null, launchProfile: { title: "Path fixture" } });
      registry.reconcileConversations([{ engine: "codex", path: path.join(state, "old", "session.jsonl"), conversationId: begun.receipt.conversationId, accountId: "account-a", launchProfile: { title: "Path fixture" }, observedAt: new Date().toISOString() }]);`,
    run: `const result = registry.rewriteAccountPaths("codex", [{ from: path.join(state, "old"), to: path.join(state, "new") }]);`,
    check: `assert.equal(result, 1);` },
  { name: "registry.commitMigrationIntent", setup: registrySetup,
    run: `const result = registry.commitMigrationIntent({ engine: "codex", targetId: "account-b", origin: "manual", requestId: "fixture-migration", expectedRevision: 0 });`,
    check: `assert.equal(result.targetId, "account-b");` },
  { name: "registry.restoreSnapshot", setup: `${registrySetup} const replacement = registry.readOnlySnapshot(); registry.setEngineRouting("codex", "account-b"); const current = registry.readOnlySnapshot();`,
    run: `registry.restoreSnapshot(current, replacement);`,
    check: `assert.equal(registry.engineRouting("codex").activeAccountId, null);` },
  { name: "recordSpawnAdmissionRejection", setup: `const admission = await import("@/lib/agent/spawnAdmission");`,
    run: `const result = admission.recordSpawnAdmissionRejection({ clientAttemptId: "fixture-refusal-key", requestDigest: "a".repeat(64), status: 403, error: "Launch permission refused" }, () => null);`,
    check: `assert.equal(result.kind, "fenced"); assert.equal(admission.readSpawnAdmissionFence("fixture-refusal-key").status, 403);` },
  { name: "runIdentityWaveMigrationAtStartup", setup: `${registrySetup} const { runIdentityWaveMigrationAtStartup } = await import("@/lib/agent/identityWaveStartup");`,
    run: `const result = runIdentityWaveMigrationAtStartup({ registry, seats: () => [], transcriptTitle: () => null, sharedPath: () => null, commitExternalPathRekeys: () => {}, log: () => {}, env: {} });`,
    check: `assert.equal(result.alreadyCompleted, false);` },
  { name: "Codex.withRegistryLock", setup: `const accounts = await import("./codex"); accounts.listCodexAccounts();`,
    run: `const result = accounts.createManagedCodexAccount("Account B");`,
    check: `assert.equal(accounts.listCodexAccounts().some(a => a.id === result.id), true);` },
  { name: "setActiveCodexAccount", setup: `const accounts = await import("./codex"); const account = accounts.createManagedCodexAccount("Account B");`,
    run: `accounts.setActiveCodexAccount(account.id);`,
    check: `assert.equal(accounts.activeCodexAccountId(), account.id);` },
  { name: "Claude.withRegistryLock", setup: `const accounts = await import("./claude"); accounts.listClaudeAccounts();`,
    run: `const result = accounts.createManagedClaudeAccount("Account B");`,
    check: `assert.equal(accounts.listClaudeAccounts().some(a => a.id === result.id), true);` },
  { name: "setActiveClaudeAccount", setup: `const accounts = await import("./claude"); const account = accounts.createManagedClaudeAccount("Account B");`,
    run: `accounts.setActiveClaudeAccount(account.id);`,
    check: `assert.equal(accounts.activeClaudeAccountId(), account.id);` },
  { name: "createManagedCopilotAccount", setup: `const accounts = await import("./copilot"); accounts.listCopilotAccounts();`,
    run: `const result = accounts.createManagedCopilotAccount("Account B");`,
    check: `assert.equal(accounts.listCopilotAccounts().some(a => a.id === result.id), true);` },
  { name: "setActiveCopilotAccount", setup: `const accounts = await import("./copilot"); const account = accounts.createManagedCopilotAccount("Account B");`,
    run: `accounts.setActiveCopilotAccount(account.id);`,
    check: `assert.equal(accounts.activeCopilotAccountId(), account.id);` },
  { name: "projectBindings.inRecordTransaction", setup: `const bindings = await import("./projectBindings"); bindings.accountProjectBindings();`,
    run: `const result = bindings.bindAccountToProject("codex", "account-b", "proj-fixture");`,
    check: `assert.equal(result.ok, true); assert.deepEqual(bindings.allowedAccountIdsForProject("proj-fixture", "codex"), ["account-b"]);` },
  { name: "syncCompatibilityRouting", setup: `${registrySetup}
      const accounts = await import("./codex"); const account = accounts.createManagedCodexAccount("Account B");
      registry.setEngineRouting("codex", account.id);
      const { syncCompatibilityRouting } = await import("./migration/controller");`,
    run: `syncCompatibilityRouting(registry);`,
    check: `assert.equal(accounts.activeCodexAccountId(), account.id);` },
  { name: "beginOrchestratorSeatIntent", setup: seatSetup,
    run: `const result = seats.beginOrchestratorSeatIntent(intent);`,
    check: `assert.equal(result.kind, "begun"); assert.equal(seats.orchestratorSeatFor(intent.project).pending.intent.clientRequestId, intent.clientRequestId);` },
  { name: "completeOrchestratorSeatIntent", setup: `${seatSetup} seats.beginOrchestratorSeatIntent(intent);`,
    run: `const result = seats.completeOrchestratorSeatIntent(completion);`,
    check: `assert.equal(result.kind, "activated"); assert.equal(seats.orchestratorSeatFor(intent.project).active.conversationId, completion.conversationId);` },
  { name: "repairOrchestratorSeatRuntimeIdentity", setup: activeSeatSetup,
    run: `const result = seats.repairOrchestratorSeatRuntimeIdentity({ project: intent.project, conversationId: completion.conversationId, engine: "codex", model: "fixture-model" });`,
    check: `assert.equal(result.model, "fixture-model");` },
  { name: "failOrchestratorSeatIntent", setup: `${seatSetup} seats.beginOrchestratorSeatIntent(intent);`,
    run: `const result = seats.failOrchestratorSeatIntent(intent.project, intent.clientRequestId, "Launch refused");`,
    check: `assert.equal(result.seat.intent.error, "Launch refused"); assert.equal(seats.orchestratorSeatFor(intent.project).pending, null);` },
  { name: "abandonStillbornOrchestratorSeat", setup: activeSeatSetup,
    run: `const result = seats.abandonStillbornOrchestratorSeat({ project: intent.project, clientRequestId: intent.clientRequestId, error: "Launch expired", resolvable: () => false });`,
    check: `assert.equal(result.terminalized.seat.intent.error, "Launch expired"); assert.equal(seats.orchestratorSeatFor(intent.project).active, null);` },
  { name: "confirmOrchestratorSeatMaterialization", setup: activeSeatSetup,
    run: `const result = seats.confirmOrchestratorSeatMaterialization({ ...completion, path: path.join(state, "session.jsonl") });`,
    check: `assert.equal(result.path, path.join(state, "session.jsonl"));` },
  { name: "rekeyOrchestratorSeatPaths", setup: `${activeSeatSetup} seats.confirmOrchestratorSeatMaterialization({ ...completion, path: path.join(state, "old.jsonl") });`,
    run: `seats.rekeyOrchestratorSeatPaths([{ legacyPath: path.join(state, "old.jsonl"), sharedPath: path.join(state, "new.jsonl") }]);`,
    check: `assert.equal(seats.orchestratorSeatFor(intent.project).active.path, path.join(state, "new.jsonl"));` },
  { name: "deputies.mutateDeputies", setup: `const deputies = await import("@/lib/orchestrator/deputies");`,
    run: `const result = deputies.beginDeputy({ project: "proj-fixture", seatConversationId: "conversation_fixture", seatEpoch: 1, seatPath: path.join(state, "session.jsonl"), clientRequestId: "fixture-deputy", ask: { text: "Review the change", images: 0, sender: null } });`,
    check: `assert.equal(result.kind, "begun"); assert.equal(deputies.readDeputies().length, 1);` },
  { name: "reportReplies.withdraw", setup: `
      const { productionReportReplyPorts } = await import("@/lib/telegram/bot/reportReplies");
      const { agentRegistry } = await import("@/lib/agent/registry");
      const registry = agentRegistry();
      const begun = registry.beginSpawnRequest({ engine: "codex", cwd: state, transport: "structured", accountId: null, launchProfile: { title: "Reply fixture" } });
      const delivery = registry.holdDelivery(begun.receipt.conversationId, "Operator reply", "fixture-reply");
      const snapshot = registry.readOnlySnapshot(); const held = structuredClone(snapshot);
      Object.assign(held.heldDeliveries[delivery.id], { state: "held", generationId: null, assignedAt: null });
      registry.restoreSnapshot(snapshot, held);
      assert.equal(registry.readOnlySnapshot().heldDeliveries[delivery.id].state, "held");`,
    run: `const result = await productionReportReplyPorts.withdraw(delivery.command.operationId, delivery.id);`,
    check: `assert.equal(result, "withdrawn"); assert.equal(registry.readOnlySnapshot().heldDeliveries[delivery.id].state, "failed");` },
];

for (const [index, fixture] of cases.entries()) {
  test(`${fixture.name} waits out a short foreign holder`, async () => {
    const state = path.join(root, String(index), "state");
    const home = path.join(root, String(index), "home");
    const tmp = path.join(root, String(index), "tmp");
    for (const dir of [state, home, tmp]) fs.mkdirSync(dir, { recursive: true });
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        const fs = await import("node:fs"); const path = await import("node:path");
        const assert = (await import("node:assert/strict")).default;
        const state = process.env.LLV_STATE_DIR;
        const { foreignAccountHolder } = await import("./accountMutation.fixture");
        ${fixture.setup}
        const holder = await foreignAccountHolder();
        try { holder.releaseAfter(8); ${fixture.run} ${fixture.check} }
        finally { await holder.close(); }
      `],
      cwd: import.meta.dir,
      env: { ...process.env, LLV_STATE_DIR: state, HOME: home, TMPDIR: tmp, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_SOCKET: path.join(tmp, "closed.sock") },
      stdout: "ignore", stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([child.exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 10_000); })]);
    clearTimeout(timer);
    if (!finished) child.kill();
    const code = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect({ finished, code, stderr }).toEqual({ finished: true, code: 0, stderr: "" });
  }, 15_000);
}
