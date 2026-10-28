import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudEnvironmentController, cloudEnvironmentControllerPorts } from "./cloudEnvironmentController";
import { stubCloudBackend } from "@/lib/pipelines/cloudEnvironment.fixture";
import { openCloudEnvironmentBackend } from "@/lib/pipelines/cloudEnvironmentClient";
import { prepareCloudEnvironment, readCloudEnvironmentBindings } from "./codexCloudEnvironments";

const old = process.env.LLV_STATE_DIR; const roots: string[] = [], cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); process.env.LLV_STATE_DIR = old; });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-controller-")); roots.push(root); process.env.LLV_STATE_DIR = root;
  const backend = stubCloudBackend(); cleanups.push(backend.stop);
  const ports = cloudEnvironmentControllerPorts();
  const catalog = [{ project: "repo-fixture", smt: 0, conversations: 1 }];
  ports.catalog = () => catalog;
  ports.accounts = () => ["account-a", "account-b"].map(id => ({ id, kind: "managed" as const, label: id, home: root, sessionsDir: root, authPresent: true, loginPane: null, createdAt: 0 }));
  ports.remote = () => "https://github.com/sample/project.git";
  ports.allowed = () => true;
  ports.resolve = (_project, accountId) => ({ kind: "available", account: { engine: "codex", accountId, kind: "managed", home: root, transcriptRoot: root, env: {} } });
  ports.backend = input => openCloudEnvironmentBackend(input, backend.dependencies);
  ports.prepare = input => prepareCloudEnvironment(input, backend.dependencies);
  const controller = () => { const value = new CloudEnvironmentController(ports); cleanups.push(() => value.stop()); return value; };
  return { ports, backend, controller };
}
test("background preparation resumes its persisted account cursor after controller replacement", async () => {
  const f = fixture();
  const first = f.controller(); await first.pass(); first.stop();
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => r.accountId)).toEqual(["account-a"]);
  const second = f.controller(); await second.pass(); second.stop();
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => r.accountId)).toEqual(["account-a", "account-b"]);
});
test("automatic preparation keeps out-of-pool accounts off the provider and demotion stops held dispatch", async () => {
  const f = fixture(); f.ports.allowed = () => false;
  const denied = f.controller(); await denied.pass(); denied.stop();
  expect(f.backend.calls).toHaveLength(0);
  f.ports.allowed = () => true;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const originalBackend = f.ports.backend;
  f.ports.backend = async input => { entered(); await held; return originalBackend(input); };
  const demoted = f.controller(); const work = demoted.pass();
  await started; demoted.stop(); release(); await work;
  expect(f.backend.calls).toHaveLength(0);
  expect(readCloudEnvironmentBindings("repo-fixture").bindings).toEqual([]);
});

test("a recovered repository lookup retires its unresolved-ref marker and returns to ready cadence", async () => {
  const f = fixture(), accounts = f.ports.accounts;
  f.ports.accounts = () => accounts().slice(0, 1);
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 28));
  const originalFetch = f.backend.dependencies.fetch;
  f.backend.dependencies.fetch = async () => Response.json({ error: { code: "github_connector_not_configured" } }, { status: 403 });
  try {
    const first = f.controller(); await first.pass(); first.stop();
    expect(readCloudEnvironmentBindings("repo-fixture").bindings[0]).toMatchObject({ ref: "", state: "unavailable" });
    f.backend.dependencies.fetch = originalFetch; clock.mockReturnValue(Date.UTC(2026, 9, 28) + 16 * 60_000);
    const recovered = f.controller(); await recovered.pass(); await recovered.pass(); recovered.stop();
    expect(readCloudEnvironmentBindings("repo-fixture").bindings).toHaveLength(1);
    expect(readCloudEnvironmentBindings("repo-fixture").bindings[0]).toMatchObject({ ref: "main", state: "ready" });
  } finally { clock.mockRestore(); }
});
