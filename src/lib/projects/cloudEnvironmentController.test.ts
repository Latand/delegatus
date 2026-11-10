import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudEnvironmentController, cloudEnvironmentControllerPorts } from "./cloudEnvironmentController";
import { stubCloudBackend } from "@/lib/pipelines/cloudEnvironment.fixture";
import { openCloudEnvironmentBackend } from "@/lib/pipelines/cloudEnvironmentClient";
import { createHostedCloudStageClient } from "@/lib/pipelines/cloudHostedClient";
import { clearCloudEnvironmentDemands } from "./cloudEnvironmentDemand";
import { prepareCloudEnvironment, readCloudEnvironmentBindings } from "./codexCloudEnvironments";

const old = process.env.LLV_STATE_DIR; const roots: string[] = [], cleanups: (() => void)[] = [];
afterEach(() => { clearCloudEnvironmentDemands(); for (const cleanup of cleanups.splice(0)) cleanup(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); process.env.LLV_STATE_DIR = old; });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-controller-")); roots.push(root); process.env.LLV_STATE_DIR = root;
  const backend = stubCloudBackend(); cleanups.push(backend.stop);
  const ports = cloudEnvironmentControllerPorts();
  const catalog = [{ project: "repo-fixture", smt: 0, conversations: 1 }];
  ports.catalog = () => catalog;
  ports.accounts = () => ["account-a", "account-b"].map(id => ({ id, kind: "managed" as const, label: id, home: root, sessionsDir: root, authPresent: true, loginPane: null, createdAt: 0 }));
  ports.remote = () => "https://github.com/sample/project.git";
  ports.allowed = () => true;
  ports.resolve = (_project, accountId) => ({ kind: "available", account: { engine: "codex", accountId, kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" as const } } });
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

test("an idle pass writes no cursor, and a pair that fails is passed over on the next tick", async () => {
  const f = fixture(); f.ports.allowed = () => false;
  const cursorWrites = () => rename.mock.calls.filter(call => path.basename(String(call[1])) === "cloud-environment-cursor.json").length;
  const rename = spyOn(fs, "renameSync"); cleanups.push(() => rename.mockRestore());
  const idle = f.controller(); await idle.pass(); await idle.pass(); idle.stop();
  expect(cursorWrites()).toBe(0);
  f.ports.allowed = () => { throw new Error("binding read failed"); };
  const errors = spyOn(console, "error").mockImplementation(() => undefined); cleanups.push(() => errors.mockRestore());
  const failing = f.controller(); await failing.pass();
  f.ports.allowed = () => true;
  await failing.pass(); failing.stop();
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => r.accountId)).toEqual(["account-b"]);
  expect(cursorWrites()).toBe(1);
  expect(JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "cloud-environment-cursor.json"), "utf8")).after).toBe("repo-fixture\0account-b");
});

/** Both accounts fail their repository lookup and settle as unavailable. */
async function unavailablePairs() {
  const f = fixture(), start = Date.UTC(2026, 9, 28);
  const clock = spyOn(Date, "now").mockReturnValue(start); cleanups.push(() => clock.mockRestore());
  const sessions: string[] = [], openBackend = f.ports.backend;
  f.ports.backend = input => { sessions.push(input.account.accountId); return openBackend(input); };
  const healthyFetch = f.backend.dependencies.fetch;
  f.backend.dependencies.fetch = async () => Response.json({ error: { code: "github_connector_not_configured" } }, { status: 403 });
  const controller = f.controller(); await controller.pass(); await controller.pass();
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => [r.accountId, r.state])).toEqual([["account-a", "unavailable"], ["account-b", "unavailable"]]);
  expect(sessions).toEqual(["account-a", "account-b"]);
  return { f, controller, sessions, clock, start, recover: () => { f.backend.dependencies.fetch = healthyFetch; } };
}

test("an unavailable binding is not retried by time alone", async () => {
  const { controller, sessions, clock, start } = await unavailablePairs();
  for (const minutes of [16, 31, 60, 6 * 60, 24 * 60, 3 * 24 * 60]) {
    clock.mockReturnValue(start + minutes * 60_000);
    for (let tick = 0; tick < 4; tick++) await controller.pass();
  }
  expect(sessions).toEqual(["account-a", "account-b"]);
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => r.retries)).toEqual([1, 1]);
});

test("an unavailable binding is retried when a pipeline stage needs its environment", async () => {
  const { f, controller, sessions, clock, start, recover } = await unavailablePairs();
  clock.mockReturnValue(start + 60 * 60_000);
  for (let tick = 0; tick < 4; tick++) await controller.pass();
  recover();
  const account = f.ports.resolve("repo-fixture", "account-b");
  if (account.kind !== "available") throw new Error("unreachable");
  const stage = await createHostedCloudStageClient(f.backend.dependencies).prepareEnvironment!({ project: "repo-fixture", account: account.account,
    repository: "sample/project", ref: "main", signal: new AbortController().signal, assertCurrent: () => {} });
  expect(stage.state).toBe("ready");
  await controller.pass();
  /* The stage's pair is served first, and the other pair stays untouched. */
  expect(sessions).toEqual(["account-a", "account-b", "account-b"]);
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => [r.accountId, r.ref, r.state]))
    .toEqual([["account-a", "", "unavailable"], ["account-b", "main", "ready"]]);
});

test("a new release looks once at a binding the previous one had stopped retrying", async () => {
  const { f, sessions, clock, start, recover } = await unavailablePairs();
  clock.mockReturnValue(start + 60 * 60_000); recover();
  const next = f.controller(); await next.pass(); await next.pass(); next.stop();
  expect(sessions).toEqual(["account-a", "account-b", "account-a", "account-b"]);
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => [r.accountId, r.ref, r.state]))
    .toEqual([["account-a", "main", "ready"], ["account-b", "main", "ready"]]);
});

test("a sign-in change retries an unavailable binding", async () => {
  const { f, controller, sessions, clock, start } = await unavailablePairs();
  clock.mockReturnValue(start + 60 * 60_000);
  for (let tick = 0; tick < 4; tick++) await controller.pass();
  expect(sessions).toHaveLength(2);
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "auth.json"), "{}");
  for (let tick = 0; tick < 4; tick++) await controller.pass();
  expect(sessions).toEqual(["account-a", "account-b", "account-a", "account-b"]);
  void f;
});

test("with nothing due the controller stops reading bindings and writes nothing", async () => {
  const f = fixture(), start = Date.UTC(2026, 9, 28);
  const clock = spyOn(Date, "now").mockReturnValue(start); cleanups.push(() => clock.mockRestore());
  const controller = f.controller(); await controller.pass(); await controller.pass();
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => r.state)).toEqual(["ready", "ready"]);
  let reads = 0; const read = f.ports.read;
  f.ports.read = (...args) => { reads++; return read(...args); };
  const writes = spyOn(fs, "renameSync"); cleanups.push(() => writes.mockRestore());
  const before = readCloudEnvironmentBindings("repo-fixture").bindings.map(r => r.revision);
  for (let tick = 0; tick < 2; tick++) await controller.pass();
  expect(reads).toBe(2);
  clock.mockReturnValue(start + 5 * 60_000);
  for (let tick = 0; tick < 20; tick++) await controller.pass();
  expect(reads).toBe(2);
  expect(writes.mock.calls).toHaveLength(0);
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => r.revision)).toEqual(before);
  /* A ready binding is still revalidated when its day ends. */
  const sessions: string[] = [], openBackend = f.ports.backend;
  f.ports.backend = input => { sessions.push(input.account.accountId); return openBackend(input); };
  clock.mockReturnValue(start + 24 * 60 * 60_000 + 1000);
  for (let tick = 0; tick < 3; tick++) await controller.pass();
  expect(sessions).toEqual(["account-a", "account-b"]);
});
