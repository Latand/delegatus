import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRelaunch } from "./launcher-relaunch.mjs";
import { readStartIdentity } from "./self-update-supervisor.mjs";

/*
 * A relaunch the launcher refused owns no transition: nothing was stopped, so
 * nothing may be rolled back for it, in this process or after a cold start.
 * The launcher here is this test process; `stop` and `execve` only count.
 */

const roots: string[] = [];
const execve = process.execve;
const cwd = process.cwd();
afterEach(() => {
  process.execve = execve;
  // A launcher that reaches its exec has moved into the release it starts.
  process.chdir(cwd);
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
  // An automatic request: the Viewer admitted it under this gate.
  const request = { ...f.request, autoGateId: "fixture-gate" };
  writeFileSync(path.join(f.control, "auto-admission.json"), JSON.stringify({ id: request.autoGateId, until: Date.now() + 600_000 }));
  writeFileSync(f.paths.request, JSON.stringify(request));
  const next = { sha: TARGET, dir: f.next };
  // Work the admission never saw starts while the load check runs. It is
  // filed in the Viewer's database, so only the Viewer can say so: the
  // launcher asks it again once the load check is over, and is refused. The
  // state directory holds no registry file, as with the registry in sqlite.
  let working = false;
  const asked: unknown[] = [];
  const readmit = async () => {
    asked.push({ loaded: existsSync(`${f.paths.request}`) ? "request still filed" : JSON.parse(readFileSync(f.paths.trial, "utf8")).state });
    return !working;
  };
  const first = relaunch.begin(request, next, undefined, readmit);
  await f.load(0, () => { expect(asked).toEqual([]); working = true; });
  expect(await first).toBe(false);
  // Asked once, after the load check, with the request already taken.
  expect(asked).toEqual([{ loaded: "preflight" }]);
  expect(existsSync(path.join(f.state, "agent-registry.json"))).toBe(false);
  expect(f.receipt()).toEqual({ requestId: request.requestId, state: "rejected", detail: "The Viewer did not admit the relaunch after the launcher load check" });
  expect(existsSync(f.paths.trial)).toBe(false);
  expect(relaunch.hasTrial()).toBe(false);
  // The request is offered again; custody stays with the serving launcher.
  expect(JSON.parse(readFileSync(f.paths.request, "utf8"))).toEqual(request);
  expect(relaunch.retainsCustody()).toBe(true);
  expect(await relaunch.failed("a later launcher failure")).toBe(false);
  expect(f.stops()).toBe(0); expect(f.execs()).toBe(0);

  // The Viewer settles the refusal and restores the pointer while the
  // republished request is in its second load check.
  working = false;
  const second = relaunch.begin(request, next, undefined, readmit);
  await f.load(1, () => {
    rmSync(f.paths.releasePointer);
    writeFileSync(f.applyFile, `${JSON.stringify({ ...f.apply, state: "failed", admissionRefused: true })}\n`);
  });
  expect(await second).toBe(false);
  expect(existsSync(f.paths.trial)).toBe(false);
  expect(existsSync(f.paths.request)).toBe(false);
  // A request republished before the settlement is dropped without a word.
  writeFileSync(f.paths.request, JSON.stringify(request));
  expect(await relaunch.begin(request, { sha: "a".repeat(40), dir: f.prior }, undefined, readmit)).toBeUndefined();
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
  writeFileSync(`${f.paths.request}.result.json`, JSON.stringify({ requestId: f.request.requestId, state: "rejected", detail: "The Viewer did not admit the relaunch after the launcher load check" }));
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
  const refusal = JSON.stringify({ requestId: f.request.requestId, state: "rejected", detail: "The Viewer did not admit the relaunch after the launcher load check" });
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

test.each(["no way to ask", "the question fails"] as const)("an automatic relaunch the Viewer cannot admit again stops nothing: %s", async shape => {
  const f = install();
  const relaunch = f.relaunch("prior");
  f.accept();
  const request = { ...f.request, autoGateId: "fixture-gate" };
  writeFileSync(path.join(f.control, "auto-admission.json"), JSON.stringify({ id: request.autoGateId, until: Date.now() + 600_000 }));
  writeFileSync(f.paths.request, JSON.stringify(request));
  const pending = shape === "no way to ask" ? relaunch.begin(request, { sha: TARGET, dir: f.next })
    : relaunch.begin(request, { sha: TARGET, dir: f.next }, undefined, async () => { throw new Error("the Viewer did not answer"); });
  await f.load(0, () => {});
  expect(await pending).toBe(false);
  expect(f.receipt()).toMatchObject({ requestId: request.requestId, state: "rejected" });
  expect(existsSync(f.paths.trial)).toBe(false);
  expect(readFileSync(f.paths.releasePointer, "utf8")).toBe(f.pointer);
  expect(f.stops()).toBe(0); expect(f.execs()).toBe(0);
  expect(f.launcherState.launcher).toBeUndefined();
}, 30_000);

/* An operator's request carries the operator's decision: it is not asked
   about again, and it reaches the stop that the starting intent admits. */
test("an operator's relaunch is not put to the Viewer a second time", async () => {
  const f = install();
  const relaunch = f.relaunch("prior");
  f.accept();
  writeFileSync(f.paths.request, JSON.stringify(f.request));
  let asked = 0;
  const pending = relaunch.begin(f.request, { sha: TARGET, dir: f.next }, undefined, async () => { asked++; return true; });
  await f.load(0, () => {});
  await expect(pending).rejects.toThrow("fixture exec");
  expect(asked).toBe(0);
  expect(f.stops()).toBe(1); expect(f.execs()).toBe(1);
  expect(JSON.parse(readFileSync(f.paths.trial, "utf8"))).toMatchObject({ requestId: f.request.requestId, state: "starting" });
}, 30_000);
