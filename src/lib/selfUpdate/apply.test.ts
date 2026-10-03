import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApplyController } from "./apply";
import type { LauncherRecord } from "./launcher";
const root = mkdtempSync("/var/tmp/install-apply-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const record = (dir: string) => ({ launcher: { pid: 5, startIdentity: "7", relaunch: 1 },
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
