import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditArguments, requireMatchingLockfile } from "./supply-chain-check";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("dependency changes require a lockfile diff against the supplied base", () => {
  const root = mkdtempSync(join(tmpdir(), "supply-check-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" } });
  git("init"); git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { sample: "1" } }));
  writeFileSync(join(root, "bun.lock"), "initial"); git("add", "."); git("commit", "-m", "base");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { sample: "2" } }));
  expect(() => requireMatchingLockfile("HEAD", root)).toThrow("without bun.lock");
  writeFileSync(join(root, "bun.lock"), "updated");
  expect(() => requireMatchingLockfile("HEAD", root)).not.toThrow();
});
test("allowlist rejects expiry, invalid dates, duplicate IDs, missing reasons and malformed records", () => {
  const entry = { id: "GHSA-aaaa-bbbb-cccc", reason: "fixture", expires: "2999-01-01" };
  expect(auditArguments([entry])).toEqual(["--ignore=GHSA-aaaa-bbbb-cccc"]);
  for (const list of [null, [null], [{ ...entry, expires: "2000-01-01" }], [{ ...entry, expires: "2999-02-30" }], [{ ...entry, reason: "" }], [entry, { ...entry, id: entry.id.toUpperCase() }]]) expect(() => auditArguments(list)).toThrow();
});
