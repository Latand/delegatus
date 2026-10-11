import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { reviewExport } from "./review-export";

const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-review-export-test-"));
  made.push(root);
  const repository = path.join(root, "repo");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(repository); fs.mkdirSync(scratch);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture", GIT_COMMITTER_EMAIL: "fixture" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_") || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(key)) delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, env, encoding: "utf8" }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ dependencies: { fixture: "1.0.0" } }));
  fs.writeFileSync(path.join(repository, "bun.lock"), '{"packages":{"fixture":["fixture@1.0.0"]}}');
  fs.writeFileSync(path.join(repository, "source.txt"), "committed source");
  git("add", "."); git("commit", "-qm", "fixture source");
  fs.mkdirSync(path.join(repository, "node_modules/fixture"), { recursive: true });
  fs.writeFileSync(path.join(repository, "node_modules/fixture/index.js"), "export default 42");
  return { repository, scratch, git };
}

test("an exact-head review export borrows matching dependencies without another install", () => {
  const f = fixture();
  const head = f.git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.repository, "source.txt"), "uncommitted source");
  const exported = reviewExport(f.repository, head, f.scratch);
  expect(exported.head).toBe(head);
  expect(path.dirname(path.dirname(exported.directory))).toBe(f.scratch);
  expect(fs.readFileSync(path.join(exported.directory, "source.txt"), "utf8")).toBe("committed source");
  expect(exported.dependencies).toBe("shared");
  expect(fs.realpathSync(path.join(exported.directory, "node_modules"))).toBe(path.join(f.repository, "node_modules"));
  expect(fs.readdirSync(path.dirname(exported.directory))).toEqual(["checkout"]);
  fs.rmSync(path.dirname(exported.directory), { recursive: true });
  expect(fs.readFileSync(path.join(f.repository, "node_modules/fixture/index.js"), "utf8")).toBe("export default 42");
});

test.each(["manifest", "lock", "patch", "missing"])("a review export keeps source readable without borrowing %s dependencies", change => {
  const f = fixture();
  if (change === "patch") {
    fs.mkdirSync(path.join(f.repository, "patches"));
    fs.writeFileSync(path.join(f.repository, "patches/fixture.patch"), "committed patch");
    fs.writeFileSync(path.join(f.repository, "package.json"), JSON.stringify({ patchedDependencies: { "fixture@1.0.0": "patches/fixture.patch" } }));
    f.git("add", "package.json", "patches"); f.git("commit", "-qm", "fixture patch");
  }
  const head = f.git("rev-parse", "HEAD");
  if (change === "missing") fs.rmSync(path.join(f.repository, "node_modules"), { recursive: true });
  else fs.writeFileSync(path.join(f.repository, change === "manifest" ? "package.json" : change === "lock" ? "bun.lock" : "patches/fixture.patch"), change === "manifest" ? '{}' : "changed input");
  const exported = reviewExport(f.repository, head, f.scratch);
  expect(exported.dependencies).toBe("unavailable");
  expect(fs.existsSync(path.join(exported.directory, "node_modules"))).toBeFalse();
  expect(fs.readFileSync(path.join(exported.directory, "source.txt"), "utf8")).toBe("committed source");
});

test.each(["file:../local", "../local", "workspace:*", "lock-directory"])("local resolution %s stays outside the shared export", resolution => {
  const f = fixture();
  if (resolution === "lock-directory") fs.writeFileSync(path.join(f.repository, "bun.lock"), '{"packages":{"fixture":["fixture@file:../local"]}}');
  else fs.writeFileSync(path.join(f.repository, "package.json"), JSON.stringify({ dependencies: { fixture: resolution } }));
  f.git("add", "package.json", "bun.lock"); f.git("commit", "-qm", "fixture local input");
  const exported = reviewExport(f.repository, "HEAD", f.scratch);
  expect(exported.dependencies).toBe("unavailable");
  expect(fs.existsSync(path.join(exported.directory, "node_modules"))).toBeFalse();
});

test("an invalid ref creates no scratch tree and never overwrites an existing directory", () => {
  const f = fixture();
  const existing = path.join(f.scratch, "operator-work");
  fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, "keep.txt"), "keep");
  expect(() => reviewExport(f.repository, "missing-ref", f.scratch)).toThrow();
  expect(fs.readdirSync(f.scratch)).toEqual(["operator-work"]);
  expect(fs.readFileSync(path.join(existing, "keep.txt"), "utf8")).toBe("keep");
});
