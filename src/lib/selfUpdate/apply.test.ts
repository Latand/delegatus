import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApplyController } from "./apply";
import { activeDrain } from "./drain";
import type { LauncherRecord } from "./launcher";
const root = mkdtempSync("/var/tmp/install-apply-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const record = (dir: string) => ({ launcher: { pid: 5, startIdentity: "7", relaunch: 1, state: "healthy" },
  releasePointer: join(dir, "pointer.json"), requestFile: join(dir, "request-install.json"),
  web: { state: "healthy", revision: "aaaaaaa" }, runtimeHost: { state: "healthy", revision: "aaaaaaa" } }) as LauncherRecord;
test("one apply survives the Viewer and settles both processes", () => {
  const dir = mkdtempSync(join(root, "success-")); const r = record(dir);
  const raw = "{\"previous\":true}\n"; writeFileSync(r.releasePointer, raw);
  const controller = new ApplyController(dir);
  controller.begin(r, "a".repeat(40), "operator");
  writeFileSync(r.releasePointer, "{\"new\":true}");
  controller.send(r);
  const request = JSON.parse(readFileSync(r.requestFile, "utf8"));
  expect(request).toMatchObject({ role: "relaunch", target: "a".repeat(40), rollbackPointer: raw });
  const recovered = new ApplyController(dir);
  expect(recovered.current?.state).toBe("switching");
  expect(recovered.observe({ ...r, launcher: { ...r.launcher, state: "healthy", requestId: request.requestId } })).toBe("done");
  expect(new ApplyController(dir).current?.state).toBe("done");
});
test("fallback keeps operator policy and reports rollback", () => {
  const dir = mkdtempSync(join(root, "failure-")); const r = record(dir); const c = new ApplyController(dir);
  c.begin(r, "a".repeat(40), "operator"); c.send(r);
  const id = c.current!.requestId;
  expect(c.observe({ ...r, launcher: { ...r.launcher, requestId: id, error: { kind: "fell-back", revision: "aaaaaaa", detail: "broken" } } })).toBe("failed");
  expect(c.current).toMatchObject({ rolledBack: true, trigger: "operator", detail: "broken" });
});

test("a rejected automatic admission releases custody and permits another attempt", () => {
  const dir = mkdtempSync(join(root, "rejected-")); const r = record(dir); const c = new ApplyController(dir);
  c.begin(r, "a".repeat(40), "auto"); c.send(r, "gate-1");
  writeFileSync(`${r.requestFile}.result.json`, JSON.stringify({ requestId: c.current!.requestId, state: "rejected", detail: "Final automatic admission expired" }));
  expect(c.observe(r)).toBe("failed");
  expect(c.current?.detail).toContain("admission");
  expect(() => c.begin(r, "b".repeat(40), "operator")).not.toThrow();
});
test("a terminal bootstrap settles after the new launcher verifies both processes", () => {
  const dir = mkdtempSync(join(root, "terminal-")); const r = record(dir); const c = new ApplyController(dir);
  c.begin(r, "a".repeat(40), "operator"); c.patch({ state: "ready" });
  const next = { ...r, launcher: { ...r.launcher, pid: 6, startIdentity: "8", state: "healthy" } };
  expect(c.observe(next, false)).toBeNull();
  expect(c.observe(next, true)).toBe("done");
  expect(() => c.begin(next, "b".repeat(40), "operator")).not.toThrow();
});
test("a launcher record cannot settle a release when host health failed", () => {
  const dir = mkdtempSync(join(root, "health-")); const r = record(dir); const c = new ApplyController(dir);
  c.begin(r, "a".repeat(40), "operator"); c.send(r);
  const next = { ...r, launcher: { ...r.launcher, state: "healthy", requestId: c.current!.requestId } };
  expect(c.observe(next, false)).toBeNull();
  expect(c.current?.state).toBe("switching");
});

test("request publication failure restores the previous pointer before Retry captures it", () => {
  const dir = mkdtempSync(join(root, "publication-")); const r = record(dir); const c = new ApplyController(dir);
  const old = JSON.stringify({ sha: "b".repeat(40) }) + "\n"; writeFileSync(r.releasePointer, old);
  c.begin(r, "a".repeat(40), "operator");
  writeFileSync(r.releasePointer, JSON.stringify({ sha: "a".repeat(40) }));
  mkdirSync(`${r.requestFile}.${process.pid}.tmp`);
  expect(() => c.send(r)).toThrow();
  expect(c.current?.state).toBe("failed");
  expect(readFileSync(r.releasePointer, "utf8")).toBe(old);
  const recovered = new ApplyController(dir); recovered.begin(r, "a".repeat(40), "operator");
  expect(recovered.current?.rollbackPointer).toBe(old);
});


test.each(["Relaunch target is not the installed release.", "trial persistence refused"])("cold apply settles terminal launcher rejection: %s", detail => {
  const dir = mkdtempSync(join(root, "terminal-rejection-")); const r = record(dir); r.web.revision = r.runtimeHost.revision = "bbbbbbb"; const c = new ApplyController(dir);
  const previous = JSON.stringify({ sha: "b".repeat(40) }) + "\n"; writeFileSync(r.releasePointer, previous);
  c.begin(r, "a".repeat(40), "seat"); writeFileSync(r.releasePointer, JSON.stringify({ sha: "a".repeat(40) })); c.send(r);
  const cold = new ApplyController(dir);
  const failed = { ...r, launcher: { ...r.launcher, state: "healthy", requestId: "unrelated", error: { kind: "message" as const, text: detail } } };
  expect(cold.observe(failed)).toBeNull(); expect(activeDrain(join(dir, "auto-drain.json"))).not.toBeNull();
  failed.launcher.requestId = c.current!.requestId;
  expect(cold.observe(failed)).toBe("failed");
  expect(cold.current).toMatchObject({ state: "failed", rolledBack: false, detail });
  expect(activeDrain(join(dir, "auto-drain.json"))).toBeNull();
  expect(readFileSync(r.releasePointer, "utf8")).toBe(previous);
  expect(new ApplyController(dir).current?.state).toBe("failed");
});


test.each(["done", "failed"] as const)("a crash-restarted launcher settles the same durable trial as %s", outcome => {
  const dir = mkdtempSync(join(root, "successor-")); const r = record(dir); const c = new ApplyController(dir);
  c.begin(r, "a".repeat(40), "operator"); c.send(r); rmSync(r.requestFile);
  const cold = new ApplyController(dir);
  const successor = { ...r, launcher: { ...r.launcher, pid: 6, startIdentity: "8", state: "healthy", requestId: "unrelated", error: outcome === "failed" ? { kind: "fell-back" as const, revision: "aaaaaaa", detail: "candidate failed" } : null } };
  expect(cold.observe(successor)).toBeNull(); expect(activeDrain(join(dir, "auto-drain.json"))).not.toBeNull();
  successor.launcher.requestId = c.current!.requestId;
  expect(cold.observe(successor, false)).toBeNull();
  expect(cold.observe(successor, true)).toBe(outcome);
  expect(activeDrain(join(dir, "auto-drain.json"))).toBeNull();
  expect(new ApplyController(dir).current?.state).toBe(outcome);
});

test("an untaken external service handoff restores its pointer and permits Retry after its deadline", () => {
  const dir = mkdtempSync(join(root, "external-")); const r = record(dir); const c = new ApplyController(dir);
  const previous = JSON.stringify({ sha: "b".repeat(40) }) + "\n"; writeFileSync(r.releasePointer, previous);
  c.begin(r, "a".repeat(40), "operator"); c.send(r); rmSync(r.requestFile);
  c.patch({ externalRestart: true });
  const trial = r.requestFile.replace("request-", "trial-"); writeFileSync(trial, JSON.stringify({ requestId: c.current!.requestId, state: "starting" }));
  writeFileSync(r.releasePointer, JSON.stringify({ sha: "a".repeat(40) }));
  const cold = new ApplyController(dir); const at = Date.parse(c.current!.switchedAt!);
  const old = { ...r, launcher: { ...r.launcher, state: undefined }, web: { ...r.web, revision: "bbbbbbb" }, runtimeHost: { ...r.runtimeHost, revision: "bbbbbbb" } };
  expect(cold.observe(old, true, at + 1_000)).toBeNull();
  expect(cold.observe(old, true, at + 61_000)).toBe("failed");
  expect(readFileSync(r.releasePointer, "utf8")).toBe(previous);
  expect(existsSync(trial)).toBe(false); expect(activeDrain(join(dir, "auto-drain.json"))).toBeNull();
  expect(() => cold.begin(old, "a".repeat(40), "operator")).not.toThrow();
});


test.each([null, JSON.stringify({ sha: "b".repeat(40) }) + "\n"])("a verified legacy rollback settles its owned trial and seat receipt, pointer=%s", previous => {
  const dir = mkdtempSync(join(root, "legacy-")); const r = record(dir); r.web.revision = r.runtimeHost.revision = "bbbbbbb";
  if (previous !== null) writeFileSync(r.releasePointer, previous);
  writeFileSync(join(dir, "deployments.json"), JSON.stringify([{ deploymentId: "legacy-seat", idempotencyKey: "legacy-key", phase: "queued", terminal: false, revisionNumber: 1 }]));
  const c = new ApplyController(dir); c.begin(r, "a".repeat(40), "seat", "legacy-seat"); c.send(r); rmSync(r.requestFile); c.patch({ externalRestart: true });
  const trial = r.requestFile.replace("request-", "trial-");
  const owned = { requestId: c.current!.requestId, target: c.current!.target, rollbackPointer: previous, state: "rolled-back", detail: "candidate host failed" };
  writeFileSync(trial, JSON.stringify({ ...owned, requestId: "unrelated" }));
  const legacy = { ...r, launcher: { pid: 6, startIdentity: "8", autoAdmission: 1 as const } };
  const cold = new ApplyController(dir);
  expect(cold.observe(legacy, true)).toBeNull();
  writeFileSync(trial, JSON.stringify(owned));
  expect(cold.observe(legacy, false)).toBeNull();
  writeFileSync(r.releasePointer, JSON.stringify({ sha: "a".repeat(40) }));
  expect(cold.observe(legacy, true)).toBeNull();
  if (previous === null) rmSync(r.releasePointer); else writeFileSync(r.releasePointer, previous);
  expect(cold.observe({ ...legacy, web: { ...r.web, revision: "aaaaaaa" } }, true)).toBeNull();
  expect(cold.observe(legacy, true)).toBe("failed");
  expect(cold.current).toMatchObject({ state: "failed", rolledBack: true, detail: owned.detail });
  expect(JSON.parse(readFileSync(join(dir, "deployments.json"), "utf8"))[0]).toMatchObject({ phase: "rolled-back", terminal: true });
  expect(activeDrain(join(dir, "auto-drain.json"))).toBeNull(); expect(existsSync(trial)).toBe(false);
});


test.each(["done", "failed"] as const)("a verified Windows terminal successor settles without execve: %s", outcome => {
  const dir = mkdtempSync(join(root, "windows-terminal-")); const r = record(dir); const c = new ApplyController(dir);
  c.begin(r, "a".repeat(40), "operator"); c.patch({ state: "ready", externalRestart: true });
  const next = { ...r, launcher: { pid: 6, startIdentity: "6:133000000000000000", protocol: "delegatus-launcher-relaunch-v1", state: "healthy",
    error: outcome === "failed" ? { kind: "fell-back" as const, revision: "aaaaaaa", detail: "failed candidate" } : null } };
  expect(c.observe({ ...next, launcher: { ...next.launcher, protocol: "unknown" } })).toBeNull();
  expect(c.observe(next, false)).toBeNull();
  expect(c.observe(next, true)).toBe(outcome);
});


test("an unpublished legacy package rollback settles only the captured install version", () => {
  const dir = mkdtempSync(join(root, "legacy-package-")); const r = record(dir);
  const installRoot = join(dir, "package"); mkdirSync(installRoot); writeFileSync(join(installRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
  r.checkout = null; r.installRoot = installRoot; r.web.revision = r.runtimeHost.revision = null;
  const c = new ApplyController(dir); c.begin(r, "a".repeat(40), "seat"); c.patch({ state: "ready", externalRestart: true });
  const trial = r.requestFile.replace("request-", "trial-");
  writeFileSync(trial, JSON.stringify({ requestId: c.current!.requestId, target: c.current!.target, rollbackPointer: null,
    previousEntry: join(installRoot, "bin", "cli.mjs"), state: "rolled-back" }));
  const legacy = { ...r, launcher: { pid: 6, startIdentity: "8", autoAdmission: 1 as const } };
  const cold = new ApplyController(dir);
  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ version: "1.0.1" })); expect(cold.observe(legacy)).toBeNull();
  writeFileSync(join(installRoot, "package.json"), JSON.stringify({ version: "1.0.0" })); expect(cold.observe(legacy, false)).toBeNull();
  expect(cold.observe(legacy, true)).toBe("failed"); expect(cold.current).toMatchObject({ state: "failed", rolledBack: true });
});
