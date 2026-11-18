import { execFileSync, expect, fixture, mkdirSync, path, readFileSync, root, spawnSync, test, touchedTests, writeFileSync } from "./local-gate-tests.fixture";

// Cold and warm dependency comparisons keep their real child processes and
// cleanup within the comparator file budget while allowing publication load.
test("a changed dependency patch cannot contaminate or reuse the baseline", async () => {
  const f = fixture('import { test, expect } from "bun:test"; import value from "fixture-dependency"; test("dependency returns true", () => expect(value).toBe(true));');
  const pack = path.join(f.dir, "pack", "package"); mkdirSync(pack, { recursive: true });
  writeFileSync(path.join(pack, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" }));
  writeFileSync(path.join(pack, "index.js"), "module.exports = true;\n");
  execFileSync("tar", ["-czf", path.join(f.dir, "dependency.tgz"), "-C", path.dirname(pack), "package"]);
  writeFileSync(path.join(f.dir, "package.json"), JSON.stringify({ name: "fixture", dependencies: { "fixture-dependency": "file:./dependency.tgz" }, patchedDependencies: { "fixture-dependency@./dependency.tgz": "dependency.patch" } }));
  const patch = (value: string) => `diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = true;\n+module.exports = ${value};\n`;
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("Boolean(1)"));
  const install = (...flags: string[]) => execFileSync(process.execPath, ["install", "--ignore-scripts", ...flags], { cwd: f.dir, env: f.env, stdio: "pipe" });
  install();
  f.git("add", "package.json", "bun.lock", "dependency.tgz", "dependency.patch"); f.git("commit", "-m", "patched baseline");
  const base = f.git("rev-parse", "HEAD"), manifest = readFileSync(path.join(f.dir, "package.json"), "utf8"), lock = readFileSync(path.join(f.dir, "bun.lock"), "utf8");
  const run = () => touchedTests(f.dir, base, ["./example.test.ts"], { env: f.env, log: line => f.logs.push(line) });
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("false")); install("--frozen-lockfile");
  expect(readFileSync(path.join(f.dir, "package.json"), "utf8")).toBe(manifest); expect(readFileSync(path.join(f.dir, "bun.lock"), "utf8")).toBe(lock);
  expect((await run()).introduced).toHaveLength(1);
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("Boolean(1)")); install("--frozen-lockfile");
  expect((await run()).introduced).toHaveLength(0);
  writeFileSync(path.join(f.dir, "dependency.patch"), patch("false")); install("--frozen-lockfile");
  f.logs.length = 0;
  const warm = await run(); expect(warm.introduced).toHaveLength(1); expect(warm.preexisting).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("baseline run");
}, 120_000);


test.each(["relative directory", "local override"])("%s dependencies keep a green baseline and block cold and warm CLI runs", async kind => {
  const check = 'import { test, expect } from "bun:test"; import value from "fixture-dependency"; test("dependency returns true", () => expect(value).toBe(true));';
  const f = fixture(check);
  const dependency = path.join(f.dir, "dependency"); mkdirSync(dependency);
  writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" }));
  writeFileSync(path.join(dependency, "index.js"), "module.exports = true;\n");
  writeFileSync(path.join(f.dir, "package.json"), JSON.stringify(kind === "local override"
    ? { name: "fixture", dependencies: { "fixture-dependency": "1.0.0" }, overrides: { "fixture-dependency": "./dependency" } }
    : { name: "fixture", dependencies: { "fixture-dependency": "./dependency" } }));
  const install = (cwd: string) => execFileSync(process.execPath, ["install", "--ignore-scripts"], { cwd, env: f.env, stdio: "pipe" });
  install(f.dir);
  f.git("add", "package.json", "bun.lock", "dependency"); f.git("commit", "-m", "local dependency baseline");
  const base = f.git("rev-parse", "HEAD");
  const manifest = readFileSync(path.join(f.dir, "package.json"), "utf8"), lock = readFileSync(path.join(f.dir, "bun.lock"), "utf8");
  writeFileSync(path.join(dependency, "index.js"), "module.exports = false;\n");
  writeFileSync(path.join(f.dir, "example.test.ts"), `// harmless edit\n${check}`);
  f.git("add", "dependency/index.js", "example.test.ts"); f.git("commit", "-m", "dependency regression");
  expect(readFileSync(path.join(f.dir, "node_modules/fixture-dependency/index.js"), "utf8")).toContain("false");
  expect(readFileSync(path.join(f.dir, "package.json"), "utf8")).toBe(manifest);
  expect(readFileSync(path.join(f.dir, "bun.lock"), "utf8")).toBe(lock);
  const control = path.join(f.dir, "env", "control");
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", f.dir, control], { env: f.env, stdio: "pipe" });
  execFileSync("git", ["checkout", "--quiet", "--detach", base], { cwd: control, env: f.env, stdio: "pipe" });
  install(control);
  expect(spawnSync(process.execPath, ["test", "./example.test.ts"], { cwd: control, env: f.env }).status).toBe(0);
  expect(spawnSync(process.execPath, ["test", "./example.test.ts"], { cwd: f.dir, env: f.env }).status).toBe(1);
  for (const temperature of ["run", "run"]) {
    const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
    expect(cli.stdout).toContain(`baseline ${temperature}`);
    expect(cli.stdout).toContain("NEW example.test.ts: dependency returns true");
    expect(cli.stdout).toContain("1 new failures, 0 pre-existing failures");
    expect(cli.status).toBe(1);
  }
}, 120_000);
