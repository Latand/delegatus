import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudEnvironmentController, cloudEnvironmentControllerPorts } from "./cloudEnvironmentController";
import { stubCloudBackend } from "@/lib/pipelines/cloudEnvironment.fixture";
import { openCloudEnvironmentBackend } from "@/lib/pipelines/cloudEnvironmentClient";
import { createHostedCloudStageClient } from "@/lib/pipelines/cloudHostedClient";
import { clearCloudEnvironmentDemands, demandCloudEnvironment } from "./cloudEnvironmentDemand";
import { prepareCloudEnvironment, readCloudEnvironmentBindings, setCloudEnvironmentOverride } from "./codexCloudEnvironments";

const old = process.env.LLV_STATE_DIR; const roots: string[] = [], cleanups: (() => void)[] = [];
afterEach(() => { clearCloudEnvironmentDemands(); for (const cleanup of cleanups.splice(0)) cleanup(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); process.env.LLV_STATE_DIR = old; });
function fixture(accountIds = ["account-a", "account-b"], projects = ["repo-fixture"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-controller-")); roots.push(root); process.env.LLV_STATE_DIR = root;
  const backend = stubCloudBackend(); cleanups.push(backend.stop);
  const ports = cloudEnvironmentControllerPorts();
  let catalog = projects.map(project => ({ project, smt: 0, conversations: 1 }));
  ports.catalog = () => catalog;
  ports.accounts = () => accountIds.map(id => ({ id, kind: "managed" as const, label: id, home: root, sessionsDir: root, authPresent: true, loginPane: null, createdAt: 0 }));
  ports.remote = () => "https://github.com/sample/project.git";
  ports.allowed = () => true;
  ports.resolve = (_project, accountId) => ({ kind: "available", account: { engine: "codex", accountId, kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" as const } } });
  const sessions: string[] = [];
  ports.backend = input => { sessions.push(input.account.accountId); return openCloudEnvironmentBackend(input, backend.dependencies); };
  ports.prepare = input => prepareCloudEnvironment(input, backend.dependencies);
  const controller = () => { const value = new CloudEnvironmentController(ports); cleanups.push(() => value.stop()); return value; };
  const start = Date.UTC(2026, 9, 28);
  /** Freeze the clock at `start`; the returned setter moves it by an offset. */
  const freeze = () => { const clock = spyOn(Date, "now").mockReturnValue(start); cleanups.push(() => clock.mockRestore()); return (offset: number) => { clock.mockReturnValue(start + offset); }; };
  const healthyFetch = backend.dependencies.fetch;
  return { ports, backend, controller, sessions, root, start, freeze,
    setCatalog: (names: string[]) => { catalog = names.map(project => ({ project, smt: 0, conversations: 1 })); },
    refuse: () => { backend.dependencies.fetch = async () => Response.json({ error: { code: "github_connector_not_configured" } }, { status: 403 }); },
    recover: () => { backend.dependencies.fetch = healthyFetch; } };
}
const MINUTE = 60_000, HOUR = 60 * MINUTE;
const bindings = () => readCloudEnvironmentBindings("repo-fixture").bindings.map(r => [r.accountId, r.ref, r.state, r.retries]);
async function passes(controller: CloudEnvironmentController, count: number) { for (let tick = 0; tick < count; tick++) await controller.pass(); }
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

/** Both accounts fail their repository lookup until the failure budget is
 * spent: three sessions each inside the first minute, then unavailable. */
async function unavailablePairs() {
  const f = fixture(), at = f.freeze();
  f.refuse();
  const controller = f.controller();
  for (let seconds = 0; seconds <= 30; seconds += 2) { at(seconds * 1000); await passes(controller, 2); }
  expect(bindings()).toEqual([["account-a", "", "unavailable", 3], ["account-b", "", "unavailable", 3]]);
  expect(f.sessions.filter(id => id === "account-a")).toHaveLength(3);
  expect(f.sessions).toHaveLength(6);
  f.sessions.length = 0;
  return { f, controller, sessions: f.sessions, at };
}

test("an unavailable binding is not retried by time alone", async () => {
  const { controller, sessions, at } = await unavailablePairs();
  for (const minutes of [16, 31, 60, 6 * 60, 24 * 60, 3 * 24 * 60]) { at(minutes * MINUTE); await passes(controller, 4); }
  expect(sessions).toEqual([]);
  expect(bindings().map(row => row[3])).toEqual([3, 3]);
});

test("an unavailable binding is retried when a pipeline stage needs its environment", async () => {
  const { f, controller, sessions, at } = await unavailablePairs();
  at(HOUR); await passes(controller, 4);
  f.recover();
  const account = f.ports.resolve("repo-fixture", "account-b");
  if (account.kind !== "available") throw new Error("unreachable");
  const stage = await createHostedCloudStageClient(f.backend.dependencies).prepareEnvironment!({ project: "repo-fixture", account: account.account,
    repository: "sample/project", ref: "main", signal: new AbortController().signal, assertCurrent: () => {} });
  expect(stage.state).toBe("ready");
  await controller.pass();
  /* The stage's pair is served first, and the other pair stays untouched. */
  expect(sessions).toEqual(["account-b"]);
  expect(bindings()).toEqual([["account-a", "", "unavailable", 3], ["account-b", "main", "ready", 0]]);
});

test("a new release looks once at a binding the previous one had stopped retrying", async () => {
  const { f, sessions, at } = await unavailablePairs();
  at(HOUR); f.recover();
  const next = f.controller(); await passes(next, 2); next.stop();
  expect(sessions).toEqual(["account-a", "account-b"]);
  expect(bindings()).toEqual([["account-a", "main", "ready", 0], ["account-b", "main", "ready", 0]]);
});

test("a trigger that arrives inside the cooldown is served once when the cooldown ends", async () => {
  const { f, controller, sessions, at } = await unavailablePairs();
  f.recover();
  /* Five minutes after the last failure: a new release's first look at
     account-a, and a stage's demand for account-b on the running one. */
  at(5 * MINUTE);
  const next = f.controller(); await passes(next, 4);
  demandCloudEnvironment("repo-fixture", "account-b");
  await passes(next, 4);
  expect(sessions).toEqual([]);
  at(17 * MINUTE); await passes(next, 6);
  expect(sessions.toSorted()).toEqual(["account-a", "account-b"]);
  expect(bindings()).toEqual([["account-a", "main", "ready", 0], ["account-b", "main", "ready", 0]]);
  for (const minutes of [40, 120, 600]) { at(minutes * MINUTE); await passes(next, 6); }
  expect(sessions).toHaveLength(2);
  void controller;
});

test("a sign-in change retries an unavailable binding within a fresh failure budget", async () => {
  const { controller, sessions, at } = await unavailablePairs();
  at(HOUR); await passes(controller, 4);
  expect(sessions).toEqual([]);
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "auth.json"), "{}");
  for (let seconds = 0; seconds <= 30; seconds += 2) { at(HOUR + seconds * 1000); await passes(controller, 2); }
  expect(sessions.filter(id => id === "account-a")).toHaveLength(3);
  expect(sessions).toHaveLength(6);
  at(3 * HOUR); await passes(controller, 6);
  expect(sessions).toHaveLength(6);
});

test("a short failure of the default-branch lookup is retried inside its window", async () => {
  const f = fixture(["account-a"]), at = f.freeze();
  f.backend.dependencies.fetch = async () => { throw new TypeError("fetch failed"); };
  const errors = spyOn(console, "error").mockImplementation(() => undefined); cleanups.push(() => errors.mockRestore());
  const controller = f.controller(); await controller.pass();
  expect(bindings()).toEqual([["account-a", "", "unavailable", 1]]);
  f.recover();
  at(1000); await passes(controller, 3);
  expect(f.sessions).toHaveLength(1);
  at(3000); await passes(controller, 3);
  expect(f.sessions).toHaveLength(2);
  expect(bindings()).toEqual([["account-a", "main", "ready", 0]]);
});

test("another ref's binding never makes the pair due", async () => {
  const f = fixture(["account-a"]), at = f.freeze();
  const controller = f.controller(); await controller.pass();
  expect(bindings()).toEqual([["account-a", "main", "ready", 0]]);
  /* A stage with its own base branch leaves a binding the walk never prepares;
     the stub provider has no environment for it, so it stays in setup. */
  const account = f.ports.resolve("repo-fixture", "account-a");
  if (account.kind !== "available") throw new Error("unreachable");
  await prepareCloudEnvironment({ project: "repo-fixture", account: account.account, repository: "sample/project", ref: "feature",
    signal: new AbortController().signal, assertCurrent: () => {} }, f.backend.dependencies);
  expect(readCloudEnvironmentBindings("repo-fixture").bindings.map(r => r.ref).sort()).toEqual(["feature", "main"]);
  f.sessions.length = 0;
  for (const minutes of [1, 20, 6 * 60]) { at(minutes * MINUTE); await passes(controller, 10); }
  expect(f.sessions).toEqual([]);
  /* The default branch's own binding is revalidated once when its day ends. */
  at(25 * HOUR); await passes(controller, 30);
  expect(f.sessions).toEqual(["account-a"]);
});

test("a changed choice whose lookup fails spends one failure budget and stops", async () => {
  const f = fixture(["account-a"]), at = f.freeze();
  const controller = f.controller(); await controller.pass();
  expect(bindings()).toEqual([["account-a", "main", "ready", 0]]);
  f.refuse(); f.sessions.length = 0;
  const set = await setCloudEnvironmentOverride({ project: "repo-fixture", accountId: "account-a", environmentId: "asenvcfg_other", expectedRevision: 0, actor: "operator", assertCurrent: () => {} });
  expect(set.ok).toBe(true);
  for (let seconds = 2; seconds <= 30; seconds += 2) { at(seconds * 1000); await passes(controller, 2); }
  expect(f.sessions).toHaveLength(3);
  for (const minutes of [1, 20, 60, 120]) { at(minutes * MINUTE); await passes(controller, 10); }
  expect(f.sessions).toHaveLength(3);
});

test("a sign-in change keeps the pair due until the failure budget is spent or the binding is revalidated", async () => {
  const f = fixture(["account-a"]), at = f.freeze();
  const controller = f.controller(); await controller.pass();
  const before = readCloudEnvironmentBindings("repo-fixture").bindings[0]!.accountVersion;
  f.refuse(); f.sessions.length = 0;
  fs.writeFileSync(path.join(f.root, "auth.json"), "{}");
  at(MINUTE); await passes(controller, 2);
  expect(f.sessions).toHaveLength(1);
  /* One failure leaves the ready binding on the old sign-in; the next try inside the window revalidates it. */
  f.recover();
  at(MINUTE + 3000); await passes(controller, 3);
  expect(f.sessions).toHaveLength(2);
  const after = readCloudEnvironmentBindings("repo-fixture").bindings;
  expect(after.map(r => [r.ref, r.state])).toEqual([["main", "ready"]]);
  expect(after[0]!.accountVersion).not.toBe(before);
});

test("a project that appears while pairs are being walked is visited before the walk ends", async () => {
  const f = fixture(["account-a"], ["a", "c", "d", "e"]), at = f.freeze();
  f.ports.allowed = project => project === "b";
  const controller = f.controller(); await passes(controller, 2);
  f.setCatalog(["a", "b", "c", "d", "e"]);
  for (const seconds of [2, 4, 6, 8, 10, 12, 14]) { at(seconds * 1000); await controller.pass(); }
  expect(f.sessions).toEqual(["account-a"]);
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
