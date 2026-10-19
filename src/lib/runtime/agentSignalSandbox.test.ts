import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity, systemBootEpoch } from "@/lib/processIdentity";
import { codexHostColumns, claudeHostColumns, copilotHostColumns } from "./registry";
import { normalizeAgentSignalDomain, type AgentSignalDomain } from "./agentSignalSandbox";
import type { HostState } from "./engineHost";
import { Database } from "bun:sqlite";
import { cpuOwnerExited, cpuOwnerStatus } from "./signalSandboxContext";

test.skipIf(process.platform !== "linux")("a missing namespace marker never proves an unseen namespace's queue owner dead", () => {
  const current = captureProcessIdentity(process.pid);
  const foreign = { ...current, pid: 99999999, bootEpoch: current.bootEpoch!.replace(/pid:\[\d+\]$/, "pid:[99999999]") };
  expect(cpuOwnerStatus(foreign, { NODE_ENV: "test" })).toBe("unverified");
  expect(cpuOwnerExited(foreign, { NODE_ENV: "test" })).toBeFalse();
});

function domain(): AgentSignalDomain {
  const identity = (pid: number) => ({ pid, startIdentity: `${pid}:100`, bootEpoch: systemBootEpoch() });
  return { policyVersion: 1, monitor: identity(51001), bubblewrap: identity(51004), init: identity(51002), native: identity(51003),
    pidNamespace: "pid:[4026000001]", userNamespace: "user:[4026000002]", scope: "/isolated/agent.scope", directory: "/scratch/invocation" };
}

const engines: Array<"codex" | "claude" | "copilot"> = ["codex", "claude", "copilot"];
test.each(engines.flatMap(engine => (["off", "sqlite"] as const).map(mode => [engine, mode] as const)))("signal identities survive the actual registry writer and restart: %s %s", (engine, mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-registry-"));
  const file = path.join(root, "registry.json");
  const storage = { sqliteMode: mode, sqliteFilename: path.join(root, "registry.sqlite") };
  const store = new AgentRegistry(file, () => false, undefined, storage);
  const signalDomain = domain();
  const key = { engine, sessionId: "signal-registry-fixture" };
  const state: HostState = { signalDomain, status: "idle", sessionKey: key.sessionId,
    endpoint: `stdio:${signalDomain.native.pid}`, pid: signalDomain.native.pid, processStartIdentity: signalDomain.native.startIdentity,
    eventCursor: 0, protocolVersion: "fixture", activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null };
  try {
    store.upsert({ key, artifactPath: "/sessions/fixture.jsonl", cwd: "/repo", accountId: null,
      status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    const columns = engine === "codex" ? codexHostColumns(state, 0) : engine === "claude" ? claudeHostColumns(state, 0) : copilotHostColumns(state, 0);
    store.setStructuredHost(key, columns);
    expect(() => store.setStructuredHost(key, null)).toThrow("must be retired");
    expect(() => store.upsert({ ...store.readOnlySnapshot().entries[`${engine}:${key.sessionId}`]!, structuredHost: null })).toThrow("must be retired");
    const reopened = new AgentRegistry(file, () => false, undefined, storage);
    try {
      const retained = reopened.readOnlySnapshot().entries[`${engine}:${key.sessionId}`]!.structuredHost!.signalDomain!;
      expect(retained).toEqual(signalDomain);
      expect(normalizeAgentSignalDomain(retained)).toEqual(signalDomain);
    }
    finally { reopened.close(); }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SQLite refuses an older writer dropping active domain authority and permits a proven retired row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-rollback-"));
  const filename = path.join(root, "registry.sqlite");
  const store = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: filename });
  const key = { engine: "codex" as const, sessionId: "rollback-fixture" };
  const signalDomain = domain();
  const columns = { kind: "codex-app-server" as const, endpoint: "stdio:fixture", process: signalDomain.native, eventCursor: 0,
    protocolVersion: "fixture", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [], signalDomain };
  store.upsert({ key, artifactPath: "/sessions/rollback.jsonl", cwd: "/repo", accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  store.setStructuredHost(key, columns);
  const raw = new Database(filename);
  const row = "codex:rollback-fixture";
  try {
    expect(() => raw.run("UPDATE registry_rows SET value_json=json_remove(value_json,'$.structuredHost.signalDomain') WHERE collection='entries' AND row_key=?", [row])).toThrow("requires a current reader");
    expect(() => raw.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost',NULL) WHERE collection='entries' AND row_key=?", [row])).toThrow("requires a current reader");
    expect(() => raw.run("DELETE FROM registry_rows WHERE collection='entries' AND row_key=?", [row])).toThrow("requires a current reader");
    expect(store.readOnlySnapshot().entries[row]!.structuredHost!.signalDomain).toEqual(signalDomain);
    expect(store.terminateStructuredHost(key)).toBeTrue();
    expect(store.readOnlySnapshot().entries[row]!.structuredHost!.signalDomain?.retired).toBeTrue();
    expect(() => raw.run("UPDATE registry_rows SET value_json=json_remove(value_json,'$.structuredHost.signalDomain') WHERE collection='entries' AND row_key=?", [row])).not.toThrow();
  } finally { raw.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy rows are distinguishable and malformed namespace authority refuses normalization", () => {
  expect(normalizeAgentSignalDomain(undefined)).toBeUndefined();
  for (const changed of [{ policyVersion: 2 }, { init: { pid: 51002, startIdentity: null } }, { scope: "/../other.scope" }, { pidNamespace: "unavailable" }]) {
    expect(() => normalizeAgentSignalDomain({ ...domain(), ...changed })).toThrow("malformed or unsupported");
  }
});
