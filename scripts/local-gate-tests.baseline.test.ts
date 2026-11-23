import { cliAt, cpSync, expect, fixture, gateTemporaryRoot, mkdirSync, mkdtempSync, path, readFileSync, rmSync, root, roots, source, spawnSync, symlinkSync, test, touchedTests, writeFileSync } from "./local-gate-tests.fixture";


test.each(["green", "new failure", "incomplete"] as const)("eight head files rendezvous before the ninth starts and retain its verdict: %s", outcome => {
  const f = fixture(source(true));
  const markers = path.join(f.dir, "rendezvous"); mkdirSync(markers);
  const files = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].map((word, index) => `${index}-${word}.test.ts`);
  for (const [index, file] of files.slice(0, 8).entries()) writeFileSync(path.join(f.dir, file), `
import { test, expect } from "bun:test";
import { readdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
test("eight concurrent roots", async () => {
  const markers = ${JSON.stringify(markers)}, index = ${index};
  writeFileSync(markers + "/" + index + ".next", process.env.HOME!);
  renameSync(markers + "/" + index + ".next", markers + "/" + index + ".root");
  const until = Date.now() + 8000;
  while (readdirSync(markers).filter(f => f.endsWith(".root")).length < 8 && Date.now() < until) await Bun.sleep(20);
  const roots = readdirSync(markers).filter(f => f.endsWith(".root")).map(f => readFileSync(markers + "/" + f, "utf8"));
  expect(new Set(roots).size).toBe(8);
  writeFileSync(markers + "/" + index + ".done", "done");
}, 10000);`);
  const last = files[8]!;
  writeFileSync(path.join(f.dir, last), 'import { test, expect } from "bun:test"; test("last verdict", () => expect(true).toBe(true));');
  f.git("add", ...files); f.git("commit", "-m", "parallel baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, last), outcome === "incomplete" ? "process.exit(0);" : `
import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";
test("last verdict", () => {
  expect(readdirSync(${JSON.stringify(markers)}).filter(f => f.endsWith(".done")).length).toBeGreaterThan(0);
  expect(${outcome === "green"}).toBe(true);
});`);
  // Restart the real comparator: worker bounds and verdicts owe fresh evidence.
  for (let attempt = 0; attempt < 2; attempt++) {
    rmSync(markers, { recursive: true }); mkdirSync(markers);
    const result = cliAt(f, base, files);
    expect(result.status, result.stdout + result.stderr).toBe(outcome === "green" ? 0 : 1);
    expect(result.stdout).not.toContain("FLAKY");
    if (outcome === "green") expect(result.stdout).toContain("green head; no baseline checkout");
    else {
      expect(result.stdout).toContain(`NEW ${last}: ${outcome === "incomplete" ? "<runner error>" : "last verdict"}`);
      expect(result.stdout).toContain("1 new failures, 0 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
      if (outcome === "new failure") expect(result.stdout).toContain("flaky confirmation 3 rounds per side (maximum 3)");
    }
  }
}, 60_000);

test("full-file and filtered baseline samples rendezvous in one bounded pool", () => {
  const f = fixture(source(true));
  const markers = path.join(f.dir, "baseline-rendezvous"); mkdirSync(markers);
  const files = ["whole.test.ts", "filtered.test.ts"];
  const rendezvous = (own: string, peer: string) => `
  writeFileSync(${JSON.stringify(path.join(markers, own + ".next"))}, process.env.HOME!);
  renameSync(${JSON.stringify(path.join(markers, own + ".next"))}, ${JSON.stringify(path.join(markers, own))});
  const until = Date.now() + 8000;
  while (!existsSync(${JSON.stringify(path.join(markers, peer))}) && Date.now() < until) await Bun.sleep(20);
  expect(existsSync(${JSON.stringify(path.join(markers, peer))})).toBe(true);
  expect(readFileSync(${JSON.stringify(path.join(markers, peer))}, "utf8")).not.toBe(process.env.HOME);`;
  const imports = 'import { test, expect } from "bun:test"; import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";';
  writeFileSync(path.join(f.dir, files[0]!), `${imports}
test("whole baseline", async () => { ${rendezvous("whole", "filtered")} }, 10000);`);
  writeFileSync(path.join(f.dir, files[1]!), `${imports}
test("selected assertion", async () => { ${rendezvous("filtered", "whole")} }, 10000);
test("unselected baseline assertion", () => { throw new Error("must stay filtered"); });`);
  f.git("add", ...files); f.git("commit", "-m", "mixed baseline samples");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, files[0]!), "process.exit(0);");
  writeFileSync(path.join(f.dir, files[1]!), 'import { test, expect } from "bun:test"; test("selected assertion", () => expect(false).toBe(true));');
  for (let attempt = 0; attempt < 2; attempt++) {
    rmSync(markers, { recursive: true }); mkdirSync(markers);
    const result = cliAt(f, base, files);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("NEW whole.test.ts: <runner error>");
    expect(result.stdout).toContain("NEW filtered.test.ts: selected assertion");
    expect(result.stdout).toContain("2 new failures, 0 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
    expect(result.stdout).toContain("flaky confirmation 3 rounds per side (maximum 3)");
    expect(result.stdout).not.toContain("unselected baseline assertion");
  }
});

test("a red branch with an incomplete main sample fails closed", async () => {
  const f = fixture("process.exit(0);");
  writeFileSync(path.join(f.dir, "example.test.ts"), source(false));
  await expect(f.run()).rejects.toThrow("baseline: example.test.ts");
});

test("a red branch samples only failing files and names only failing assertions", async () => {
  const f = fixture('import { test, expect } from "bun:test"; test("red", () => expect(false).toBe(true)); test("unrelated", () => {});');
  writeFileSync(path.join(f.dir, "good.test.ts"), "process.exit(0);");
  f.git("add", "good.test.ts"); f.git("commit", "-m", "broken unrelated baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "good.test.ts"), source(true));
  const result = await touchedTests(f.dir, base, ["good.test.ts", "example.test.ts"], { env: f.env, log: line => f.logs.push(line) });
  expect(result.preexisting).toHaveLength(1); expect(result.introduced).toHaveLength(0);
  expect(f.logs.join("\n")).toContain("1 failing file(s)");
});


test("a base failure needs two matching fresh observations before a later process reuses it", () => {
  const markerRoot = mkdtempSync(path.join(gateTemporaryRoot(), "gate-base-cache-")); roots.push(markerRoot);
  const marker = path.join(markerRoot, "samples");
  const f = fixture(`import { test, expect } from "bun:test"; import { appendFileSync } from "node:fs";
    import { basename } from "node:path"; appendFileSync(${JSON.stringify(marker)}, basename(process.cwd()) === "baseline" ? "base\\n" : "head\\n");
    test("stable old failure", () => expect(false).toBe(true));`);
  const samples = () => readFileSync(marker, "utf8").trim().split("\n").filter(line => line === "base").length;
  const run = () => {
    const cli = cliAt(f, f.base); expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain("PRE-EXISTING example.test.ts: stable old failure"); return cli.stdout;
  };
  run(); expect(samples()).toBe(1);
  run(); expect(samples()).toBe(2);
  expect(run()).toContain("reused baseline"); expect(samples()).toBe(2);
  f.git("commit", "--allow-empty", "-m", "new base");
  const other = cliAt(f, f.git("rev-parse", "HEAD")); expect(other.status).toBe(0); expect(samples()).toBe(3);
});


test("baseline cache misses on changed filters, dependency inputs and origin", () => {
  const f = fixture(`import { test, expect } from "bun:test";
    test("first old", () => expect(false).toBe(true)); test("second old", () => expect(false).toBe(true));`);
  const run = () => { const cli = cliAt(f, f.base); expect(cli.status, cli.stderr).toBe(0); return cli.stdout; };
  run(); run(); expect(run()).toContain("reused baseline");
  writeFileSync(path.join(f.dir, "example.test.ts"), 'import { test, expect } from "bun:test"; test("first old", () => expect(false).toBe(true));');
  expect(run()).not.toContain("reused baseline"); run(); expect(run()).toContain("reused baseline");
  writeFileSync(path.join(f.dir, "package.json"), '{"name":"changed-input"}');
  expect(run()).not.toContain("reused baseline"); run(); expect(run()).toContain("reused baseline");
  f.git("remote", "set-url", "origin", "https://example.invalid/another.git");
  expect(run()).not.toContain("reused baseline");
});

test("two disagreeing base observations never certify a failure", () => {
  const markerRoot = mkdtempSync(path.join(gateTemporaryRoot(), "gate-base-mixed-")); roots.push(markerRoot);
  const marker = path.join(markerRoot, "count");
  const f = fixture(`import { test, expect } from "bun:test"; import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { basename } from "node:path";
    const isBase = basename(process.cwd()) === "baseline";
    const count = isBase && existsSync(${JSON.stringify(marker)}) ? Number(readFileSync(${JSON.stringify(marker)}, "utf8")) : 0;
    if (isBase) writeFileSync(${JSON.stringify(marker)}, String(count + 1));
    test("changing old failure", () => expect(isBase && count % 2 === 1).toBe(true));`);
  for (let index = 0; index < 3; index++) {
    const cli = cliAt(f, f.base); expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).not.toContain("reused baseline");
  }
});

test("a comparator source change invalidates confirmed baseline evidence across processes", () => {
  const f = fixture(source(false));
  const tool = path.join(f.dir, "tool"), scripts = path.join(tool, "scripts");
  cpSync(path.join(root, "scripts"), scripts, { recursive: true });
  for (const file of ["src", "node_modules", "tsconfig.json", "test-preload.ts", "bunfig.toml"])
    symlinkSync(path.join(root, file), path.join(tool, file), ["src", "node_modules"].includes(file) ? "dir" : "file");
  const comparator = path.join(scripts, "local-gate-tests.ts");
  const run = () => {
    const result = spawnSync(process.execPath, [comparator, "--base", f.base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0); return result.stdout;
  };
  run(); run(); expect(run()).toContain("reused baseline");
  writeFileSync(comparator, readFileSync(comparator, "utf8") + "\n// Changed comparator input.\n");
  expect(run()).not.toContain("reused baseline");
});
