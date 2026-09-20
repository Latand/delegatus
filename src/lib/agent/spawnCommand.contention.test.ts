import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { SpawnCommandDependencies } from "./spawnCommand";

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

test("spawn catalog resolution leaves admission available", async () => {
  const cwd = statePath("spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("fixture.sock");
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
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: "spawn account changed during admission" });
  expect(agentRegistry().spawnReceiptForClientAttempt(clientAttemptId)).toBeNull();
});
