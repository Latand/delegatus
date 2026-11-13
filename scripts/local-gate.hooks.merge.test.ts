import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHookFixture } from "./local-gate.fixture";
import { type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";


const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
afterEach(async () => {
  for (const identity of owned.splice(0)) await stopFixtureIdentity(identity);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hookFixture(realLint = false, controlledClock = false) {
  return createHookFixture(root, roots, realLint, controlledClock);
}

test.each([false, true])("a pending merge admits published main lint errors and still blocks a new error (main advanced=%s)", advanced => {
  const f = hookFixture(true);
  const base = f.git("rev-parse", "HEAD").toString().trim();
  f.git("checkout", "-q", "-b", "lane");
  writeFileSync(path.join(f.dir, "lane.ts"), "export const lane = 1;\n");
  f.git("add", "lane.ts"); f.git("commit", "-m", "lane work");
  f.git("checkout", "-q", "main");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value: any = 1;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "published baseline");
  const incoming = f.git("rev-parse", "HEAD").toString().trim();
  if (advanced) {
    writeFileSync(path.join(f.dir, "example.ts"), "export const value = 1;\n");
    f.git("add", "example.ts"); f.git("commit", "-m", "later main cleanup");
  }
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("checkout", "-q", "lane");
  f.git("merge", "--no-ff", "--no-commit", incoming);
  const merged = spawnSync("git", ["commit", "-m", "merge published main"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(merged.status, merged.stdout + merged.stderr).toBe(0);
  expect(merged.stdout + merged.stderr).toContain("0 errors introduced by this change");
  expect(f.git("rev-parse", "HEAD^2").toString().trim()).toBe(incoming);
  expect(f.git("merge-base", "HEAD^1", incoming).toString().trim()).toBe(base);
  const accepted = f.git("rev-parse", "HEAD").toString().trim();
  writeFileSync(path.join(f.dir, "example.ts"), "export const value: any = 1;\nexport const added: any = 2;\n");
  f.git("add", "example.ts");
  const refused = spawnSync("git", ["commit", "-m", "new lint error"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(refused.status).not.toBe(0);
  expect(refused.stdout + refused.stderr).toContain("errors introduced by this change");
  expect(f.git("rev-parse", "HEAD").toString().trim()).toBe(accepted);
}, 120_000);

test("a pending merge never treats an unpublished incoming lint error as a baseline", () => {
  const f = hookFixture(true);
  f.git("checkout", "-q", "-b", "incoming");
  writeFileSync(path.join(f.dir, "example.ts"), "export const added: any = 1;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "unpublished error");
  f.git("checkout", "-q", "main");
  writeFileSync(path.join(f.dir, "lane.ts"), "export const lane = 1;\n");
  f.git("add", "lane.ts"); f.git("commit", "-m", "local work");
  const before = f.git("rev-parse", "HEAD").toString().trim();
  f.git("merge", "--no-ff", "--no-commit", "incoming");
  const refused = spawnSync("git", ["commit", "-m", "merge unpublished error"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(refused.status).not.toBe(0);
  expect(refused.stdout + refused.stderr).toContain("1 errors introduced by this change");
  expect(f.git("rev-parse", "HEAD").toString().trim()).toBe(before);
}, 120_000);
