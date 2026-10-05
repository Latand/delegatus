import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-readiness-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { readTelegramLaunchState, repairTelegramConnection, setTelegramLaunchRepairForTests, telegramOperatorAction, telegramSetUp } = await import("./launchReadiness");
const { resolveTelegramLaunchGrant } = await import("@/lib/runtime/telegramConnectorEnv");
const { productionTelegramConnectorBootPorts, provisionTelegramConnectorAtStartup } = await import("./connectorBoot");
const { procBackend } = await import("@/lib/proc");
const { TELEGRAM_CONNECTOR_TOKEN_ENV } = await import("./sessionStore");
const { clearTelegramConnection, deleteTelegramSession, ensureTelegramStateDir, saveTelegramSession, telegramConnectorTokenPath, telegramSessionPath, writeTelegramConnection } = await import("./sessionStore");
type StoredTelegramConnection = import("./sessionStore").StoredTelegramConnection;

afterAll(() => {
  setTelegramLaunchRepairForTests(null);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  setTelegramLaunchRepairForTests(null);
  fs.rmSync(path.join(sandbox, "state", "telegram"), { recursive: true, force: true });
});

function record(status: StoredTelegramConnection["status"], credentialRef: string | null, errorCode: StoredTelegramConnection["errorCode"] = null): void {
  writeTelegramConnection({ version: 1, status, credentialRef, identity: null, lastHealthCheckAt: null, errorCode, identityIdUpgradedAt: null });
}

function signIn() {
  return saveTelegramSession("placeholder-session-for-readiness-test");
}

/** The record a connector leaves behind when the Viewer that started it is
    gone: a file naming a process that no longer exists. */
function recordGoneConnector(credentialRef: string): void {
  const directory = ensureTelegramStateDir(true)!;
  fs.writeFileSync(path.join(directory, "connector.json"), JSON.stringify({
    version: 1, pid: 2_000_000_000, identity: "gone", credentialRef,
    connectorTokenSha256: "0".repeat(64), command: "python", entrypoint: "server.py",
  }), { mode: 0o600 });
}

test("an installation that never connected Telegram is not set up", () => {
  expect(readTelegramLaunchState()).toEqual({ kind: "not_set_up" });
  expect(telegramSetUp()).toBe(false);
  expect(telegramOperatorAction()).toBeNull();
});

test("a signed-out installation is not set up", () => {
  const session = signIn();
  record("connected", session.credentialRef);
  deleteTelegramSession();
  record("disconnected", null);
  expect(readTelegramLaunchState()).toEqual({ kind: "not_set_up" });
});

test("a first login that failed before any credential was stored is not set up", () => {
  record("error", null, "credentials_missing");
  expect(readTelegramLaunchState()).toEqual({ kind: "not_set_up" });
});

test("a connected record for the stored credential is ready and carries the token", () => {
  const session = signIn();
  record("connected", session.credentialRef);
  expect(readTelegramLaunchState()).toEqual({ kind: "ready", token: session.connectorToken });
  expect(telegramOperatorAction()).toBeNull();
});

test("a connected record whose recorded connector process is gone is recoverable", () => {
  const session = signIn();
  record("connected", session.credentialRef);
  recordGoneConnector(session.credentialRef);
  expect(readTelegramLaunchState()).toEqual({ kind: "recoverable" });
  /* Nothing is asked of the operator: the next launch restarts it. */
  expect(telegramOperatorAction()).toBeNull();
});

test("a record that names an earlier credential is recoverable", () => {
  const first = signIn();
  record("connected", first.credentialRef);
  fs.rmSync(telegramSessionPath());
  fs.rmSync(telegramConnectorTokenPath());
  signIn();
  expect(readTelegramLaunchState()).toEqual({ kind: "recoverable" });
});

test("a stored credential with no published record is recoverable", () => {
  signIn();
  clearTelegramConnection();
  expect(readTelegramLaunchState()).toEqual({ kind: "recoverable" });
  expect(telegramOperatorAction()).toBeNull();
});

test("a failed health check over a stored credential is recoverable, and the operator is told once a repair here has failed", async () => {
  const session = signIn();
  record("error", session.credentialRef, "connector_failed");
  expect(readTelegramLaunchState()).toEqual({ kind: "recoverable" });
  /* The next start repairs it by itself, so nothing is asked yet. */
  expect(telegramOperatorAction()).toBeNull();
  setTelegramLaunchRepairForTests({ healthCheck: async () => {} });
  await repairTelegramConnection();
  expect(telegramOperatorAction()).toBe("check");
});

test("a live process the record cannot vouch for needs a restart, and no launch waits for a check", async () => {
  const session = signIn();
  record("error", session.credentialRef, "bridge_failed");
  const directory = ensureTelegramStateDir(true)!;
  fs.writeFileSync(path.join(directory, "connector.json"), JSON.stringify({
    version: 1, pid: process.pid, identity: procBackend.processIdentity(process.pid), credentialRef: session.credentialRef,
    connectorTokenSha256: "0".repeat(64), command: "python", entrypoint: "telegram-mcp-server.py",
  }), { mode: 0o600 });
  let checks = 0;
  setTelegramLaunchRepairForTests({ healthCheck: async () => { checks += 1; } });
  const restart = { kind: "needs_operator" as const, action: "restart" as const };
  expect(readTelegramLaunchState()).toEqual(restart);
  await expect(repairTelegramConnection()).resolves.toEqual(restart);
  expect(checks).toBe(0);
  expect(telegramOperatorAction()).toBe("restart");
});

test("a session Telegram ended needs the operator to sign in", () => {
  const session = signIn();
  record("expired", session.credentialRef);
  expect(readTelegramLaunchState()).toEqual({ kind: "needs_operator", action: "sign_in" });
  expect(telegramSetUp()).toBe(true);
  expect(telegramOperatorAction()).toBe("sign_in");
});

test("a record whose credential file is gone needs the operator to sign in", () => {
  const session = signIn();
  record("connected", session.credentialRef);
  fs.rmSync(telegramSessionPath());
  expect(readTelegramLaunchState()).toEqual({ kind: "needs_operator", action: "sign_in" });
});

test("a credential whose connector token is missing or widened is never repaired by a launch", () => {
  const session = signIn();
  record("connected", session.credentialRef);
  fs.rmSync(telegramConnectorTokenPath());
  expect(readTelegramLaunchState()).toEqual({ kind: "needs_operator", action: "check" });
  fs.writeFileSync(telegramConnectorTokenPath(), session.connectorToken + "\n", { mode: 0o644 });
  fs.chmodSync(telegramConnectorTokenPath(), 0o644);
  expect(readTelegramLaunchState()).toEqual({ kind: "needs_operator", action: "check" });
});

test("a repair runs the health check once for concurrent launches and returns the restored state", async () => {
  const session = signIn();
  record("error", session.credentialRef, "connector_failed");
  let checks = 0;
  setTelegramLaunchRepairForTests({
    healthCheck: async () => {
      checks += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      record("connected", session.credentialRef);
    },
  });
  const states = await Promise.all([repairTelegramConnection(), repairTelegramConnection(), repairTelegramConnection()]);
  expect(checks).toBe(1);
  const ready = { kind: "ready" as const, token: session.connectorToken };
  expect(states).toEqual([ready, ready, ready]);
  /* A connection that is ready is never touched. */
  await repairTelegramConnection();
  expect(checks).toBe(1);
});

test("a repair that outlives its wait lets the launch go on without the tool", async () => {
  const session = signIn();
  record("error", session.credentialRef, "connector_failed");
  let release: () => void = () => {};
  setTelegramLaunchRepairForTests({
    healthCheck: () => new Promise<void>((resolve) => { release = resolve; }),
    waitMs: 30,
  });
  const started = performance.now();
  await expect(repairTelegramConnection()).resolves.toEqual({ kind: "recoverable" });
  expect(performance.now() - started).toBeLessThan(2_000);
  release();
});

test("after a repair that failed, the launches of the cooldown do not repeat it", async () => {
  const session = signIn();
  record("error", session.credentialRef, "connector_failed");
  let checks = 0;
  let now = 1_000_000;
  setTelegramLaunchRepairForTests({ healthCheck: async () => { checks += 1; }, now: () => now, cooldownMs: 60_000 });
  await repairTelegramConnection();
  await repairTelegramConnection();
  expect(checks).toBe(1);
  now += 60_001;
  await repairTelegramConnection();
  expect(checks).toBe(2);
});

test("a state that needs the operator, or is not set up, is never repaired", async () => {
  let checks = 0;
  setTelegramLaunchRepairForTests({ healthCheck: async () => { checks += 1; } });
  await expect(repairTelegramConnection()).resolves.toEqual({ kind: "not_set_up" });
  const session = signIn();
  record("expired", session.credentialRef);
  await expect(repairTelegramConnection()).resolves.toEqual({ kind: "needs_operator", action: "sign_in" });
  expect(checks).toBe(0);
});

test("a health check that throws is contained and the launch goes on", async () => {
  const session = signIn();
  record("error", session.credentialRef, "connector_failed");
  setTelegramLaunchRepairForTests({ healthCheck: async () => { throw new Error("connector spawn failed"); } });
  await expect(repairTelegramConnection()).resolves.toEqual({ kind: "recoverable" });
});

/* ── `ready` while a health check is under way ─────────────────────────────── */

/** State 12 as a health check finds it and as it leaves it half-way: the
    record reads connected, the stale process record is already removed and the
    replacement is not verified yet. `finish` ends the check. */
function replacingConnector(session: { credentialRef: string }, outcome: "connected" | "error") {
  const check = { checks: 0, finished: false, finish: () => {} };
  record("connected", session.credentialRef);
  recordGoneConnector(session.credentialRef);
  const healthCheck = async () => {
    check.checks += 1;
    fs.rmSync(path.join(ensureTelegramStateDir(true)!, "connector.json"));
    await new Promise<void>((resolve) => { check.finish = resolve; });
    if (outcome === "error") record("error", session.credentialRef, "connector_failed");
    check.finished = true;
  };
  return { check, healthCheck };
}

test("a launch that arrives while a check replaces the connector waits for it and starts with the tool", async () => {
  const session = signIn();
  const { check, healthCheck } = replacingConnector(session, "connected");
  setTelegramLaunchRepairForTests({ healthCheck, waitMs: 2_000 });
  const first = repairTelegramConnection();
  await new Promise((resolve) => setTimeout(resolve, 50));
  /* The record reads connected and names no dead process: on its own it would
     pass for ready. */
  expect(readTelegramLaunchState().kind).toBe("ready");
  let secondSettled = false;
  const second = repairTelegramConnection().then((state) => { secondSettled = true; return state; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(secondSettled).toBe(false);
  check.finish();
  const ready = { kind: "ready" as const, token: session.connectorToken };
  await expect(second).resolves.toEqual(ready);
  await expect(first).resolves.toEqual(ready);
  expect(check.finished).toBe(true);
  expect(check.checks).toBe(1);
});

test("when that check ends in an error the waiting launch starts without the tool and the agent is told", async () => {
  const session = signIn();
  const { check, healthCheck } = replacingConnector(session, "error");
  setTelegramLaunchRepairForTests({ healthCheck, waitMs: 2_000 });
  const first = repairTelegramConnection();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = resolveTelegramLaunchGrant({ NODE_ENV: "test" }, ["viewer", "telegram"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  check.finish();
  const grant = await second;
  await first;
  expect(grant.unavailable).toBe(true);
  expect(grant.mcpServers).toEqual(["viewer"]);
  expect(grant.env[TELEGRAM_CONNECTOR_TOKEN_ENV]).toBeUndefined();
  /* The failure is the first launch's; the second does not repeat it. */
  expect(check.checks).toBe(1);
  expect(telegramOperatorAction()).toBe("check");
});

test("a launch joins the check the start of the Viewer began", async () => {
  const session = signIn();
  const { check, healthCheck } = replacingConnector(session, "connected");
  setTelegramLaunchRepairForTests({ healthCheck, waitMs: 2_000 });
  const boot = provisionTelegramConnectorAtStartup({ ...productionTelegramConnectorBootPorts, log: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  let launched = false;
  const launch = resolveTelegramLaunchGrant({ NODE_ENV: "test" }, ["viewer", "telegram"]).then((grant) => { launched = true; return grant; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(launched).toBe(false);
  check.finish();
  const grant = await launch;
  expect(check.finished).toBe(true);
  expect(grant.unavailable).toBe(false);
  expect(grant.env[TELEGRAM_CONNECTOR_TOKEN_ENV]).toBe(session.connectorToken);
  await expect(boot).resolves.toBe("provisioned");
  expect(check.checks).toBe(1);
});

test("a check that outlives the launch's wait is not waited out, and its unconfirmed record carries no token", async () => {
  const session = signIn();
  const { check, healthCheck } = replacingConnector(session, "connected");
  setTelegramLaunchRepairForTests({ healthCheck, waitMs: 40 });
  const first = repairTelegramConnection();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = performance.now();
  const grant = await resolveTelegramLaunchGrant({ NODE_ENV: "test" }, ["viewer", "telegram"]);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(check.finished).toBe(false);
  expect(grant.unavailable).toBe(true);
  expect(grant.env[TELEGRAM_CONNECTOR_TOKEN_ENV]).toBeUndefined();
  await expect(first).resolves.toEqual({ kind: "recoverable" });
  /* The launches that follow do not wait for the same check again. */
  const again = performance.now();
  await expect(repairTelegramConnection()).resolves.toEqual({ kind: "recoverable" });
  expect(performance.now() - again).toBeLessThan(30);
  check.finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(repairTelegramConnection()).resolves.toEqual({ kind: "ready", token: session.connectorToken });
});
