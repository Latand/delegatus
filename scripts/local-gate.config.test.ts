import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gateInputSnapshot } from "./local-gate";
import { createHookFixture } from "./local-gate.fixture";
import { createPublicationFixtures } from "./publicationHook.fixture";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const branch = "topic.with.dots";
const fixture = (currentBranch = branch) => {
  const f = createHookFixture(root, roots);
  f.git("branch", "-m", currentBranch);
  const base = f.git("rev-parse", "origin/main").toString().trim();
  const reader = gateInputSnapshot(f.dir, base, [], f.env);
  const initial = reader.snapshot();
  expect(initial, reader.reason()).toBeDefined();
  return { ...f, base, reader, initial: initial! };
};

test.each(["\u00a0", "\u2003"])("current branch names preserve trailing Unicode whitespace %s", whitespace => {
  const current = `topic${whitespace}`;
  const f = fixture(current);
  f.git("config", `branch.${current}.remote`, ".");
  expect(f.reader.changed(f.initial)).toEqual(["git config"]);
  expect(f.reader.snapshot()?.key).not.toBe(f.initial.key);

  const afterOwnChange = f.reader.snapshot()!;
  f.git("config", "branch.topic.remote", ".");
  expect(f.reader.changed(afterOwnChange)).toEqual([]);
  expect(f.reader.snapshot()?.key).toBe(afterOwnChange.key);
});

test.each(["other", "topic", `${branch}.extra`, "Topic.with.dots"])("another branch's %s section leaves snapshots and cache keys unchanged", other => {
  const f = fixture(), key = `branch.${other}.remote`;
  const unchanged = () => {
    expect(f.reader.changed(f.initial)).toEqual([]);
    expect(f.reader.snapshot()?.key).toBe(f.initial.key);
  };
  f.git("config", key, "."); unchanged();
  f.git("config", key, "another-remote"); unchanged();
  f.git("config", `branch.${other}.description`, "first line\nbranch.topic.with.dots.remote=still a value\n\tlast line"); unchanged();
  f.git("config", "--remove-section", `branch.${other}`); unchanged();
});

test.each([
  ["core.ignorecase", "true"],
  ["core.hooksPath", "other-hooks"],
  ["user.name", "Fixture"],
  ["user.useConfigOnly", "true"],
  ["remote.origin.url", "."],
  ["remote.other.url", "."],
  [`branch.${branch}.remote`, "."],
  [`branch.${branch}.merge`, "refs/heads/other"],
  [`branch.${branch}.description`, "first line\nbranch.other.remote=value\n\tlast line"],
  ["delegatus.checks", "changed"],
])("check-affecting config %s still invalidates the run and cache key", (key, value) => {
  const f = fixture();
  f.git("config", key, value);
  expect(f.reader.changed(f.initial)).toEqual(["git config"]);
  expect(f.reader.snapshot()?.key).not.toBe(f.initial.key);
});

test("included entries keep their origin, order and multiline values", () => {
  const f = fixture(), included = path.join(f.dir, ".git", "checks.config");
  const contents = '[delegatus]\n checks = "first\\nbranch.other.remote=value"\n checks = second\n';
  writeFileSync(included, contents);
  f.git("config", "include.path", "checks.config");
  const initial = f.reader.snapshot()!;
  appendFileSync(included, "[branch \"other\"]\n remote = .\n");
  expect(f.reader.changed(initial)).toEqual([]);
  expect(f.reader.snapshot()?.key).toBe(initial.key);
  writeFileSync(included, contents.replace("first", "changed"));
  expect(f.reader.changed(initial)).toEqual(["git config"]);
  writeFileSync(included, contents.replace(' checks = "first\\nbranch.other.remote=value"\n checks = second', ' checks = second\n checks = "first\\nbranch.other.remote=value"'));
  expect(f.reader.changed(initial)).toEqual(["git config"]);
  // The flattened key/value listing is unchanged when values move between
  // origins, but the source that supplied each value remains an input.
  writeFileSync(included, "");
  appendFileSync(path.join(f.dir, ".git", "config"), contents);
  expect(f.reader.changed(initial)).toEqual(["git config"]);
});

test("detached HEAD ignores all branch sections and keeps other configuration", () => {
  const f = fixture();
  f.git("checkout", "--detach", "-q");
  const initial = f.reader.snapshot()!;
  f.git("config", `branch.${branch}.remote`, ".");
  expect(f.reader.changed(initial)).toEqual([]);
  expect(f.reader.snapshot()?.key).toBe(initial.key);
  f.git("config", "core.ignorecase", "true");
  expect(f.reader.changed(initial)).toEqual(["git config"]);
});

test("a restarted gate reuses passes after peer writes and rejects relevant config drift", () => {
  const f = fixture();
  const run = (operation: string) => {
    const source = `import { stepPasses } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
      const step = { name: "types", command: ["bunx", "tsc", "--noEmit"] };
      const passes = stepPasses(${JSON.stringify(f.dir)}, ${JSON.stringify(f.base)}, [step], () => {});
      ${operation}; console.log(passes.reused(step));`;
    const result = spawnSync(process.execPath, ["-e", source], { cwd: f.dir, env: f.env, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  expect(run("passes.passed(step)")).toBe("true");
  f.git("config", "branch.other.remote", ".");
  expect(run("")).toBe("true");
  f.git("config", "core.ignorecase", "true");
  expect(run("")).toBe("false");
  f.git("config", "--unset", "core.ignorecase");
  expect(run("")).toBe("true");
  f.git("config", `branch.${branch}.remote`, ".");
  expect(run("")).toBe("false");
}, 60_000);

test("publication accepts another branch's config write during its checks", () => {
  const { fixture, commitFixtureInputs } = createPublicationFixtures(root, roots);
  const f = fixture();
  appendFileSync(path.join(f.dir, "record.ts"), `\nif (process.argv[2] === "tsc") {
    require("node:child_process").execFileSync("git", ["config", "branch.other.remote", "."], { cwd: ${JSON.stringify(f.dir)}, stdio: "pipe" });
  }\n`);
  commitFixtureInputs(f);
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  expect(f.git("config", "branch.other.remote").toString().trim()).toBe(".");
  const transported = f.run(false);
  expect(transported.status, transported.stderr).toBe(0);
}, 60_000);
