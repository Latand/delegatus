import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRelaunch } from "./launcher-relaunch.mjs";
import { dispatchActivityVersion, readStartIdentity } from "./self-update-supervisor.mjs";

/*
 * A relaunch the launcher refused owns no transition: nothing was stopped, so
 * nothing may be rolled back for it, in this process or after a cold start.
 * The launcher here is this test process; `stop` and `execve` only count.
 */

const roots: string[] = [];
const execve = process.execve;
afterEach(() => {
  process.execve = execve;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TARGET = "b".repeat(40);

function install() {
  const root = mkdtempSync(path.join(tmpdir(), "dlg-relaunch-custody-")); roots.push(root);
  const state = path.join(root, "state"), control = path.join(state, "self-update");
  const prior = path.join(root, "prior"), next = path.join(root, "next");
  mkdirSync(control, { recursive: true });
  const gate = path.join(root, "load");
  for (const [directory, version] of [[prior, "1.0.0"], [next, "1.0.1"]] as const) {
    mkdirSync(path.join(directory, "bin"), { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module", version }));
    // The load check announces each attempt and waits to be let through.
    writeFileSync(path.join(directory, "bin", "cli.mjs"), `import fs from "node:fs";
let attempt = 0; while (fs.existsSync(${JSON.stringify(gate)} + "-entered-" + attempt)) attempt++;
fs.writeFileSync(${JSON.stringify(gate)} + "-entered-" + attempt, "");
while (!fs.existsSync(${JSON.stringify(gate)} + "-released-" + attempt)) await Bun.sleep(5);
`);
  }
  const paths = { request: path.join(control, "request-fixture.json"), trial: path.join(control, "trial-fixture.json"),
    record: path.join(control, "launcher-fixture.json"), releasePointer: path.join(control, "release-fixture.json") };
  const owner = { pid: process.pid, startIdentity: readStartIdentity(process.pid) };
  writeFileSync(paths.record, JSON.stringify({ launcher: owner }));
  const pointer = `${JSON.stringify({ kind: "package", sha: TARGET, dir: next, baseVersion: "1.0.0", version: "1.0.1" })}\n`;
  writeFileSync(paths.releasePointer, pointer);
  const request = { requestId: "refused-request", role: "relaunch", target: TARGET, rollbackPointer: null, requestedAt: "2026-01-01T00:00:00.000Z" };
  const apply = { requestId: request.requestId, target: TARGET, releasePointer: paths.releasePointer, rollbackPointer: null,
    launcherPid: owner.pid, launcherIdentity: owner.startIdentity, rollbackPackage: { root: prior, version: "1.0.0" },
    trigger: "operator", startedAt: request.requestedAt, state: "switching", rolledBack: false };
  const applyFile = path.join(control, "apply.json");
  // The Viewer accepts an apply under a launcher that is already running.
  const accept = () => writeFileSync(applyFile, `${JSON.stringify(apply)}\n`);
  let stops = 0, execs = 0;
  process.execve = (() => { execs++; throw new Error("fixture exec"); }) as typeof process.execve;
  const launcherState: Record<string, unknown> = {};
  const relaunch = (image: "prior" | "next") => createRelaunch({ paths, installRoot: prior, entry: path.join(image === "prior" ? prior : next, "bin", "cli.mjs"),
    release: image === "prior" ? { sha: "a".repeat(40), dir: prior, published: false } : { sha: TARGET, dir: next, published: true },
    stop: async () => { stops++; }, args: [],
    record: { set: (role: string, value: unknown) => { launcherState[role] = value; }, remove: () => {} } });
  const load = async (attempt: number, during: () => void | Promise<void>) => {
    while (!existsSync(`${gate}-entered-${attempt}`)) await Bun.sleep(5);
    await during();
    writeFileSync(`${gate}-released-${attempt}`, "");
  };
  return { state, control, paths, pointer, request, apply, applyFile, accept, next, prior, relaunch, load, launcherState,
    stops: () => stops, execs: () => execs, receipt: () => JSON.parse(readFileSync(`${paths.request}.result.json`, "utf8")) };
}

test("a refused relaunch leaves no trial, and a later failure stops nothing", async () => {
  const f = install();
  const relaunch = f.relaunch("prior");
  f.accept();
  writeFileSync(f.paths.request, JSON.stringify(f.request));
  const next = { sha: TARGET, dir: f.next };
  const first = relaunch.begin(f.request, next);
  // Work the admission never saw is filed while the load check runs.
  await f.load(0, () => writeFileSync(path.join(f.state, "agent-registry.json"), JSON.stringify({ version: 2, entries: { "conversation-new": { claimEpoch: 1, pendingAction: "spawn" } }, receipts: {} })));
  expect(await first).toBe(false);
  expect(f.receipt()).toMatchObject({ requestId: f.request.requestId, state: "rejected" });
  expect(existsSync(f.paths.trial)).toBe(false);
  expect(relaunch.hasTrial()).toBe(false);
  // The request is offered again; custody stays with the serving launcher.
  expect(JSON.parse(readFileSync(f.paths.request, "utf8"))).toEqual(f.request);
  expect(relaunch.retainsCustody()).toBe(true);
  expect(await relaunch.failed("a later launcher failure")).toBe(false);

  // The Viewer settles the refusal and restores the pointer while the
  // republished request is in its second load check.
  const second = relaunch.begin(f.request, next);
  await f.load(1, () => {
    rmSync(f.paths.releasePointer);
    writeFileSync(f.applyFile, `${JSON.stringify({ ...f.apply, state: "failed", admissionRefused: true })}\n`);
  });
  expect(await second).toBe(false);
  expect(existsSync(f.paths.trial)).toBe(false);
  expect(existsSync(f.paths.request)).toBe(false);
  // A request republished before the settlement is dropped without a word.
  writeFileSync(f.paths.request, JSON.stringify(f.request));
  expect(await relaunch.begin(f.request, { sha: "a".repeat(40), dir: f.prior })).toBeUndefined();
  expect(relaunch.hasTrial()).toBe(false);
  expect(f.stops()).toBe(0); expect(f.execs()).toBe(0);
  expect(f.launcherState.launcher).toBeUndefined();
  expect(existsSync(f.paths.releasePointer)).toBe(false);
}, 30_000);

test("a failure during the load check drops the preflight trial and stops nothing", async () => {
  const f = install();
  const relaunch = f.relaunch("prior");
  f.accept();
  const pending = relaunch.begin(f.request, { sha: TARGET, dir: f.next });
  await f.load(0, () => writeFileSync(f.paths.record, "not a record"));
  await expect(pending).rejects.toThrow();
  expect(relaunch.hasTrial()).toBe(true);
  expect(await relaunch.failed("the launcher record became unreadable")).toBe(false);
  expect(relaunch.hasTrial()).toBe(false);
  expect(existsSync(f.paths.trial)).toBe(false);
  expect(readFileSync(f.paths.releasePointer, "utf8")).toBe(f.pointer);
  expect(f.stops()).toBe(0); expect(f.execs()).toBe(0);
}, 30_000);

test.each(["no-trial", "preflight-trial"] as const)("a cold start on the target after a refusal neither rolls back nor execs: %s", async shape => {
  const f = install();
  f.accept();
  writeFileSync(f.paths.request, JSON.stringify(f.request));
  writeFileSync(`${f.paths.request}.result.json`, JSON.stringify({ requestId: f.request.requestId, state: "rejected", detail: "Stale launcher dispatch custody or work evidence" }));
  // A crash between the refusal receipt and the trial's removal leaves both.
  if (shape === "preflight-trial") writeFileSync(f.paths.trial, `${JSON.stringify({ requestId: f.request.requestId, target: TARGET, rollbackPointer: null,
    previousEntry: path.join(f.prior, "bin", "cli.mjs"), state: "preflight", at: f.request.requestedAt })}\n`);
  const relaunch = f.relaunch("next");
  await relaunch.recoverPending();
  expect(f.stops()).toBe(0); expect(f.execs()).toBe(0);
  expect(readFileSync(f.paths.releasePointer, "utf8")).toBe(f.pointer);
  // The cold start is the transition: its own readiness settles the apply.
  expect(relaunch.isReplacementStart()).toBe(true);
  expect(existsSync(`${f.paths.request}.result.json`)).toBe(false);
  relaunch.succeeded();
  expect(f.receipt()).toMatchObject({ requestId: f.request.requestId, target: TARGET, state: "done", revision: TARGET });
  expect(existsSync(f.paths.trial)).toBe(false);
});

test("a cold start on the prior image after a refusal leaves the settlement to the Viewer", async () => {
  const f = install();
  f.accept();
  writeFileSync(f.paths.request, JSON.stringify(f.request));
  const refusal = JSON.stringify({ requestId: f.request.requestId, state: "rejected", detail: "Stale launcher dispatch custody or work evidence" });
  writeFileSync(`${f.paths.request}.result.json`, refusal);
  writeFileSync(f.paths.trial, `${JSON.stringify({ requestId: f.request.requestId, target: TARGET, rollbackPointer: null,
    previousEntry: path.join(f.prior, "bin", "cli.mjs"), state: "preflight", at: f.request.requestedAt })}\n`);
  const applied = readFileSync(f.applyFile, "utf8");
  const relaunch = f.relaunch("prior");
  await relaunch.recoverPending();
  expect(f.stops()).toBe(0); expect(f.execs()).toBe(0);
  expect(relaunch.hasTrial()).toBe(false); expect(relaunch.isReplacementStart()).toBe(false);
  expect(existsSync(f.paths.trial)).toBe(false);
  expect(readFileSync(f.paths.releasePointer, "utf8")).toBe(f.pointer);
  expect(readFileSync(f.applyFile, "utf8")).toBe(applied);
  expect(readFileSync(`${f.paths.request}.result.json`, "utf8")).toBe(refusal);
});

test("work evidence follows records and launches and ignores journal and database traffic", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dlg-work-evidence-")); roots.push(root);
  const registry = (entries: Record<string, unknown>, receipts: Record<string, unknown> = {}) =>
    writeFileSync(path.join(root, "agent-registry.json"), JSON.stringify({ version: 2, entries, receipts }));
  registry({ a: { claimEpoch: 3, pendingAction: null, status: "live", updatedAt: "2026-01-01T00:00:00.000Z" } });
  const admitted = dispatchActivityVersion(root);
  // Every event of a turn already running moves these.
  for (const name of ["state.sqlite", "state.sqlite-wal", "runtime-events-fixture.sqlite", "runtime-events-fixture.sqlite-wal"]) writeFileSync(path.join(root, name), "event");
  registry({ a: { claimEpoch: 3, pendingAction: null, status: "working", updatedAt: "2026-01-01T00:00:05.000Z" } });
  expect(dispatchActivityVersion(root)).toBe(admitted);
  registry({ a: { claimEpoch: 4, pendingAction: "resume", status: "working" } });
  expect(dispatchActivityVersion(root)).not.toBe(admitted);
  registry({ a: { claimEpoch: 3, pendingAction: null }, b: { claimEpoch: 0, pendingAction: "spawn" } });
  expect(dispatchActivityVersion(root)).not.toBe(admitted);
  registry({ a: { claimEpoch: 3, pendingAction: null } }, { "attempt-1": {} });
  expect(dispatchActivityVersion(root)).not.toBe(admitted);
  // A registry this launcher cannot read by record still refuses any change.
  writeFileSync(path.join(root, "agent-registry.json"), JSON.stringify({ admitted: "one" }));
  const opaque = dispatchActivityVersion(root);
  writeFileSync(path.join(root, "agent-registry.json"), JSON.stringify({ admitted: "two" }));
  expect(dispatchActivityVersion(root)).not.toBe(opaque);
});
