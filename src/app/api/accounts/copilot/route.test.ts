import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { NextRequest } from "next/server";
import * as cli from "@/lib/agent/cli";
import { statePath } from "@/lib/configDir";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-route-"));
const previous = {
  state: process.env.LLV_STATE_DIR,
  home: process.env.COPILOT_HOME,
  bin: process.env.LLV_COPILOT_BIN,
};
let run = 0;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.COPILOT_HOME = path.join(sandbox, "legacy-absent");
process.env.LLV_COPILOT_BIN = "/fixture/copilot";
const { createManagedCopilotAccount } = await import("@/lib/accounts/copilot");
const { CopilotLoginSupervisor, setCopilotLoginSupervisorForTests } = await import("@/lib/accounts/copilotLogin");
const { DELETE: remove, GET, POST } = await import("./route");
const { GET: getModels } = await import("./models/route");

class FakeChild extends EventEmitter {
  pid = 45678;
  stdin = { writes: [] as string[], write: (value: string) => { this.stdin.writes.push(value); return true; } };
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(): boolean { return true; }
}

let child: FakeChild;
let accountId: string;

beforeEach(() => {
  run += 1;
  process.env.LLV_STATE_DIR = path.join(sandbox, `run-${run}`, "state");
  process.env.COPILOT_HOME = path.join(sandbox, `run-${run}`, "legacy-absent");
  child = new FakeChild();
  const account = createManagedCopilotAccount("Local sign-in");
  accountId = account.id;
  fs.writeFileSync(path.join(account.home, "config.json"), '// comment\n{"lastLoggedInUser":{"host":"github.com","login":"fixture-user"},"loggedInUsers":[{"host":"github.com","login":"fixture-user"}]}');
  setCopilotLoginSupervisorForTests(new CopilotLoginSupervisor({
    spawn: () => child,
    signalGroup: (processChild, signal) => { if (processChild.pid !== child.pid) throw new Error("wrong child"); child.signals.push(signal); },
    now: Date.now,
    sleep: async () => undefined,
    setTimeout: () => ({ unref() {} } as NodeJS.Timeout),
    clearTimeout: () => undefined,
  }));
});

afterAll(() => {
  setCopilotLoginSupervisorForTests(null);
  if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
  if (previous.home === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous.home;
  if (previous.bin === undefined) delete process.env.LLV_COPILOT_BIN; else process.env.LLV_COPILOT_BIN = previous.bin;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function post(body: Record<string, unknown>, origin = "http://127.0.0.1") {
  return new NextRequest("http://127.0.0.1/api/accounts/copilot", {
    method: "POST",
    headers: { host: "127.0.0.1", origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("removal probes the CLI after its commit and includes a racing account creation", async () => {
  const leases: boolean[] = [];
  let peer: string | undefined;
  const probe = spyOn(cli, "copilotBinaryGap").mockImplementation(() => {
    leases.push(fs.existsSync(statePath("account-selection.lock")));
    peer ??= createManagedCopilotAccount("Racing account").id;
    return "fixture CLI unavailable";
  });
  try {
    const response = await remove(post({ id: accountId }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.removed.id).toBe(accountId);
    expect(body.accounts.some((account: { id: string }) => account.id === peer)).toBe(true);
    expect(leases).toEqual([false]);
  } finally { probe.mockRestore(); }
});

test("GET reports config auth and the active login operation; POST starts device-code login", async () => {
  const before = await GET();
  const initial = await before.json();
  expect(initial.accounts[0]).toMatchObject({ id: accountId, auth: "signed_in", user: "fixture-user", login: null });

  const startedResponse = await POST(post({ action: "login", id: accountId }));
  expect(startedResponse.status).toBe(200);
  const started = await startedResponse.json();
  expect(started.accounts[0].login).toMatchObject({ phase: "starting", operationId: expect.any(String) });

  child.stdout.emit("data", "To authenticate, visit https://github.com/login/device and enter code XXXX-XXXX");
  const live = await (await GET()).json();
  expect(live.accounts[0].login).toMatchObject({ phase: "awaiting_browser", loginUrl: "https://github.com/login/device", userCode: "XXXX-XXXX" });
});

test("plaintext token storage requires an explicit Accounts-panel choice", async () => {
  const started = await (await POST(post({ action: "login", id: accountId }))).json();
  const operationId = started.accounts[0].login.operationId as string;
  child.stderr.write("System keychain unavailable. Store token in plaintext config file? (y/N)");
  const pending = await (await GET()).json();
  expect(pending.accounts[0].login.phase).toBe("awaiting_storage_choice");
  expect(child.stdin.writes).toEqual([]);

  const accepted = await POST(post({ action: "choose-plaintext-storage", operationId, acceptPlaintext: true }));
  expect(accepted.status).toBe(200);
  expect(child.stdin.writes).toEqual(["y\n"]);
});

test("cross-origin POST is rejected", async () => {
  const response = await POST(post({ action: "login", id: accountId }, "https://other.invalid"));
  expect(response.status).toBe(403);
  expect(child.pid).toBe(45678);
});

test("cancel-login returns 404 for an id the Copilot supervisor does not own", async () => {
  const response = await POST(post({ action: "cancel-login", operationId: "foreign-operation" }));
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: "Copilot login operation was not found" });
});

test("the model endpoint returns the selected account catalogue with auto first", async () => {
  const request = new NextRequest(`http://127.0.0.1/api/accounts/copilot/models?account=${accountId}`, { headers: { host: "127.0.0.1" } });
  const response = await getModels(request);
  const catalog = await response.json();
  expect(response.status).toBe(200);
  expect(catalog).toMatchObject({ accountId, source: "static" });
  expect(catalog.models[0]).toMatchObject({ id: "auto", name: "Auto" });
});

for (const kind of ["local", "foreign", "queued", "timeout"] as const) test(`selection queues catalog admission behind a ${kind} holder`, async () => {
  const { withAccountHolder } = await import("@/lib/accounts/accountMutation.fixture");
  const { ACCOUNT_STORE_BUSY_MESSAGE } = await import("@/lib/accounts/accountMutation");
  const response = await withAccountHolder(kind, () => POST(new NextRequest("http://127.0.0.1/api/accounts/copilot", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "select", id: accountId }),
  })));
  if (kind === "timeout") {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: ACCOUNT_STORE_BUSY_MESSAGE, code: "account_store_busy" });
  } else {
    expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200 });
  }
});
for (const kind of ["local", "foreign", "queued", "timeout"] as const) test(`managed create queues catalog admission behind a ${kind} holder`, async () => {
  const { withAccountHolder } = await import("@/lib/accounts/accountMutation.fixture");
  const { ACCOUNT_STORE_BUSY_MESSAGE } = await import("@/lib/accounts/accountMutation");
  const response = await withAccountHolder(kind, () => POST(new NextRequest("http://127.0.0.1/api/accounts/copilot", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ label: "Contended account" }),
  })));
  if (kind === "timeout") {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: ACCOUNT_STORE_BUSY_MESSAGE, code: "account_store_busy" });
  } else {
    expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200 });
  }
});

function deleteRequest(body: unknown) {
  return new NextRequest("http://127.0.0.1/api/accounts/copilot", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

/* Task d7759de2: Copilot accounts are removed through the same control as
   Claude and Codex ones; history stays readable where it is. */
test("a managed Copilot account is removed: it leaves the list, its sign-in file goes, its transcripts stay readable", async () => {
  const { closeAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { copilotSessionRoots, listCopilotAccounts } = await import("@/lib/accounts/copilot");
  closeAgentRegistryForTests();
  const account = listCopilotAccounts().find((candidate) => candidate.id === accountId)!;
  const transcript = path.join(account.sessionStateDir, "session-one", "events.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{}\n");

  const response = await remove(deleteRequest({ id: accountId }));

  expect(response.status).toBe(200);
  const body = await response.json() as { removed: { id: string }; accounts: { id: string }[]; cleanupPending: boolean };
  expect(body.removed).toEqual({ id: accountId });
  expect(body.cleanupPending).toBe(false);
  expect(body.accounts.map((item) => item.id)).not.toContain(accountId);
  expect(listCopilotAccounts().map((item) => item.id)).not.toContain(accountId);
  expect(fs.existsSync(path.join(account.home, "config.json"))).toBe(false);
  expect(fs.readFileSync(transcript, "utf8")).toBe("{}\n");
  expect(copilotSessionRoots()).toContain(account.sessionStateDir);
  expect((await remove(deleteRequest({ id: accountId }))).status).toBe(404);
  closeAgentRegistryForTests();
});

test("the default Copilot home is only hidden, and a live agent refuses removal by name", async () => {
  const { agentRegistry, closeAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { listCopilotAccounts } = await import("@/lib/accounts/copilot");
  closeAgentRegistryForTests();
  const legacy = path.join(sandbox, `run-${run}`, "legacy-present");
  fs.mkdirSync(path.join(legacy, "session-state"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "config.json"), "{}");
  process.env.COPILOT_HOME = legacy;
  const begun = beginLegacySpawnFixture(agentRegistry(), { engine: "copilot", cwd: "/repo", accountId: accountId });
  if (begun.kind !== "created") throw new Error("expected a launch receipt");

  const refused = await remove(deleteRequest({ id: accountId }));
  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ blockers: ["live_sessions"], sessions: [expect.objectContaining({ conversationId: begun.receipt.conversationId })] });

  const hidden = await remove(deleteRequest({ id: "default" }));
  expect(hidden.status).toBe(200);
  await expect(hidden.json()).resolves.toMatchObject({ removed: { id: "default" }, hidden: { home: legacy } });
  expect(listCopilotAccounts().map((item) => item.id)).toEqual([accountId]);
  expect(fs.readFileSync(path.join(legacy, "config.json"), "utf8")).toBe("{}");
  closeAgentRegistryForTests();
});

test("the hidden Copilot Default is offered back and restored, untouched, through the same route", async () => {
  const { closeAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { listCopilotAccounts } = await import("@/lib/accounts/copilot");
  closeAgentRegistryForTests();
  const legacy = path.join(sandbox, `run-${run}`, "legacy-present");
  fs.mkdirSync(path.join(legacy, "session-state"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "config.json"), "{}");
  process.env.COPILOT_HOME = legacy;
  expect((await remove(deleteRequest({ id: "default" }))).status).toBe(200);
  await expect((await GET()).json()).resolves.toMatchObject({ hidden: [{ id: "default", label: "Default" }] });

  const restored = await POST(post({ action: "restore", id: "default" }));

  expect(restored.status).toBe(200);
  const body = await restored.json() as { restored: { id: string }; accounts: { id: string }[]; hidden: unknown[] };
  expect(body.restored).toEqual({ id: "default" });
  expect(body.accounts.map((item) => item.id)).toEqual(["default", accountId]);
  expect(body.hidden).toEqual([]);
  expect(listCopilotAccounts().map((item) => item.id)).toEqual(["default", accountId]);
  expect(fs.readFileSync(path.join(legacy, "config.json"), "utf8")).toBe("{}");
  // Only the default home is ever restored; a second restore has nothing to show.
  expect((await POST(post({ action: "restore", id: accountId }))).status).toBe(400);
  expect((await POST(post({ action: "restore", id: "default" }))).status).toBe(404);
  closeAgentRegistryForTests();
});
