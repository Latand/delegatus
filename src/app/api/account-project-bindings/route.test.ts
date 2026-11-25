import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as credentials from "@/lib/accounts/claudeCredentials";
import { NextRequest } from "next/server";

/* Everything the route touches — the binding record, the registry it reads
   carriers from — resolves inside this sandbox. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-binding-route-"));
const STATE = path.join(SANDBOX, "state");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
const ORIGINAL_HOME = process.env.HOME;
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "home"), { recursive: true });
process.env.LLV_STATE_DIR = STATE;
process.env.HOME = path.join(SANDBOX, "home");

const { GET, POST } = await import("./route");
const { BINDINGS_SOURCE, resetAccountCollectionsForTests } = await import("@/lib/accounts/accountsStore");
const { clearAccountFixture, persistedAccountSource, seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
const { accountProjectBindings, unbindAccountFromProject } = await import("@/lib/accounts/projectBindings");

const ATLAS = "project-atlas";

/** The default legacy Claude account, the one every state directory has. */
const MAIN = "default";

beforeEach(() => {
  resetAccountCollectionsForTests();
  clearAccountFixture(BINDINGS_SOURCE);
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

async function readResponse(project?: string): Promise<{ status: number; payload: Record<string, unknown> }> {
  const url = project
    ? `http://127.0.0.1/api/account-project-bindings?project=${encodeURIComponent(project)}`
    : "http://127.0.0.1/api/account-project-bindings";
  const response = await GET(new NextRequest(url));
  return { status: response.status, payload: await response.json() as Record<string, unknown> };
}

async function read(project?: string): Promise<Record<string, unknown>> {
  const url = project
    ? `http://127.0.0.1/api/account-project-bindings?project=${encodeURIComponent(project)}`
    : "http://127.0.0.1/api/account-project-bindings";
  return await (await GET(new NextRequest(url))).json() as Record<string, unknown>;
}

async function mutate(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await POST(new NextRequest("http://127.0.0.1/api/account-project-bindings", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:8898" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, payload: await response.json() as Record<string, unknown> };
}

test("an unconfigured project reads as allowing every account", async () => {
  const view = await read(ATLAS) as { engines: Record<string, { restricted: boolean; allowed: { accountId: string }[] }> };
  expect(view.engines.claude?.restricted).toBe(false);
  expect(view.engines.claude?.allowed.map((account) => account.accountId)).toContain(MAIN);
  expect(view.engines.codex?.restricted).toBe(false);
});

test("binding readback discovers credentials without the lease and keeps the committed result during a racing unbind", async () => {
  const read = credentials.readClaudeCredentials;
  const held: boolean[] = [];
  let raced = false;
  const probe = spyOn(credentials, "readClaudeCredentials").mockImplementation((...args) => {
    held.push(fs.existsSync(path.join(STATE, "account-selection.lock")));
    if (!raced) { raced = true; unbindAccountFromProject("claude", MAIN, ATLAS); }
    return read(...args);
  });
  try {
    const result = await mutate({ action: "add", engine: "claude", accountId: MAIN, project: ATLAS });
    expect(result.payload).toMatchObject({ bindings: [{ accountId: MAIN }],
      project: { engines: { claude: { restricted: true, allowed: [{ accountId: MAIN }] } } } });
    expect(accountProjectBindings()).toEqual([]);
    expect(held.length).toBeGreaterThan(0);
    expect(held).not.toContain(true);
  } finally { probe.mockRestore(); }
});

test("an added binding is visible from both directions, and survives a fresh read", async () => {
  const added = await mutate({ action: "add", engine: "claude", accountId: MAIN, project: ATLAS });
  expect(added.status).toBe(200);
  expect(added.payload).toMatchObject({
    ok: true,
    changed: true,
    bindings: [{ engine: "claude", accountId: MAIN, project: ATLAS }],
    project: { engines: { claude: { restricted: true, allowed: [{ accountId: MAIN }] } } },
  });

  /* The record, not the response: an independent process-level read finds it. */
  expect(accountProjectBindings()).toMatchObject([{ engine: "claude", accountId: MAIN, project: ATLAS }]);

  const accountsSide = await read() as { accounts: Record<string, { accountId: string; projects: { project: string; displayName: string }[] }[]> };
  expect(accountsSide.accounts.claude?.find((account) => account.accountId === MAIN)?.projects)
    .toEqual([{ project: ATLAS, displayName: ATLAS }]);
});

test("a removal is confirmed by the record read back, and restores the unbound answer", async () => {
  await mutate({ action: "add", engine: "claude", accountId: MAIN, project: ATLAS });
  const removed = await mutate({ action: "remove", engine: "claude", accountId: MAIN, project: ATLAS });
  expect(removed.payload).toMatchObject({ ok: true, changed: true, bindings: [] });
  const view = await read(ATLAS) as { engines: Record<string, { restricted: boolean }> };
  expect(view.engines.claude?.restricted).toBe(false);
});

test("a malformed mutation is refused and writes nothing", async () => {
  expect((await mutate({ action: "toggle", engine: "claude", accountId: MAIN, project: ATLAS })).status).toBe(400);
  expect((await mutate({ action: "add", engine: "gemini", accountId: MAIN, project: ATLAS })).status).toBe(400);
  expect((await mutate({ action: "add", engine: "claude", accountId: MAIN })).status).toBe(400);
  expect(accountProjectBindings()).toEqual([]);
});

test("a damaged record answers with the repair it needs, and never with an empty relation", async () => {
  await mutate({ action: "add", engine: "claude", accountId: MAIN, project: ATLAS });
  /* Since #1870 the record is rows, so damage is a row no reader can turn into
     a binding rather than bytes that will not parse. */
  const damaged = { schemaVersion: 1, bindings: [{ engine: "claude", accountId: MAIN }] };
  seedAccountSource(BINDINGS_SOURCE, damaged);

  /* Both reads: an empty `bindings` list with a 200 would tell the panel that
     nothing is restricted, which is the fence disappearing from the view of the
     one project that has one. */
  for (const answer of [await readResponse(), await readResponse(ATLAS)]) {
    expect(answer.status).toBe(409);
    expect(answer.payload).toMatchObject({ error: "RECORD_UNREADABLE" });
    expect(String(answer.payload.message)).toContain("account-project-bindings.json");
    expect(answer.payload.engines).toBeUndefined();
  }

  const added = await mutate({ action: "add", engine: "claude", accountId: "acct-intruder", project: ATLAS });
  expect(added.status).toBe(409);
  expect(added.payload).toMatchObject({ error: "RECORD_UNREADABLE" });
  const removed = await mutate({ action: "remove", engine: "claude", accountId: MAIN, project: ATLAS });
  expect(removed.status).toBe(409);

  /* Neither mutation wrote over the record the operator still has to repair. */
  expect(persistedAccountSource(BINDINGS_SOURCE)).toEqual(damaged);
});

test("project reads and mutation confirmations fetch only current hot carriers", async () => {
  const { Database } = await import("bun:sqlite");
  const { AgentRegistry, agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const transcript = await import("@/lib/agent/transcript");
  const scanner = await import("@/lib/scanner/describe");
  const previous = agentRegistry();
  const directory = fs.mkdtempSync(path.join(STATE, "carrier-registry-"));
  const sqliteFilename = path.join(directory, "registry.sqlite");
  let payloads = 0;
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename, onSqliteRowPayloadRead: (_collection, count) => { payloads += count; },
  });
  const peer = new Database(sqliteFilename);
  const snapshot = spyOn(registry, "readOnlySnapshot");
  const adopted = path.join(directory, "adopted.jsonl");
  const head = spyOn(transcript, "headCwd").mockImplementation(file => file === adopted ? directory : null);
  const cwd = spyOn(scanner, "projectForCwd").mockImplementation(file => file === directory ? ATLAS : null);
  try {
    setAgentRegistryForTests(registry);
    function seed(account: string | null, changes: {
      engine?: "claude" | "codex" | "copilot" | "antigravity"; project?: string | null;
      source?: string; idle?: boolean; adopted?: boolean; previousGeneration?: boolean;
    } = {}) {
      const file = changes.adopted ? adopted : path.join(directory, String(account) + ".jsonl");
      const row = registry.ensureConversation(changes.engine ?? "claude", file, account);
      const latest = row.generations[0]!;
      latest.launchProfile.project = changes.project === undefined ? ATLAS : changes.project;
      if (changes.previousGeneration) row.generations.unshift({ ...latest, accountId: "former-account" });
      row.turn.state = changes.idle ? "idle" : "busy";
      const raw = { ...row, projectOwnership: changes.source ? { project: "elsewhere", source: changes.source } : null };
      peer.query("UPDATE registry_rows SET value_json=? WHERE collection='conversations' AND row_key=?")
        .run(JSON.stringify(raw), row.id);
      return row.id;
    }
    const live = seed("a-current", { previousGeneration: true });
    seed("b-legacy", { source: "unknown-legacy-source" });
    seed("c-adopted", { project: null, adopted: true, engine: "codex" });
    seed("override", { source: "operator" });
    seed("quiet", { idle: true });
    seed("unsupported", { engine: "copilot" });
    seed("unsupported-ag", { engine: "antigravity" });
    seed(null);
    const cold = seed("archived");
    peer.query("INSERT INTO registry_archive(collection,row_key,value_json,row_order) SELECT collection,row_key,value_json,row_order FROM registry_rows WHERE collection='conversations' AND row_key=?").run(cold);
    peer.query("INSERT INTO registry_cold(collection,row_key,archive_id) VALUES ('conversations',?,last_insert_rowid())").run(cold);

    const expected = {
      claude: { carrying: [{ accountId: "a-current" }, { accountId: "b-legacy" }] },
      codex: { carrying: [{ accountId: "c-adopted" }] },
    };
    payloads = 0;
    expect(await read(ATLAS)).toMatchObject({ engines: expected });
    expect(head.mock.calls.map(call => call[0])).toEqual([adopted]);
    expect(await read("elsewhere")).toMatchObject({ engines: { claude: { carrying: [{ accountId: "override" }] } } });
    peer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.turn.state','idle') WHERE collection='conversations' AND row_key=?").run(live);
    const response = await mutate({ action: "add", engine: "claude", accountId: MAIN, project: ATLAS });
    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({ project: { engines: {
      claude: { restricted: true, carrying: [{ accountId: "b-legacy" }] }, codex: expected.codex,
    } } });
    expect(snapshot).not.toHaveBeenCalled();
    expect(payloads).toBe(0);

    // A restored database can be queried before its owner installs the index.
    peer.exec("DROP INDEX IF EXISTS registry_busy_carriers");
    expect(await read(ATLAS)).toMatchObject({ engines: { codex: expected.codex } });
  } finally {
    head.mockRestore();
    cwd.mockRestore();
    snapshot.mockRestore();
    setAgentRegistryForTests(previous);
    peer.close();
    registry.close();
  }
});

test.each(["off", "sqlite"] as const)("the %s view follows routing and quota changes", async sqliteMode => {
  const { AgentRegistry, agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const codex = await import("@/lib/accounts/codex");
  const transcript = await import("@/lib/agent/transcript");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const previous = agentRegistry();
  const filename = path.join(fs.mkdtempSync(path.join(STATE, "selection-")), "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
  const peer = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
  const account = codex.listCodexAccounts()[0]!;
  const catalog = spyOn(codex, "listCodexAccounts").mockReturnValue(["first", "second"]
    .map(id => ({ ...account, id, label: id, authPresent: true })));
  const head = spyOn(transcript, "headCwd");
  try {
    setAgentRegistryForTests(registry);
    registry.reconcileConversations([{
      engine: "claude", path: path.join(path.dirname(filename), "adopted.jsonl"), accountId: MAIN,
      launchProfile: emptyLaunchProfile(), turn: { state: "busy", source: "assistant", terminalAt: null },
      observedAt: new Date().toISOString(),
    }], { snapshot: false });
    peer.setEngineRouting("codex", "first");
    // A transcript lookup can take long enough for another process to reroute.
    head.mockImplementationOnce(() => { peer.setEngineRouting("codex", "second"); return null; });
    expect(await read(ATLAS)).toMatchObject({ engines: { codex: { nextChosenAccountId: "second" } } });
    expect(head).toHaveBeenCalledTimes(1);
    const now = new Date();
    peer.recordQuotaObservation({
      engine: "codex", accountId: "second", authenticated: true, observedAt: now.toISOString(),
      authCheckedAt: now.toISOString(), bootId: "fixture", provenance: { source: "live", reason: null, staleSince: null },
      limits: { session: { usedPercent: 100, resetsAt: Math.floor(+now / 1000) + 3600 },
        weekly: null, plan: "max", capturedAt: Math.floor(+now / 1000) },
    });
    expect(await read(ATLAS)).toMatchObject({ engines: { codex: { nextChosenAccountId: "first" } } });
  } finally {
    head.mockRestore();
    catalog.mockRestore();
    setAgentRegistryForTests(previous);
    peer.close();
    registry.close();
  }
});
