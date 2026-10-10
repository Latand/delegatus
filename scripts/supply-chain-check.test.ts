import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditArguments, requireFrozenInstall, requireMatchingLockfile } from "./supply-chain-check";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("dependency changes require a lockfile diff against the supplied base", () => {
  const root = mkdtempSync(join(tmpdir(), "supply-check-")); roots.push(root);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" };
  for (const key of ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]) delete env[key];
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env });
  git("init"); git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { sample: "1" } }));
  writeFileSync(join(root, "bun.lock"), "initial"); git("add", "."); git("commit", "-m", "base");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { sample: "2" } }));
  expect(() => requireMatchingLockfile("HEAD", root)).toThrow("without bun.lock");
  writeFileSync(join(root, "bun.lock"), "updated");
  expect(() => requireMatchingLockfile("HEAD", root)).not.toThrow();
});
test("frozen install rejects a dependency manifest that disagrees with the old lockfile", () => {
  const root = mkdtempSync(join(tmpdir(), "supply-frozen-")); roots.push(root);
  writeFileSync(join(root, "package.json"), readFileSync(join(import.meta.dir, "../package.json")));
  writeFileSync(join(root, "bun.lock"), `${readFileSync(join(import.meta.dir, "../bun.lock"), "utf8")}\n`);
  mkdirSync(join(root, "patches"));
  writeFileSync(join(root, "patches/next-16.3.8.patch"), readFileSync(join(import.meta.dir, "../patches/next-16.3.8.patch")));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  manifest.dependencies.entities = "7.0.0";
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  expect(() => requireFrozenInstall(root)).toThrow("bun install --frozen-lockfile failed");
});
test("allowlist rejects expiry, invalid dates, duplicate IDs, missing reasons and malformed records", () => {
  const entry = { id: "GHSA-aaaa-bbbb-cccc", reason: "fixture", expires: "2999-01-01" };
  expect(auditArguments([entry])).toEqual(["--ignore=GHSA-aaaa-bbbb-cccc"]);
  for (const list of [null, [null], [{ ...entry, expires: "2000-01-01" }], [{ ...entry, expires: "2999-02-30" }], [{ ...entry, reason: "" }], [entry, { ...entry, id: entry.id.toUpperCase() }]]) expect(() => auditArguments(list)).toThrow();
});
