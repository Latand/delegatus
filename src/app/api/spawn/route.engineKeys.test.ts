import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";

import { AgentRegistry, type RegistryFile } from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { POST } from "./route";

/* A registry persisted before the Copilot engine existed carries no `copilot`
   key in any per-engine record, and the first real Copilot launch dereferenced
   `engineRouting.copilot` as undefined (#2045). Each store gets such a fixture
   and a Copilot launch through the spawn route, settled the way the structured
   host settles one. */

const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_SPAWN_TRANSPORT", "LLV_STRUCTURED_HOSTS", "LLV_RUNTIME_EVENTS", "LLV_RUNTIME_HOST_SOCKET", "NEXT_PUBLIC_RUNTIME_UI"] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-engine-keys-"));

beforeAll(() => {
  process.env.HOME = path.join(sandbox, "home");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The per-engine records exactly as a release before Copilot wrote them. */
const PRE_COPILOT_META = {
  conversationRevision: { claude: 4, codex: 7 },
  engineRouting: { claude: { activeAccountId: "claude-main", revision: 4 }, codex: { activeAccountId: "codex-main", revision: 7 } },
  quotaObservations: { claude: {}, codex: {} },
  autoBalance: { claude: { enabled: false }, codex: { enabled: false } },
};

function jsonFixture(root: string): AgentRegistry {
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify({ version: 2, entries: {}, receipts: {}, ...PRE_COPILOT_META }));
  return new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
}

function sqliteFixture(root: string): AgentRegistry {
  const filename = path.join(root, "agent-registry.json");
  const sqliteFilename = path.join(root, "agent-registry.sqlite");
  new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename }).ensureConversation("codex", "/sessions/seed.jsonl", "codex-main");
  const db = new Database(sqliteFilename);
  try {
    for (const [key, value] of Object.entries(PRE_COPILOT_META)) {
      db.query("UPDATE registry_meta SET value = ? WHERE key = ?").run(JSON.stringify(value), key);
    }
    const stored = db.query<{ value: string }, [string]>("SELECT value FROM registry_meta WHERE key = ?").get("engineRouting");
    expect(Object.keys(JSON.parse(stored!.value) as object)).toEqual(["claude", "codex"]);
  } finally {
    db.close();
  }
  return new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename });
}

async function launchCopilot(store: AgentRegistry, root: string): Promise<string> {
  const cwd = fs.mkdtempSync(path.join(root, "cwd-"));
  const home = path.join(root, "copilot-home");
  const account = {
    engine: "copilot" as const,
    accountId: "copilot-main",
    kind: "managed" as const,
    home,
    transcriptRoot: path.join(home, "session-state"),
    env: { NODE_ENV: "test" as const },
  };
  const deferred: Promise<unknown>[] = [];
  let failure: unknown = null;
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ title: "copilot · first launch", engine: "copilot", cwd, prompt: "Say hello", clientAttemptId: `attempt_${crypto.randomUUID()}` }),
  }), {
    registry: () => store,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: (work) => { deferred.push(Promise.resolve().then(work).catch((error: unknown) => { failure = error; })); },
    storeImages: () => [],
    /* What the structured host does once the Copilot session names its
       transcript: settle the receipt onto it. */
    spawnStructuredConversation: async (input) => {
      const sessionId = crypto.randomUUID();
      const artifactPath = path.join(account.transcriptRoot, sessionId, "events.jsonl");
      store.completeSpawn(input.receipt.launchId, {
        key: { engine: "copilot", sessionId },
        artifactPath,
        cwd,
        accountId: account.accountId,
        status: "idle",
        host: null,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });
      return {
        ok: true,
        target: null,
        path: artifactPath,
        effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "delivered",
        state: "settled",
      };
    },
  });
  const body = await response.json() as Record<string, unknown>;
  expect({ status: response.status, error: body.error }).toEqual({ status: 202, error: undefined });
  await Promise.all(deferred);
  expect(failure).toBeNull();
  return body.conversationId as string;
}

function expectCopilotRecords(file: RegistryFile): void {
  expect(file.engineRouting.copilot.activeAccountId).toBeNull();
  expect(file.engineRouting.copilot.revision).toBeGreaterThan(0);
  expect(file.conversationRevision.copilot).toBeGreaterThan(0);
  expect(file.quotaObservations.copilot).toEqual({});
  expect(file.autoBalance.copilot).toBeDefined();
  /* The records the fixture did carry are kept as written. */
  expect(file.engineRouting.codex).toEqual({ activeAccountId: "codex-main", revision: 7 });
  expect(file.engineRouting.claude).toEqual({ activeAccountId: "claude-main", revision: 4 });
}

for (const [store, fixture] of [["JSON", jsonFixture], ["SQLite", sqliteFixture]] as const) {
  test(`a Copilot launch on a ${store} registry persisted before Copilot existed settles and records its route`, async () => {
    const root = fs.mkdtempSync(path.join(sandbox, `${store.toLowerCase()}-`));
    const registry = fixture(root);

    const conversationId = await launchCopilot(registry, root);
    expect(registry.readOnlySnapshot().conversations[conversationId]?.engine).toBe("copilot");
    expectCopilotRecords(registry.readOnlySnapshot());

    /* Persisted by that write: a fresh open reads the copilot route back. */
    const reopened = store === "JSON"
      ? new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" })
      : new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "agent-registry.sqlite") });
    expectCopilotRecords(reopened.readOnlySnapshot());
    expect(reopened.engineRouting("copilot").revision).toBe(registry.engineRouting("copilot").revision);
  });
}

test("a Copilot route revision never leaks into the default a fresh registry starts from", async () => {
  const root = fs.mkdtempSync(path.join(sandbox, "default-"));
  await launchCopilot(jsonFixture(root), root);
  const fresh = new AgentRegistry(path.join(fs.mkdtempSync(path.join(sandbox, "fresh-")), "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  expect(fresh.engineRouting("copilot")).toEqual({ activeAccountId: null, revision: 0 });
  expect(fresh.readOnlySnapshot().quotaObservations.copilot).toEqual({});
});
