import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-readiness-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { readTelegramLaunchState, repairTelegramConnection, setTelegramLaunchRepairForTests, telegramOperatorAction, telegramSetUp } = await import("./launchReadiness");
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

test("a failed health check over a stored credential is recoverable, and the operator is told meanwhile", () => {
  const session = signIn();
  record("error", session.credentialRef, "connector_failed");
  expect(readTelegramLaunchState()).toEqual({ kind: "recoverable" });
  expect(telegramOperatorAction()).toBe("check");
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
