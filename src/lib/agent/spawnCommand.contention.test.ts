import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { Database } from "bun:sqlite";
import { drainFile, writeDrain, releaseDrain } from "@/lib/selfUpdate/drain";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { SpawnCommandDependencies } from "./spawnCommand";
import type { SpawnReceipt } from "./registry";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-contention-"));
const savedEnv = { ...process.env };
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { statePath } = await import("@/lib/configDir");
const { agentRegistry } = await import("./registry");
const { executeSpawnRequest } = await import("./spawnCommand");
const { measureContention } = await import("@/lib/accounts/accountMutation.contention.fixture");
beforeEach(() => {
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("fixture.sock");
});
function structuredRouteDependencies(cwd: string): SpawnCommandDependencies {
  return {
    registry: agentRegistry,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => ({
      engine: "claude",
      accountId: "claude-test",
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "projects"),
      env: { NODE_ENV: "test" },
    }),
    resolveSpawnAccount: (_engine, accountId) => ({
      engine: "claude",
      accountId: accountId ?? "claude-test",
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "projects"),
      env: { NODE_ENV: "test" },
    }),
    resolvePinnedSpawnAdmission: async () => ({
      kind: "admissible",
      basis: "current",
      stale: false,
      retryAt: null,
    }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: (work) => { void work(); },
    storeImages: (images) => images.map((image) => ({
      sha256: crypto.createHash("sha256").update(Buffer.from(image.base64, "base64")).digest("hex"),
      mime: image.mime as "image/png",
      bytes: Buffer.from(image.base64, "base64").byteLength,
    })),
    spawnStructuredConversation: async (input) => ({
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    }),
  };
}

test.each(["released", "refused", "revoked"] as const)("a reserved maintenance launch retries task membership before dispatch: %s", async outcome => {
  const { productionLaunchMembershipPorts } = await import("@/lib/tasks/launchMembership");
  const { TASKS_FILE, loadTasks } = await import("@/lib/tasks/store");
  const { legacyDatabasePath } = await import("@/lib/state/legacyImport");
  const { AccountAdmissionChangedError } = await import("@/lib/accounts/accountMutation");
  const cwd = statePath(`maintenance-membership-${outcome}`);
  fs.mkdirSync(cwd, { recursive: true });
  const attempt = `maintenance_membership_${outcome}`;
  const registry = agentRegistry();
  const dependencies = structuredRouteDependencies(cwd);
  const deferred: Array<() => Promise<void>> = [];
  dependencies.defer = work => { deferred.push(work); };
  const commit = productionLaunchMembershipPorts.commit;
  loadTasks();
  const peer = new Database(legacyDatabasePath(TASKS_FILE));
  let locked = false;
  let release: ReturnType<typeof setImmediate> | undefined;
  let calls = 0;
  dependencies.assertAccountAdmission = () => {
    if (calls > 0 && outcome === "revoked") throw new AccountAdmissionChangedError();
  };
  let reservedId: string | undefined;
  const membership = spyOn(productionLaunchMembershipPorts, "commit").mockImplementation(input => {
    calls++;
    const receipt = registry.spawnReceiptForClientAttempt(attempt)!;
    expect(receipt).toBeDefined();
    reservedId ??= receipt.launchId;
    expect(receipt.launchId).toBe(reservedId);
    expect(receipt.membershipAdmitted).toBe(false);
    expect(deferred).toHaveLength(0);
    if (calls === 1) {
      // The receipt has committed. A second writer wins the task database
      // before its membership prerequisite can take the task-store writer.
      peer.exec("BEGIN IMMEDIATE");
      locked = true;
      release = setImmediate(() => { if (locked) { peer.exec("ROLLBACK"); locked = false; } });
      return commit(input);
    }
    if (outcome === "refused") return { ok: false, error: "fixture task membership refused", status: 409 };
    return commit(input);
  });
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: attempt, title: "Board maintenance fixture", engine: "claude", cwd, prompt: "Inspect the fixture board", mcpServers: [] }),
    });
  try {
    const response = await executeSpawnRequest(request(), dependencies);
    expect(response.status).toBe(outcome === "released" ? 202 : outcome === "refused" ? 409 : 503);
    expect(calls).toBe(outcome === "revoked" ? 1 : 2);
    const receipt = registry.spawnReceiptForClientAttempt(attempt)!;
    expect(receipt.launchId).toBe(reservedId!);
    expect(receipt.membershipAdmitted).toBe(outcome === "released");
    expect(deferred).toHaveLength(outcome === "released" ? 1 : 0);
    if (outcome === "refused") expect(receipt).toMatchObject({ state: "failed", error: "fixture task membership refused" });
    if (outcome === "revoked") expect(receipt.admissionOwner).toBeNull();
    membership.mockRestore();
    if (outcome === "released" || outcome === "revoked") {
      dependencies.assertAccountAdmission = () => {};
      expect((await executeSpawnRequest(request(), dependencies)).status).toBe(202);
      expect(registry.spawnReceiptForClientAttempt(attempt)!.launchId).toBe(reservedId!);
      expect(deferred).toHaveLength(1);
    }
  } finally {
    membership.mockRestore();
    if (release) clearImmediate(release);
    if (locked) { peer.exec("ROLLBACK"); locked = false; }
    peer.close();
  }
});

for (const guard of ["account", "authority"] as const) test.each(["reservation", "membership", "recorded"] as const)(`a ${guard} guard refusal after %s releases fresh dispatch custody for same-key replay`, async seam => {
  const { productionLaunchMembershipPorts } = await import("@/lib/tasks/launchMembership");
  const { AccountAdmissionChangedError } = await import("@/lib/accounts/accountMutation");
  const cwd = statePath(`guard-custody-${guard}-${seam}`);
  fs.mkdirSync(cwd, { recursive: true });
  const attempt = `guard_custody_${guard}_${seam}`;
  const registry = agentRegistry();
  const dependencies = structuredRouteDependencies(cwd);
  const deferred: Array<() => Promise<void>> = [];
  dependencies.defer = work => { deferred.push(work); };
  let membershipCommitted = false;
  let refuse = true;
  const commit = productionLaunchMembershipPorts.commit;
  const membership = spyOn(productionLaunchMembershipPorts, "commit").mockImplementation(input => {
    const admitted = commit(input);
    if (admitted.ok) membershipCommitted = true;
    return admitted;
  });
  const write = registry.accountMutationWrite.bind(registry);
  const record = spyOn(registry, "accountMutationWrite").mockImplementation(async (...args) => {
    const result = await write(...args);
    if (refuse && seam === "recorded" && args[0] === "spawn membership record" && result.acquired) {
      throw new AccountAdmissionChangedError();
    }
    return result;
  });
  const assertAdmission = () => {
    const receipt = registry.spawnReceiptForClientAttempt(attempt);
    if (refuse && receipt && (seam === "reservation" || (seam === "membership" && membershipCommitted))) {
      throw new AccountAdmissionChangedError();
    }
  };
  if (guard === "account") dependencies.assertAccountAdmission = assertAdmission;
  else dependencies.authorizeAutonomousLaunch = assertAdmission;
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: attempt, title: "Guard custody fixture", engine: "claude", cwd, prompt: "Inspect fixture custody", mcpServers: [] }),
  });
  try {
    const response = await executeSpawnRequest(request(), dependencies);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "account_admission_changed", retryable: true, retrySafe: true });
    const receipt = registry.spawnReceiptForClientAttempt(attempt)!;
    expect(receipt.state).toBe("starting");
    expect(receipt.membershipAdmitted).toBe(seam === "recorded");
    expect(receipt.admissionOwner).toBeNull();
    expect(deferred).toHaveLength(0);
    if (guard === "authority" && seam !== "recorded") {
      expect((await executeSpawnRequest(request(), dependencies)).status).toBe(503);
      expect(registry.spawnReceiptForClientAttempt(attempt)!.admissionOwner).toBeNull();
      expect(deferred).toHaveLength(0);
    }
    refuse = false;
    expect((await executeSpawnRequest(request(), dependencies)).status).toBe(202);
    expect(registry.spawnReceiptForClientAttempt(attempt)!.launchId).toBe(receipt.launchId);
    expect(registry.spawnReceiptForClientAttempt(attempt)!.membershipAdmitted).toBe(true);
    expect(deferred).toHaveLength(1);
    expect((await executeSpawnRequest(request(), dependencies)).status).toBe(202);
    expect(deferred).toHaveLength(1);
  } finally {
    membership.mockRestore();
    record.mockRestore();
  }
});

test("exhausted spawn reservation admission preserves the retryable response and same-key retry", async () => {
  const { executeOrchestratorSeatRequest } = await import("@/lib/orchestrator/seatCommand");
  const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
  const cwd = statePath("exhausted-reservation");
  fs.mkdirSync(cwd, { recursive: true });
  const attempt = "exhausted_reservation";
  const registry = agentRegistry();
  const dependencies = structuredRouteDependencies(cwd);
  const deferred: Array<() => Promise<void>> = [];
  dependencies.defer = work => { deferred.push(work); };
  const write = registry.accountMutationWrite.bind(registry);
  const busy = spyOn(registry, "accountMutationWrite").mockImplementation(async (...args) =>
    args[0] === "spawn admission" ? { acquired: false } : write(...args));
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: attempt, title: "Reservation contention fixture", engine: "claude", cwd, prompt: "Inspect fixture admission", mcpServers: [] }),
  });
  try {
    const response = await executeSpawnRequest(request(), dependencies);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "account_store_busy", retryable: true, retrySafe: true });
    expect(registry.spawnReceiptForClientAttempt(attempt)).toBeNull();
    expect(deferred).toHaveLength(0);
    const keys: unknown[] = [];
    const project = "reservation-admission-fixture";
    const seat = await executeOrchestratorSeatRequest({ project, mandate: "Inspect the fixture board", cwd,
      clientRequestId: attempt, engine: "claude", model: "opus" }, {
      resolveProject: project => ({ project, displayName: project }),
      spawn: async body => {
        keys.push(body.clientAttemptId);
        expect(orchestratorSeatFor(project).pending).not.toBeNull();
        expect(orchestratorSeatFor(project).history).toEqual([]);
        const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
          method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
          body: JSON.stringify(body),
        }), dependencies);
        if (keys.length === 1) {
          expect(response.status).toBe(503);
          expect(registry.spawnReceiptForClientAttempt(attempt)).toBeNull();
          expect(deferred).toHaveLength(0);
          busy.mockRestore();
        }
        return { status: response.status, body: await response.json() };
      },
      deliver: async () => ({ ok: true, outcome: "delivered" }), conversationTarget: () => null,
      summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
      launchSettlement: () => ({ kind: "unknown" }), stampRegistryIdentity: () => {},
      runtimeIdentity: () => ({ engine: "claude", model: "opus" }), resolvedConversation: () => null,
      now: () => "2026-10-23T00:00:00.000Z",
    });
    expect(seat.status).toBe(202);
    expect(keys).toEqual([attempt, attempt]);
    expect(orchestratorSeatFor(project)).toMatchObject({ pending: null, history: [] });
    expect(registry.spawnReceiptForClientAttempt(attempt)).not.toBeNull();
    expect(deferred).toHaveLength(1);
  } finally { busy.mockRestore(); }
});

test("exhausted task membership preserves retryable admission and the seat retries the same reservation", async () => {
  const { executeOrchestratorSeatRequest } = await import("@/lib/orchestrator/seatCommand");
  const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
  const { productionLaunchMembershipPorts } = await import("@/lib/tasks/launchMembership");
  const { TASKS_FILE, loadTasks } = await import("@/lib/tasks/store");
  const { legacyDatabasePath } = await import("@/lib/state/legacyImport");
  const cwd = statePath("exhausted-membership");
  fs.mkdirSync(cwd, { recursive: true });
  const attempt = "exhausted_membership";
  const project = "membership-admission-fixture";
  const registry = agentRegistry();
  const dependencies = structuredRouteDependencies(cwd);
  const deferred: Array<() => Promise<void>> = [];
  dependencies.defer = work => { deferred.push(work); };
  loadTasks();
  const peer = new Database(legacyDatabasePath(TASKS_FILE));
  const commit = productionLaunchMembershipPorts.commit;
  let locked = false;
  const membership = spyOn(productionLaunchMembershipPorts, "commit").mockImplementation(input => {
    if (!locked) {
      // Hold a real second writer from after reservation until the request
      // returns, forcing the production membership wait to exhaust.
      expect(registry.spawnReceiptForClientAttempt(attempt)).not.toBeNull();
      peer.exec("BEGIN IMMEDIATE");
      locked = true;
    }
    return commit(input);
  });
  const keys: unknown[] = [];
  let reservedId: string | undefined;
  try {
    const result = await executeOrchestratorSeatRequest({ project, mandate: "Inspect the fixture board", cwd,
      clientRequestId: attempt, engine: "claude", model: "opus" }, {
      resolveProject: project => ({ project, displayName: project }),
      spawn: async body => {
        keys.push(body.clientAttemptId);
        expect(orchestratorSeatFor(project).pending?.intent).toMatchObject({ clientRequestId: attempt, error: null });
        expect(orchestratorSeatFor(project).history).toEqual([]);
        const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
          method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
          body: JSON.stringify(body),
        }), dependencies);
        const answer = await response.json();
        const receipt = registry.spawnReceiptForClientAttempt(attempt)!;
        if (keys.length === 1) {
          expect(locked).toBe(true);
          reservedId = receipt.launchId;
          expect(receipt).toMatchObject({ state: "starting", membershipAdmitted: false, admissionOwner: null });
          expect(deferred).toHaveLength(0);
          expect(response.status).toBe(503);
          expect(answer).toMatchObject({ code: "account_store_busy", retryable: true, retrySafe: true });
          membership.mockRestore();
          peer.exec("ROLLBACK");
          locked = false;
        } else {
          expect(receipt.launchId).toBe(reservedId!);
          expect(receipt.membershipAdmitted).toBe(true);
        }
        return { status: response.status, body: answer };
      },
      deliver: async () => ({ ok: true, outcome: "delivered" }), conversationTarget: () => null,
      summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
      launchSettlement: () => ({ kind: "unknown" }), stampRegistryIdentity: () => {},
      runtimeIdentity: () => ({ engine: "claude", model: "opus" }), resolvedConversation: () => null,
      now: () => "2026-10-23T00:00:00.000Z",
    });
    expect(result.status).toBe(202);
    expect(keys).toEqual([attempt, attempt]);
    expect(orchestratorSeatFor(project)).toMatchObject({ pending: null, history: [] });
    expect(deferred).toHaveLength(1);
  } finally {
    membership.mockRestore();
    if (locked) peer.exec("ROLLBACK");
    peer.close();
  }
});

test.each(["registry", "state"] as const)("a later %s failure preserves its response after spawn admission", async kind => {
  const { RegistryWriterBusyError } = await import("./registry");
  const { FileTransactionBusyError } = await import("@/lib/state/fileTransaction");
  const cwd = statePath(`post-admission-refusal-${kind}`);
  fs.mkdirSync(cwd, { recursive: true });
  const attempt = `post_admission_refusal_${kind}`;
  const registry = agentRegistry();
  const dependencies = structuredRouteDependencies(cwd);
  const deferred: Array<() => Promise<void>> = [];
  dependencies.defer = work => { deferred.push(work); };
  dependencies.runtimeHostClient = () => {
    throw kind === "registry" ? new RegistryWriterBusyError("fixture runtime preparation")
      : new FileTransactionBusyError("state admission timed out at spawn.membership");
  };
  const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: attempt, title: "Post admission fixture", engine: "claude", cwd, prompt: "Inspect fixture runtime", mcpServers: [] }),
  }), dependencies);
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body.code).toBeUndefined();
  expect(body.retrySafe).toBeUndefined();
  expect(body.retryable).toBeUndefined();
  expect(registry.spawnReceiptForClientAttempt(attempt)?.state).toBe("failed");
  expect(deferred).toHaveLength(0);
});

test.each(["replay", "replaced-owner"] as const)("a failed admission preserves another dispatcher's custody: %s", async seam => {
  const { AgentRegistry } = await import("./registry");
  const { AccountAdmissionChangedError } = await import("@/lib/accounts/accountMutation");
  const root = statePath(`foreign-custody-${seam}`);
  fs.mkdirSync(root, { recursive: true });
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const input = { engine: "claude" as const, cwd: root, transport: "structured" as const,
    clientAttemptId: `foreign_custody_${seam}`, purpose: "resume-successor" as const,
    origin: { kind: "successor" as const }, launchProfile: { title: "Foreign custody fixture" } };
  let guards = 0;
  let owner: SpawnReceipt["admissionOwner"] = null;
  try {
    if (seam === "replay") owner = (await registry.beginSpawnRequestAsync(input)).receipt.admissionOwner;
    await expect(registry.beginSpawnRequestAsync(input, () => {
      if (++guards === 1) return;
      if (seam === "replaced-owner") {
        const snapshot = registry.snapshot();
        const receipt = Object.values(snapshot.receipts)[0]!;
        receipt.admissionOwner = { pid: 987_654, startIdentity: "foreign-custody" };
        owner = receipt.admissionOwner;
        fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
      }
      throw new AccountAdmissionChangedError();
    })).rejects.toThrow(AccountAdmissionChangedError);
    expect(registry.spawnReceiptForClientAttempt(input.clientAttemptId)!.admissionOwner).toEqual(owner);
    expect(Object.values(registry.readOnlySnapshot().receipts)).toHaveLength(1);
  } finally { registry.close(); }
});

test("a refused anonymous structured spawn preserves the real Git index and writes no handoffs", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const cwd = statePath("anonymous-private-prompt-cwd");
  const directory = path.join(cwd, ".artifacts", "pipeline-stage-inputs");
  fs.mkdirSync(directory, { recursive: true });
  const legacy = "PRIVATE_ANONYMOUS_SENTINEL\n";
  fs.writeFileSync(path.join(directory, "old.md"), legacy);
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("add", "source.ts");
  git("commit", "--quiet", "-m", "fixture base");
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only");
  const previousState = process.env.LLV_STATE_DIR;
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = path.join(sandbox, "anonymous-team-state");
  try {
    teamStore().insertMember({ id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Owner", role: "owner", status: "active", color: "teal",
      telegram: null, createdAt: new Date().toISOString(), createdBy: "claim", revokedAt: null });
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Anonymous structured launch", engine: "claude", cwd,
        ["prompt"]: "Synthetic oversized fixture\n" + "p".repeat(40_000), mcpServers: [] }),
    }), { ...structuredRouteDependencies(cwd), defer: () => {} });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("member_required");
    expect(git("diff", "--cached", "--name-only")).toBe(staged);
    expect(git("show", ":source.ts")).toBe("export const value = 2;");
    expect(fs.readdirSync(directory)).toEqual(["old.md"]);
    expect(fs.readFileSync(path.join(directory, "old.md"), "utf8")).toBe(legacy);
    expect(fs.existsSync(path.join(cwd, ".artifacts", ".gitignore"))).toBe(false);
  } finally {
    resetTeamStoreForTests();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});

test("spawn catalog resolution leaves admission available", async () => {
  const cwd = statePath("spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  await measureContention("spawn-catalog", async (pause) => {
    const dependencies = structuredRouteDependencies(cwd);
    const resolve = dependencies.resolveSpawnAccount;
    dependencies.resolveSpawnAccount = ((...args: Parameters<typeof resolve>) => {
      void pause();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return resolve(...args);
    }) as typeof resolve;
    dependencies.defer = () => {};
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Exercise catalog admission", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
    }), dependencies);
    if (response.status !== 202) console.info(await response.clone().json());
    expect(response.status).toBe(202);
  });
});

test("generic spawn cannot create a curator receipt without the pass admission callback", async () => {
  const { claimPass } = await import("@/lib/memory/curation/store");
  const { roleMemoryCollection, newRuleId, roleScope } = await import("@/lib/memory/roleStore");
  const cwd = statePath("generic-curator-spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const project = "generic-curator-fixture";
  const scope = roleScope(project, "builder");
  roleMemoryCollection(true)!.boundedPatch(20, tx => {
    const id = newRuleId(tx);
    const at = new Date().toISOString();
    tx.put({ kind: "rule", id, scope, rule: "Read the current scope before changing a stored rule.", why: "Preserve scoped guidance during review.",
      state: "active", hints: [], source: { project, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_curator_fixture" }, createdAt: at, changedAt: at });
    tx.put({ kind: "scope", scope, revision: 1, history: [], active: [id] });
  });
  const pass = claimPass({ project, repoDir: cwd, now: Date.now() });
  expect(pass).not.toBeNull();
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.resolveHealthySpawnAccount = async () => ({ engine: "codex", accountId: "codex-test", kind: "managed",
    home: path.join(cwd, "codex"), transcriptRoot: path.join(cwd, "codex", "sessions"), env: { NODE_ENV: "test" } });
  dependencies.resolveSpawnAccount = (_engine, accountId) => ({ engine: "codex", accountId: accountId ?? "codex-test", kind: "managed",
    home: path.join(cwd, "codex"), transcriptRoot: path.join(cwd, "codex", "sessions"), env: { NODE_ENV: "test" } });
  const previousCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = statePath("curator-codex-list-stub");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[{\"name\":\"viewer\"}]'\n");
  fs.chmodSync(codexBinary, 0o755);
  process.env.LLV_CODEX_BINARY = codexBinary;
  let response: Response;
  try {
    response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: pass!.id, title: "Role memory curation", engine: "codex", model: "gpt-6.1-sol", cwd, prompt: "inspect",
        role: "curator", project, mcpServers: [] }),
    }), { ...dependencies, defer: () => {} });
  } finally {
    if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousCodexBinary;
  }
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "curator_admission_refused" });
  expect(agentRegistry().spawnReceiptForClientAttempt(pass!.id)).toBeNull();
});

test("seat credential capture leaves neighboring spawn, resume and send admission available", async () => {
  const auth = await import("@/lib/accounts/seatAuthCredentials");
  const { executeOrchestratorSeatRequest, productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
  const seats = await import("@/lib/orchestrator/seats");
  const { orchestratorSeatFor } = seats;
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const { trackAccountLeases } = await import("@/lib/accounts/accountMutation.contention.fixture");
  const cwd = statePath("seat-credential-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const original = { ...productionSpawnCommandDependencies };
  Object.assign(productionSpawnCommandDependencies, structuredRouteDependencies(cwd), { defer: () => {}, engineReadiness: () => "connected" });
  const leases = trackAccountLeases();
  const observations: boolean[] = [];
  const captureMs: number[] = [];
  const commitMs: number[] = [];
  const commitHeld: boolean[] = [];
  const timeCommit = (commit: () => void) => {
    const started = performance.now();
    commitHeld.push(fs.existsSync(statePath("account-selection.lock")));
    try { commit(); }
    finally { commitMs.push(performance.now() - started); }
  };
  const prepare = seats.prepareOrchestratorSeatAuthCredentialBaseline;
  const record = seats.recordOrchestratorSeatAuthCredentialBaseline;
  // The retained direct facade also measures the reviewed code's inherited
  // callback when this same case runs against the captured commit.
  const commitSpy = typeof prepare === "function"
    ? spyOn(seats, "prepareOrchestratorSeatAuthCredentialBaseline").mockImplementation((...args) => {
      const commit = prepare(...args); return () => timeCommit(commit);
    })
    : spyOn(seats, "recordOrchestratorSeatAuthCredentialBaseline").mockImplementation((...args) => timeCommit(() => record(...args)));
  let neighbors: { exitCode: number; results: unknown; stderr: string } | undefined;
  const stamp = `1:file:${"a".repeat(64)}`;
  const capture = spyOn(auth, "seatAuthCredentialStamp").mockImplementation(() => {
    const started = performance.now();
    observations.push(fs.existsSync(statePath("account-selection.lock")));
    const child = Bun.spawnSync([process.execPath, "-e", `
      await import("./src/lib/testing/fixtureLifetime.ts");
      const { AgentRegistry } = await import("./src/lib/agent/registry");
      const { statePath } = await import("./src/lib/configDir");
      const { withAccountMutationLockAsync } = await import("./src/lib/accounts/accountMutation");
      const registry = new AgentRegistry(statePath("seat-neighbor-registry.json"), undefined, undefined, { sqliteMode: "off" });
      const conversation = registry.ensureConversation("codex", "/fixture/seat-neighbor.jsonl", "default");
      try {
        const results = await Promise.allSettled([
          registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Neighbor spawn" } }),
          registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", purpose: "resume-successor", conversationId: conversation.id, origin: { kind: "successor" }, launchProfile: { title: "Neighbor resume" } }),
          withAccountMutationLockAsync(() => registry.holdDelivery(conversation.id, "Neighbor send", "seat-neighbor-send"), { caller: "send" }),
        ]);
        console.log(JSON.stringify(results.map(result => result.status === "fulfilled" ? { status: result.status, kind: result.value.kind ?? "delivery" } : { status: result.status, error: result.reason.message })));
      } finally { registry.close(); }
    `], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    neighbors = { exitCode: child.exitCode, results: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
    captureMs.push(performance.now() - started);
    return stamp;
  });
  try {
    const result = await executeOrchestratorSeatRequest({ project: "seat-credential-contention", cwd, mandate: "Own the fixture board", engine: "claude", model: "sonnet", clientRequestId: `seat_${crypto.randomUUID()}` }, {
      ...productionSeatCommandDependencies, engineReadiness: () => "connected", startBoardReport: () => {}, stampRegistryIdentity: () => {},
    });
    expect(result.status).toBe(202);
    expect(orchestratorSeatFor("seat-credential-contention").active?.authCredentialBaseline).toMatchObject({ engine: "claude", accountId: "claude-test", stamp });
    expect(neighbors).toEqual({ exitCode: 0, stderr: "", results: [
      { status: "fulfilled", kind: "created" }, { status: "fulfilled", kind: "created" }, { status: "fulfilled", kind: "delivery" },
    ] });
    expect(observations).toEqual([false]);
    expect(commitHeld).toEqual([true]);
    expect(leases.holds.length).toBeGreaterThan(0);
  } finally {
    capture.mockRestore(); commitSpy.mockRestore(); leases.stop(); Object.assign(productionSpawnCommandDependencies, original);
    console.info(JSON.stringify({ measurement: "seat spawn credential capture", maxHoldMs: Math.max(0, ...leases.holds), holdMs: leases.holds, captureMs, commitMs, commitHeld, observations, neighbors }));
  }
}, 10_000);

test.each(["catalog", "credentials"] as const)("seat spawn revalidates %s changed during credential capture before committing a baseline or receipt", async change => {
  const auth = await import("@/lib/accounts/seatAuthCredentials");
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const { executeOrchestratorSeatRequest, productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
  const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const cwd = statePath(`seat-${change}-race-cwd`);
  fs.mkdirSync(path.join(cwd, "account"), { recursive: true });
  const original = { ...productionSpawnCommandDependencies };
  Object.assign(productionSpawnCommandDependencies, structuredRouteDependencies(cwd), { defer: () => {}, engineReadiness: () => "connected" });
  const project = `seat-${change}-race`;
  const clientRequestId = `seat_${crypto.randomUUID()}`;
  let captures = 0;
  const capture = spyOn(auth, "seatAuthCredentialStamp").mockImplementation(() => {
    captures++;
    if (change === "catalog") createManagedCodexAccount("Concurrent catalog change");
    else fs.writeFileSync(path.join(cwd, "account", ".credentials.json"), JSON.stringify({ fixture: "x".repeat(captures) }), { mode: 0o600 });
    return `1:file:${"a".repeat(64)}`;
  });
  try {
    const result = await executeOrchestratorSeatRequest({ project, cwd, mandate: "Own the fixture board", engine: "claude", model: "sonnet", clientRequestId }, {
      ...productionSeatCommandDependencies, engineReadiness: () => "connected", startBoardReport: () => {}, stampRegistryIdentity: () => {},
    });
    expect(captures).toBeGreaterThan(0);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("account_admission_changed");
    expect(agentRegistry().spawnReceiptForClientAttempt(clientRequestId)).toBeNull();
    const seat = orchestratorSeatFor(project);
    expect(seat.active).toBeNull();
    expect(seat.pending?.authCredentialBaseline).toBeUndefined();
    expect(result.body.seat).toMatchObject({ authCredentialBaseline: undefined });
  } finally { capture.mockRestore(); Object.assign(productionSpawnCommandDependencies, original); }
});

test("an oversized structured spawn launches with its full prompt in a stable readable reference", async () => {
  const cwd = statePath("large-spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.invalid");
  git("config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  git("add", "source.ts");
  git("commit", "--quiet", "-m", "fixture base");
  let deliveredPrompt = "";
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.spawnStructuredConversation = async (input) => {
    deliveredPrompt = input.prompt;
    return {
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    };
  };
  const original = `Launch complete role brief\n${"界🙂".repeat(12_000)}`;
  const clientAttemptId = `attempt_${crypto.randomUUID()}`;
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId, title: "Large structured launch", engine: "claude", cwd, prompt: original, mcpServers: [] }),
  });

  const first = await executeSpawnRequest(request(), dependencies);
  expect(first.status).toBe(202);
  expect(Buffer.byteLength(deliveredPrompt, "utf8")).toBeLessThanOrEqual(32_000);
  const file = deliveredPrompt.match(/Full structured first message file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
  const firstReference = deliveredPrompt;

  // Replaying the same request takes the durable receipt path and retains the
  // same request payload and content-addressed file reference.
  await executeSpawnRequest(request(), dependencies);
  expect(deliveredPrompt).toBe(firstReference);
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "ordinary worker change");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.ts");
  expect(git("show", "HEAD:source.ts")).toBe("export const value = 2;");
  expect(git("show", "--format=", "HEAD")).not.toContain("Launch complete role brief");
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
});

test("ordinary Git commits exclude private structured prompts under tracked inclusion rules", async () => {
  const envKeys = ["LLV_SPAWN_TRANSPORT", "LLV_STRUCTURED_HOSTS", "LLV_RUNTIME_EVENTS", "LLV_RUNTIME_HOST_SOCKET", "NEXT_PUBLIC_RUNTIME_UI"] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("private-prompt-runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  const cwd = statePath("private-prompt-publication-cwd");
  const ignoreDir = path.join(cwd, ".artifacts", "pipeline-stage-inputs");
  fs.mkdirSync(ignoreDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(ignoreDir, ".gitignore"), "!*.md\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.com");
  git("config", "commit.gpgSign", "false");
  git("add", "source.ts", ".artifacts/pipeline-stage-inputs/.gitignore");
  git("commit", "--quiet", "-m", "fixture base");

  let deliveredPrompt = "";
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.spawnStructuredConversation = async (input) => {
    deliveredPrompt = input.prompt;
    return {
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    };
  };
  const privatePrompt = `Private controller input\n${"Sensitive worker brief. ".repeat(2_000)}`.trim();
  try {
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Private structured launch", engine: "claude", cwd, prompt: privatePrompt, mcpServers: [] }),
    }), dependencies);

    expect(response.status).toBe(202);
    const privateFile = deliveredPrompt.match(/Full structured first message file: (.+)\n/)?.[1];
    expect(privateFile).toBeDefined();
    expect(fs.readFileSync(privateFile!, "utf8")).toBe(privatePrompt);
    const ignoreContents = fs.readFileSync(path.join(ignoreDir, ".gitignore"), "utf8");
    expect(ignoreContents.startsWith("!*.md\n")).toBe(true);
    expect(ignoreContents.trimEnd().endsWith("*")).toBe(true);
    git("restore", "--", ".artifacts/pipeline-stage-inputs/.gitignore");
    fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "ordinary worker commit");

    const committedFiles = git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
    expect(committedFiles).toContain("source.ts");
    expect(committedFiles.filter((file) => file.startsWith(".artifacts/pipeline-stage-inputs/") && !file.endsWith("/.gitignore"))).toEqual([]);
    expect(committedFiles).not.toContain(path.relative(cwd, privateFile!).split(path.sep).join("/"));
    expect(git("show", "--format=", "HEAD")).not.toContain(privatePrompt);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

test("a catalog generation change cannot admit the previously selected home", async () => {
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const cwd = statePath("changed-catalog-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const dependencies = structuredRouteDependencies(cwd);
  const resolve = dependencies.resolveSpawnAccount;
  let reads = 0;
  dependencies.resolveSpawnAccount = (...args) => {
    const account = resolve(...args);
    reads++;
    if (reads === 1) {
      createManagedCodexAccount("Concurrent catalog mutation");
      return account;
    }
    return { ...account, home: path.join(cwd, "replacement") };
  };
  dependencies.defer = () => { throw new Error("stale catalog must not launch"); };
  const clientAttemptId = `attempt_${crypto.randomUUID()}`;
  const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId, title: "Reject stale catalog", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  }), dependencies);
  expect(reads).toBe(2);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: "The account changed while preparing the launch; try again shortly.",
    code: "account_admission_changed",
    retrySafe: true,
    retryable: true,
  });
  expect(agentRegistry().spawnReceiptForClientAttempt(clientAttemptId)).toBeNull();
});

test("automatic target admission refuses a changed pool after account evidence without reserving a launch", async () => {
  const { accountProjectBindings } = await import("@/lib/accounts/projectBindings");
  const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
  const { seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
  const cwd = statePath("automatic-target-cwd"); fs.mkdirSync(cwd, { recursive: true });
  const dependencies = structuredRouteDependencies(cwd);
  let entered!: () => void, resume!: () => void;
  const collecting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const nativeResolve = dependencies.resolveHealthySpawnAccount;
  dependencies.resolveHealthySpawnAccount = async (...args) => { entered(); await gate; return nativeResolve(...args); };
  dependencies.assertAccountAdmission = () => { accountProjectBindings(); };
  let dispatches = 0;
  dependencies.defer = () => { dispatches++; };
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });
  const id = `attempt_${crypto.randomUUID()}`;
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: id, title: "Automatic target", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  });
  const pending = executeSpawnRequest(request(), dependencies);
  await Promise.race([collecting, pending.then(() => { throw new Error("spawn did not wait for evidence"); })]);
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: "damaged" }); resume();
  const refused = await pending;
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toContain("account-project-bindings.json");
  expect(agentRegistry().spawnReceiptForClientAttempt(id)).toBeNull(); expect(dispatches).toBe(0);
  // Deliberate operator launches do not acquire the automatic pool restriction.
  delete dependencies.assertAccountAdmission;
  expect((await executeSpawnRequest(request(), dependencies)).status).toBe(202);
  expect(dispatches).toBe(1);
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });
});

test.each(["dependency", "forwarded", "scheduled"] as const)("autonomous %s spawn rechecks update admission after account evidence, while manual and receipt replay remain allowed", async (source) => {
  const cwd = statePath("autonomous-admission-cwd"); fs.mkdirSync(cwd, { recursive: true });
  process.env.LLV_SPAWN_TRANSPORT = "structured"; process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1"; process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("fixture.sock");
  let held = false, entered!: () => void, resume!: () => void;
  const collecting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const dependencies = structuredRouteDependencies(cwd) as SpawnCommandDependencies & { autonomousAdmissionHeld: () => boolean };
  if (source === "dependency") dependencies.autonomousAdmissionHeld = () => held;
  if (source === "scheduled") Object.assign(dependencies, (await import("@/lib/telegram/reportSpawn")).reportSpawnOverrides(() => true, "scheduled"));
  dependencies.defer = () => {};
  const nativeResolve = dependencies.resolveHealthySpawnAccount;
  dependencies.resolveHealthySpawnAccount = async (...args) => { entered(); await gate; return nativeResolve(...args); };
  const request = (id: string, autonomous = source === "forwarded") => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json", ...(autonomous ? { "x-llv-autonomous-spawn": "1" } : {}) },
    body: JSON.stringify({ clientAttemptId: id, title: "Autonomous admission", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  });
  const id = `attempt_${crypto.randomUUID()}`;
  const pending = executeSpawnRequest(request(id), dependencies);
  await Promise.race([collecting, pending.then(async response => { throw new Error(`spawn returned before account evidence: ${response.status} ${JSON.stringify(await response.clone().json())}`); })]); held = true; writeDrain(drainFile(), { id: "forwarded-admission", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true }); resume();
  const refused = await pending;
  expect(refused.status).toBe(503); expect(await refused.json()).toMatchObject({ code: "AUTO_UPDATE_DRAIN" });
  expect(agentRegistry().spawnReceiptForClientAttempt(id)).toBeNull();
  held = false; releaseDrain(drainFile(), "forwarded-admission");
  expect((await executeSpawnRequest(request(id), dependencies)).status).toBe(202);
  const receipt = agentRegistry().spawnReceiptForClientAttempt(id)!;
  held = true; writeDrain(drainFile(), { id: "forwarded-admission", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
  expect((await executeSpawnRequest(request(id), dependencies)).status).toBe(202);
  expect(agentRegistry().spawnReceiptForClientAttempt(id)!.launchId).toBe(receipt.launchId);
  const manual = structuredRouteDependencies(cwd); manual.defer = () => {};
  expect((await executeSpawnRequest(request(`attempt_${crypto.randomUUID()}`, false), manual)).status).toBe(202);
  releaseDrain(drainFile(), "forwarded-admission");
});


test.each(["existing", "account-lock"] as const)("scheduled report launch respects %s drain and rechecks downstream admission", async (seam) => {
  const { launchReportConversation } = await import("@/lib/telegram/reportSpawn");
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const { procBackend } = await import("@/lib/proc");
  const cwd = statePath("report-lock-cwd"); fs.mkdirSync(cwd, { recursive: true });
  const originalDependencies = { ...productionSpawnCommandDependencies };
  const oldCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = path.join(cwd, "codex-list-stub");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
  process.env.LLV_CODEX_BINARY = codexBinary;
  const fixture = structuredRouteDependencies(cwd);
  const resolveAccount = fixture.resolveSpawnAccount;
  fixture.resolveSpawnAccount = (...args) => ({ ...resolveAccount(...args), engine: "codex", accountId: "report-fixture" });
  fixture.resolveHealthySpawnAccount = async () => fixture.resolveSpawnAccount("codex", "report-fixture");
  let dispatches = 0;
  const dispatch = fixture.spawnStructuredConversation;
  fixture.spawnStructuredConversation = async input => { dispatches++; return dispatch(input); };
  Object.assign(productionSpawnCommandDependencies, fixture);
  const attempt = `attempt_${crypto.randomUUID()}`;
  const input = { trigger: "scheduled" as const, grantActive: () => true, body: { clientAttemptId: attempt, title: "Scheduled report fixture", engine: "codex", cwd, prompt: "inspect", mcpServers: [] } };
  const lock = statePath("account-selection.lock");
  const write = fs.writeFileSync;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let blocked = false;
  try {
    if (seam === "existing") {
      writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
      expect(await launchReportConversation(input)).toMatchObject({ status: 503, body: { code: "AUTO_UPDATE_DRAIN" } });
      expect(agentRegistry().spawnReceiptForClientAttempt(attempt)).toBeNull(); expect(dispatches).toBe(0);
      releaseDrain(drainFile(), "report-account-lock");
    }
    fs.writeFileSync = ((file, data, ...rest) => {
      write(file, data, ...rest);
      if (!blocked && typeof file === "string" && file.endsWith(".json") && typeof data === "string" && data.includes('"holder":"spawn admission"')) {
        blocked = true;
        write(lock, JSON.stringify({ pid: process.pid, startIdentity: procBackend.processIdentity(process.pid), ns: fs.readlinkSync("/proc/self/ns/pid"), token: "report-lock-fixture", holder: "fixture hold", acquiredAt: Date.now() }));
        entered();
      }
    }) as typeof fs.writeFileSync;
    const pending = launchReportConversation(input);
    await Promise.race([waiting, pending.then(() => { throw new Error("launch never waited for account admission"); })]);
    writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    fs.rmSync(lock); fs.writeFileSync = write;
    expect(await pending).toMatchObject({ status: 503, body: { code: "AUTO_UPDATE_DRAIN" } });
    expect(agentRegistry().spawnReceiptForClientAttempt(attempt)).toBeNull(); expect(dispatches).toBe(0);
    releaseDrain(drainFile(), "report-account-lock");
    expect((await launchReportConversation(input)).status).toBe(202);
    for (let i = 0; i < 100 && dispatches === 0; i++) await Bun.sleep(10);
    expect(dispatches).toBe(1);
    const receipt = agentRegistry().spawnReceiptForClientAttempt(attempt)!;
    writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    expect((await launchReportConversation(input)).status).toBe(202);
    expect(agentRegistry().spawnReceiptForClientAttempt(attempt)?.launchId).toBe(receipt.launchId);
    expect((await launchReportConversation({ ...input, trigger: "manual", body: { ...input.body, clientAttemptId: `attempt_${crypto.randomUUID()}` } })).status).toBe(202);
  } finally {
    fs.writeFileSync = write;
    if (oldCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY; else process.env.LLV_CODEX_BINARY = oldCodexBinary;
    if (blocked && fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, "utf8")).token === "report-lock-fixture") fs.rmSync(lock);
    releaseDrain(drainFile(), "report-account-lock"); Object.assign(productionSpawnCommandDependencies, originalDependencies);
  }
});
