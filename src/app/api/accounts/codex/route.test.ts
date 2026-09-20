import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-app-server-route-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");

const { DELETE: remove, POST } = await import("./route");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { resetAccountCollectionsForTests } = await import("@/lib/accounts/accountsStore");
const { seedAccountRegistry } = await import("@/lib/accounts/accountsStoreFixture");
const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
const { CodexAppServerClient } = await import("@/lib/accounts/codexAppServer");
const { ManagedCodexRuntime, setManagedCodexRuntimeForTests } = await import("@/lib/accounts/codexRuntime");
const { agentRegistry } = await import("@/lib/agent/registry");
const { retiredAccountArchive, setAccountRemovalCheckpointForTests } = await import("@/lib/accounts/removal");

function deleteRequest(body: unknown) {
  return new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

class FakeChild extends EventEmitter {
  readonly stdin = { write: (line: string) => { this.onWrite(JSON.parse(line) as Record<string, unknown>); return true; }, end: () => undefined };
  readonly stdout = { on: (_event: string, listener: (chunk: string) => void) => this.on("stdout", listener) };
  readonly stderr = { on: (_event: string, listener: (chunk: string) => void) => this.on("stderr", listener) };
  kills = 0;
  kill(): boolean { this.kills += 1; return true; }
  onWrite(message: Record<string, unknown>): void {
    const id = message.id as number;
    if (message.method === "initialize") this.respond(id, {});
    if (message.method === "account/login/start") this.respond(id, { type: "chatgptDeviceCode", loginId: "test-login", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-1234" });
    if (message.method === "account/login/cancel") this.respond(id, { status: "canceled" });
  }
  respond(id: number, result: unknown): void { this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
}

afterAll(() => {
  setManagedCodexRuntimeForTests(null);
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("existing managed accounts expose retry and cancel without tmux", async () => {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild(); children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  }));
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ label: "Retry me" }),
  }));
  const { account } = await created.json() as { account: { id: string } };
  const retried = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "retry", id: account.id }),
  }));
  expect(retried.status).toBe(200);
  const cancelled = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", id: account.id }),
  }));
  await expect(cancelled.json()).resolves.toEqual({ account: { id: account.id }, cancelled: true });
  expect(children.every((child) => child.kills > 0)).toBe(true);
});

test("managed account creation returns an app-server challenge without the tmux compatibility adapter", async () => {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild();
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  }));
  const response = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Work" }),
  }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({
    account: expect.objectContaining({ id: "work", loginPending: true }),
    deviceAuth: { url: "https://auth.openai.com/device", code: "ABCD-1234" },
    target: "https://auth.openai.com/device",
  }));
  expect(children).toHaveLength(1);
  const source = fs.readFileSync(path.join(import.meta.dir, "route.ts"), "utf8");
  expect(source).not.toContain("@/lib/tmux");
  expect(source).not.toContain("spawnCommandWindow");
});

test("managed Codex removal cannot bypass device login with force", async () => {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild();
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  }));
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ label: "Remove me" }),
  }));
  const { account } = await created.json() as { account: { id: string } };

  const blocked = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
  }));
  expect(blocked.status).toBe(409);
  await expect(blocked.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["login_pending"] }));

  const forced = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id, force: true }),
  }));
  expect(forced.status).toBe(409);
  await expect(forced.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["login_pending"] }));
  expect(children[0]?.kills).toBe(0);
});

test("managed Codex removal retires routing and migration intents targeting the account", async () => {
  const account = createManagedCodexAccount("Routed removal");
  const registry = agentRegistry();
  registry.setEngineRouting("codex", account.id);
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: account.id,
    origin: "manual",
    requestId: "remove-routed-codex",
    expectedRevision: registry.engineRouting("codex").revision,
  });

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
  }));

  expect(response.status).toBe(200);
  expect(registry.engineRouting("codex").activeAccountId).toBe("default");
  expect(registry.snapshot().migrationIntents[intent.id]?.state).toBe("stopped");
});

test("managed Codex removal reports pending cleanup when a credential stays in the archive", async () => {
  const account = createManagedCodexAccount("Cleanup pending");
  fs.writeFileSync(path.join(account.home, "auth.json"), "{}", { mode: 0o600 });
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (path.basename(String(target)) === "auth.json") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return originalUnlink(target);
  }) as typeof fs.unlinkSync;
  try {
    const response = await remove(deleteRequest({ id: account.id }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ removed: { id: account.id }, cleanupPending: true });
  } finally {
    fs.unlinkSync = originalUnlink;
  }
});

test("managed Codex removal stays blocked while a migration is in flight on the account", async () => {
  const account = createManagedCodexAccount("Current history");
  const registry = agentRegistry();
  const conversation = registry.ensureConversation("codex", "/current-codex.jsonl", account.id);
  registry.setConversationMigration(conversation.id, {
    intentId: "intent-moving", phase: "preparing", targetId: "default", revision: 1, error: null, updatedAt: new Date().toISOString(),
  });

  const response = await remove(deleteRequest({ id: account.id, force: true }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["current_conversations"] }));
  expect(fs.existsSync(account.home)).toBe(true);
});

test("a Codex home with leftover history is removed and the answer says what moved (#1857)", async () => {
  const account = createManagedCodexAccount("Unowned session");
  const session = path.join(account.sessionsDir, "2026", "09", "01", "rollout-unowned.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
  fs.writeFileSync(session, "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(account.home, "state_5.sqlite"), "sqlite", { mode: 0o600 });
  const conversation = agentRegistry().ensureConversation("codex", session, account.id);
  agentRegistry().holdDelivery(conversation.id, "owed for weeks");
  const archive = retiredAccountArchive("codex", account.id);

  const response = await remove(deleteRequest({ id: account.id, force: true }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    removed: { id: account.id },
    cleanupPending: false,
    moved: { archive, files: 2, bytes: 9 },
    conversationsRewritten: 1,
    pinsCleared: 0,
    deliveriesDropped: 1,
    migrationsSettled: 0,
  });
  expect(fs.readFileSync(path.join(archive, path.relative(account.home, session)), "utf8")).toBe("{}\n");
});

test("managed Codex removal proceeds over dead history and keeps its sessions readable (issue #643)", async () => {
  const account = createManagedCodexAccount("Dead history");
  const registry = agentRegistry();
  const session = path.join(account.sessionsDir, "2026", "07", "24", "rollout-2026-07-24T00-00-00-99999999-1234-1234-1234-123456789abc.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
  fs.writeFileSync(session, "{}\n", { mode: 0o600 });
  const conversation = registry.ensureConversation("codex", session, account.id);

  const response = await remove(deleteRequest({ id: account.id }));

  expect(response.status).toBe(200);
  const moved = path.join(retiredAccountArchive("codex", account.id), path.relative(account.home, session));
  expect(fs.readFileSync(moved, "utf8")).toBe("{}\n");
  expect(registry.conversationForPath(moved)?.id).toBe(conversation.id);
});

test("managed Codex removal restores routing and the home when the accounts registry cannot commit", async () => {
  const account = createManagedCodexAccount("Commit failure");
  const registry = agentRegistry();
  registry.setEngineRouting("codex", account.id);
  const before = registry.snapshot();
  /* Since #1870 the accounts registry commit is one SQLite transaction, so the
     write that can fail is that commit. */
  const originalPatch = SqliteStateCollection.prototype.patchSync;
  let retired = false;
  setAccountRemovalCheckpointForTests((reached) => { if (reached === "registry-retired") retired = true; });
  SqliteStateCollection.prototype.patchSync = function patchSync(this: { signature(): string }, ...args: unknown[]) {
    if (retired && this.signature().includes(":accounts:")) {
      retired = false;
      throw Object.assign(new Error("registry write denied"), { code: "EACCES" });
    }
    return (originalPatch as (...rest: unknown[]) => void).apply(this, args);
  } as typeof SqliteStateCollection.prototype.patchSync;

  try {
    const response = await remove(deleteRequest({ id: account.id }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "removal_failed", errno: "EACCES" }));
    expect(registry.snapshot().engineRouting).toEqual(before.engineRouting);
    expect(fs.existsSync(account.home)).toBe(true);
    expect(fs.existsSync(retiredAccountArchive("codex", account.id))).toBe(false);
  } finally {
    SqliteStateCollection.prototype.patchSync = originalPatch;
    setAccountRemovalCheckpointForTests(null);
  }
});

test("an occupied Codex archive destination answers archive_unavailable", async () => {
  const account = createManagedCodexAccount("Taken archive");
  const archive = retiredAccountArchive("codex", account.id);
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });

  const response = await remove(deleteRequest({ id: account.id }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "archive_unavailable", archive }));
  expect(fs.existsSync(account.home)).toBe(true);
});


for (const action of ["start", "retry", "cancel"] as const) {
  test(`${action} login releases the lease while RPC is pending`, async () => {
    const { measureContention } = await import("@/lib/accounts/accountMutation.contention.fixture");
    const account = action === "start" ? null : createManagedCodexAccount(`Contention ${action}`);
    const runtime = new ManagedCodexRuntime();
    await measureContention(`codex-${action}`, async (pause) => {
      const challenge = { accountId: account?.id ?? "contention-start", loginId: "fixture", verificationUrl: "https://example.com/device", userCode: "fixture", startedAt: Date.now() };
      runtime.startLogin = async () => { await pause(); return challenge; };
      runtime.retryLogin = async () => { await pause(); return challenge; };
      runtime.cancelLogin = async () => { await pause(); return true; };
      setManagedCodexRuntimeForTests(runtime);
      const response = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
        method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify(action === "start" ? { label: "Contention start" } : { action, id: account!.id }),
      }));
      expect(response.status).toBe(200);
    });
  });
}

test("a delayed real login blocks removal and competing login, then releases its reservation", async () => {
  const account = createManagedCodexAccount("Reserved login");
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const child = new FakeChild();
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({ startClient: async (home) => {
    entered(); await held;
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } }));
  const request = (action: string) => new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action, id: account.id }),
  });
  const login = POST(request("retry"));
  await ready;
  try {
    const removed = await remove(deleteRequest({ id: account.id, force: true }));
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ blockers: ["login_pending"] });
    expect((await POST(request("retry"))).status).toBe(409);
    expect((await POST(request("cancel"))).status).toBe(409);
    expect(fs.existsSync(account.home)).toBe(true);
  } finally { release(); }
  expect((await login).status).toBe(200);
  expect((await POST(request("cancel"))).status).toBe(200);
  expect((await remove(deleteRequest({ id: account.id }))).status).toBe(200);
});

test("cancel keeps removal fenced after the runtime marks its attempt canceled", async () => {
  const account = createManagedCodexAccount("Cancel reservation");
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const child = new FakeChild();
  const originalWrite = child.onWrite.bind(child);
  child.onWrite = (message) => {
    if (message.method !== "account/login/cancel") { originalWrite(message); return; }
    entered(); void held.then(() => child.respond(message.id as number, { status: "canceled" }));
  };
  const runtime = new ManagedCodexRuntime({ startClient: (home) => CodexAppServerClient.start({ home, spawn: () => child as never }) });
  setManagedCodexRuntimeForTests(runtime);
  await runtime.startLogin(account);
  const cancel = POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", id: account.id }),
  }));
  await ready;
  try {
    expect(runtime.peekLogin(account).attemptState).toBe("cancelled");
    const removed = await remove(deleteRequest({ id: account.id, force: true }));
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ blockers: ["login_pending"] });
  } finally { release(); }
  expect((await cancel).status).toBe(200);
  expect((await remove(deleteRequest({ id: account.id }))).status).toBe(200);
});

test("managed Codex removal reports a corrupt registry as locked", async () => {
  /* A record the store cannot turn into an account list; since #1870 that is a
     row it refuses on rather than bytes that will not parse. */
  seedAccountRegistry("codex", { version: 1, active: "default", accounts: [{ id: "../escape", label: "Escape", kind: "managed", createdAt: 1 }] });

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: "missing" }),
  }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "accounts_locked" }));
});
