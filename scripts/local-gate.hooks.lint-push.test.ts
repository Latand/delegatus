import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

for (const mode of ["pre-push"] as const) test(`${mode} allows KanbanBoard baseline errors and rejects one added error by file/line`, () => {
  const f = hookFixture(true);
  const file = "src/components/kanban/KanbanBoard.tsx";
  mkdirSync(path.dirname(path.join(f.dir, file)), { recursive: true });
  const source = readFileSync(path.join(root, file), "utf8");
  writeFileSync(path.join(f.dir, file), source);
  f.git("add", file);
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "Kanban baseline"], { cwd: f.dir, env: f.env });
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}`);
  f.git("add", file);
  const run = () => spawnSync("bash", [`.githooks/${mode}`], { cwd: f.dir, env: f.env, encoding: "utf8" });
  const accepted = run();
  expect(accepted.status).toBe(0);
  expect((accepted.stdout + accepted.stderr)).toContain("0 errors introduced by this change");
  expect((accepted.stdout + accepted.stderr)).toMatch(/[1-9]\d* errors already on the base in files with head errors \(not blocking\)/);
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}\nexport const addedLintError: any = 1;\n`);
  f.git("add", file);
  const refused = run();
  expect(refused.status).not.toBe(0);
  expect((refused.stdout + refused.stderr)).toContain("1 errors introduced by this change");
  expect(refused.stderr).toMatch(/src\/components\/kanban\/KanbanBoard\.tsx:\d+:\d+ @typescript-eslint\/no-explicit-any/);
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}`);
  f.git("add", file);
}, 120000);
