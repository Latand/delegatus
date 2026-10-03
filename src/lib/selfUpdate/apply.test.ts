import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
