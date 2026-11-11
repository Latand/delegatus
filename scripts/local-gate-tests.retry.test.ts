import { betweenTests, cliAt, confirmFailures, expect, fixture, FLAKY_BUDGET_MS, FLAKY_RERUNS, path, readFileSync, root, SAME_WAY, scheduledFixture, scheduledSource, source, spawnSync, spyOn, test, type TestRun, type TestSite, touchedTests, writeFileSync } from "./local-gate-tests.fixture";
import { BudgetExhausted, comparatorEnding } from "./local-gate-tests";


test("a base-only scheduled failure is FLAKY with both counts and no unrelated reruns", async () => {
  const f = scheduledFixture([3], [1, 2, 3, 4]);
  const result = await f.run();
  expect(result.introduced).toHaveLength(0); expect(result.flaky).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("FLAKY example.test.ts: inner > outer > target [Ω] (base 2 pass/1 fail; head 0 pass/3 fail)");
  expect(readFileSync(f.marker + "-unrelated", "utf8").trim().split("\n")).toEqual(["head"]);
});

test("a base that failed its first sample needs no reruns even when later samples would differ", async () => {
  const f = scheduledFixture([1], [1, 2, 3, 4]);
  const accepted = f.cli();
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("PRE-EXISTING example.test.ts: inner > outer > target [Ω]");
  expect(accepted.stdout).toContain("0 new failures, 1 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
  expect(readFileSync(f.marker + "-base", "utf8")).toBe("1");
  expect(readFileSync(f.marker + "-head", "utf8")).toBe("1");
});

test.each(["recovers", "changes", "repeats"] as const)("a head-only between-tests error gets one isolated full-file retry: %s", mode => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "diagnostic-runs");
  writeFileSync(path.join(f.dir, "example.test.ts"), `import { test, describe } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const n = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
writeFileSync(marker, String(n));
test("whole file still runs", () => {});
describe("diagnostic", () => {
  if (n === 1 || ${JSON.stringify(mode)} === "repeats") throw new Error("first diagnostic");
  if (${JSON.stringify(mode)} === "changes") throw new Error("second diagnostic");
});`);
  const outcome = cliAt(f, f.base);
  expect(outcome.stderr).not.toContain("gate error");
  expect(readFileSync(marker, "utf8")).toBe("2");
  expect(outcome.status, outcome.stdout + outcome.stderr).toBe(mode === "recovers" ? 0 : 1);
  if (mode === "repeats") expect(outcome.stdout).toContain("NEW example.test.ts: <between-tests error> error: first diagnostic");
  else expect(outcome.stdout).toContain("FLAKY example.test.ts: <between-tests error> error: first diagnostic");
  if (mode === "changes") expect(outcome.stdout).toContain("NEW example.test.ts: <between-tests error> error: second diagnostic");
  // A fresh comparator process must resample rather than reuse the prior pass.
  writeFileSync(marker, "0");
  const restarted = cliAt(f, f.base);
  expect(restarted.status).toBe(outcome.status);
  expect(readFileSync(marker, "utf8")).toBe("2");
});

test("diagnostic retry preserves extra occurrences beyond the base across comparator restarts", () => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "diagnostic-multiplicity");
  const scheduled = `import { test, describe } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const counter = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(run));
test("passing test", () => {});
const errors = side === "base" ? ["A"] : run === 1 ? ["A", "B"] : ["A", "A"];
for (const [index, message] of errors.entries()) describe("diagnostic " + index, () => { throw new Error(message); });`;
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduled);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "diagnostic multiplicity schedule");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "example.test.ts"), `${scheduled}\n// reviewed head`);

  for (let attempt = 0; attempt < 2; attempt++) {
    writeFileSync(marker + "-base", "0");
    writeFileSync(marker + "-head", "0");
    const result = cliAt(f, base);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("NEW example.test.ts: <between-tests error> error: A");
    expect(result.stdout).toContain("FLAKY example.test.ts: <between-tests error> error: B");
    expect(result.stdout).toContain("1 new failures, 1 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
  }
});

test("a between-tests error present on both sides is PRE-EXISTING from the CLI and never blocks", async () => {
  const f = fixture(betweenTests("describe boom"));
  const accepted = cliAt(f, f.base);
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain(`PRE-EXISTING example.test.ts: <between-tests error> error: describe boom ${SAME_WAY}`);
  expect(accepted.stdout).toContain("PRE-EXISTING example.test.ts: steady red\n");
  expect(accepted.stdout).toContain("0 new failures, 2 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
  expect(accepted.stdout).not.toContain("gate error"); expect(accepted.stderr).not.toContain("gate error");
});

test("a retry in a file whose base is broken the same way still confirms its candidates", async () => {
  const f = fixture(source(true));
  const counter = path.join(f.dir, "between-schedule");
  const recovering = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const run = existsSync(${JSON.stringify(counter)} + side) ? Number(readFileSync(${JSON.stringify(counter)} + side, "utf8")) + 1 : 1;
writeFileSync(${JSON.stringify(counter)} + side, String(run));
test("recovers", () => expect(side === "base" || run > 1).toBe(true));
test("stays red", () => expect(side === "base").toBe(true));`;
  writeFileSync(path.join(f.dir, "example.test.ts"), betweenTests("describe boom", recovering));
  f.git("add", "example.test.ts"); f.git("commit", "-m", "broken base with a head-only schedule");
  const refused = cliAt(f, f.git("rev-parse", "HEAD"));
  expect(refused.stderr).not.toContain("gate error");
  expect(refused.stdout).toContain("FLAKY example.test.ts: recovers (base 2 pass/0 fail; head 1 pass/1 fail)");
  expect(refused.stdout).toContain("NEW example.test.ts: stays red");
  expect(refused.stdout).toContain(`PRE-EXISTING example.test.ts: <between-tests error> error: describe boom ${SAME_WAY}`);
  expect(refused.stdout).toContain("1 new failures, 2 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
  expect(refused.status).toBe(1);
});

test("a file that cannot finish on either side in the same way is PRE-EXISTING from the CLI and is never cached", async () => {
  const f = fixture("process.exit(0);");
  writeFileSync(path.join(f.dir, "example.test.ts"), "// harmless edit\nprocess.exit(0);");
  const accepted = cliAt(f, f.base);
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toMatch(/PRE-EXISTING example\.test\.ts: <runner error> .+ \(the base run of this file is broken the same way\)/);
  expect(accepted.stdout).toContain("0 new failures, 1 pre-existing failures, 0 fixed, 0 removed/skipped, 0 flaky");
  expect((await f.run()).preexisting).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("baseline run");
});

test("a between-tests error only on the head, or a different one, is NEW from the CLI and blocks", async () => {
  const f = fixture(betweenTests(null));
  writeFileSync(path.join(f.dir, "example.test.ts"), betweenTests("describe boom"));
  const headOnly = cliAt(f, f.base);
  expect(headOnly.status).toBe(1);
  expect(headOnly.stdout).toContain("NEW example.test.ts: <between-tests error> error: describe boom\n");
  expect(headOnly.stdout).not.toContain(SAME_WAY);
  expect(headOnly.stdout).toContain("1 new failures, 1 pre-existing failures");
  f.git("add", "example.test.ts"); f.git("commit", "-m", "broken base");
  writeFileSync(path.join(f.dir, "example.test.ts"), betweenTests("another boom"));
  const different = cliAt(f, f.git("rev-parse", "HEAD"));
  expect(different.status).toBe(1);
  expect(different.stdout).toContain("NEW example.test.ts: <between-tests error> error: another boom\n");
  expect(different.stdout).toContain("1 new failures, 1 pre-existing failures, 1 fixed");
});

test("a head that cannot finish a file the base finished is NEW from the CLI and blocks", async () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "example.test.ts"), "process.exit(0);");
  const refused = cliAt(f, f.base);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toMatch(/NEW example\.test\.ts: <runner error> /);
  expect(refused.stdout).not.toContain(SAME_WAY);
});

test("a head scheduled recovery passes CLI and never caches a head pass", async () => {
  const f = scheduledFixture([], [1]);
  const accepted = f.cli();
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("FLAKY example.test.ts: inner > outer > target [Ω] (base 2 pass/0 fail; head 1 pass/1 fail)");
  // Keep the baseline key and turn only the head into a stable regression.
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduledSource(f.marker, [], [3, 4, 5, 6]));
  const refused = f.cli();
  expect(refused.status).toBe(1); expect(refused.stdout).toContain("baseline run");
  expect(refused.stdout).toContain("NEW example.test.ts: inner > outer > target [Ω]");
});

test("the stable regression control fails every head sample and refuses CLI", async () => {
  const f = scheduledFixture([], [1, 2, 3, 4]);
  const refused = f.cli();
  expect(refused.status).toBe(1); expect(refused.stdout).toContain("NEW example.test.ts: inner > outer > target [Ω]");
  expect(refused.stdout).not.toContain("FLAKY example.test.ts");
  expect(readFileSync(f.marker + "-base", "utf8")).toBe("4");
  expect(readFileSync(f.marker + "-head", "utf8")).toBe("4");
});

test("a completed recovery leaves later confirmation budget unused across comparator restarts", () => {
  const f = scheduledFixture([], [1]);
  writeFileSync(path.join(f.dir, "example.test.ts"), `${scheduledSource(f.marker, [], [1])}
if (run > 2) throw new Error("settled retry consumed another round");`);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "bounded recovery schedule");
  const base = f.git("rev-parse", "HEAD");
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const side of ["base", "head"]) writeFileSync(f.marker + "-" + side, "0");
    const outcome = cliAt(f, base);
    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain("flaky confirmation 1 round per side (maximum 3)");
    for (const side of ["base", "head"]) expect(readFileSync(f.marker + "-" + side, "utf8")).toBe("2");
  }
});

test("later rounds select only unresolved assertions and still refuse a stable head-only failure", () => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "selective-confirmation");
  const trace = path.join(f.dir, "confirmation-trace");
  const scheduled = `import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const counter = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(run));
const record = (name) => appendFileSync(${JSON.stringify(trace)}, side + ":" + run + ":" + name + "\\n");
test("recovers", () => { record("recovers"); expect(side === "base" || run > 1).toBe(true); });
test("stable", () => { record("stable"); expect(side === "base").toBe(true); });`;
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduled);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "mixed confirmation schedule");
  const base = f.git("rev-parse", "HEAD");
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const side of ["base", "head"]) writeFileSync(marker + "-" + side, "0");
    writeFileSync(trace, "");
    const outcome = cliAt(f, base);
    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(1);
    expect(outcome.stderr).not.toContain("gate error");
    expect(outcome.stdout).toContain("NEW example.test.ts: stable");
    expect(outcome.stdout).toContain("FLAKY example.test.ts: recovers (base 2 pass/0 fail; head 1 pass/1 fail)");
    const observations = readFileSync(trace, "utf8").trim().split("\n");
    for (const side of ["base", "head"]) {
      expect(observations.filter(line => line.startsWith(side + ":") && line.endsWith(":recovers")))
        .toEqual([`${side}:1:recovers`, `${side}:2:recovers`]);
      expect(observations.filter(line => line.startsWith(side + ":") && line.endsWith(":stable")))
        .toEqual([1, 2, 3, 4].map(run => `${side}:${run}:stable`));
    }
  }
});

test("recovering one duplicate-name occurrence leaves the stable occurrence NEW", async () => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "duplicate-schedule");
  const trace = path.join(f.dir, "duplicate-trace");
  const duplicate = `import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const counter = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(run));
let occurrence = 0;
const check = () => { const index = occurrence++; appendFileSync(${JSON.stringify(trace)}, side + ":" + run + ":" + index + "\\n"); expect(index === 0 ? side === "base" : side === "base" || run > 1).toBe(true); };
test("same name", check);
test("same name", check);`;
  writeFileSync(path.join(f.dir, "example.test.ts"), duplicate);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "duplicate identity baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "example.test.ts"), duplicate);
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(1);
  expect(cli.stdout).toContain("FLAKY example.test.ts: same name");
  expect(cli.stdout).toContain("NEW example.test.ts: same name");
  expect(cli.stdout).toContain("1 new failures, 0 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
  expect(readFileSync(trace, "utf8").trim().split("\n").filter(line => line.startsWith("head:")).length).toBe(8);
});

test("overlapping base and head retry evidence belongs to separate duplicate occurrences", async () => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "overlapping-duplicate-schedule");
  const duplicate = `import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const counter = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(run));
let occurrence = 0;
const check = () => { const index = occurrence++; expect(index === 0 ? side === "base" : side === "base" ? run !== 2 : run > 1).toBe(true); };
test("same name", check);
test("same name", check);`;
  writeFileSync(path.join(f.dir, "example.test.ts"), duplicate);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "overlapping duplicate schedule");
  const base = f.git("rev-parse", "HEAD");
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(cli.status).toBe(1);
  expect(cli.stdout).toContain("NEW example.test.ts: same name");
  expect(cli.stdout).toContain("FLAKY example.test.ts: same name (base 1 pass/1 fail; head 1 pass/1 fail)");
  expect(cli.stdout).toContain("1 new failures, 0 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
});

test("any passing head retry makes an occurrence FLAKY", async () => {
  const f = scheduledFixture([], [1, 2, 4]);
  const accepted = f.cli();
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("FLAKY example.test.ts: inner > outer > target [Ω] (base 3 pass/0 fail; head 1 pass/2 fail)");
  expect(accepted.stdout).toContain("0 new failures, 0 pre-existing failures");
});

test("a literal describe separator is filtered inside nested suite ancestry", async () => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "literal-separator");
  const literal = `import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const file = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
writeFileSync(file, String(run));
describe("outer", () => describe("one > two", () => {
  test("case", () => expect(side === "base" || run > 1).toBe(true));
  test("unrelated", () => appendFileSync(${JSON.stringify(marker)} + "-unrelated", side + "\\n"));
}));`;
  writeFileSync(path.join(f.dir, "example.test.ts"), literal);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "literal suite baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "example.test.ts"), literal);
  const result = await touchedTests(f.dir, base, ["./example.test.ts"], { env: f.env, log: line => f.logs.push(line) });
  expect(result.introduced).toHaveLength(0);
  expect(result.flaky).toHaveLength(1);
  expect(f.logs.join("\n")).toContain("FLAKY example.test.ts: one > two > outer > case (base 2 pass/0 fail; head 1 pass/1 fail)");
  expect(readFileSync(marker + "-unrelated", "utf8").trim().split("\n")).toEqual(["head"]);
});

test("the retry bound stays small and incomplete samples cannot become FLAKY", async () => {
  expect(FLAKY_RERUNS).toBe(3); expect(FLAKY_BUDGET_MS).toBe(300000);
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test" };
  const run = (failures: TestSite[], passed: TestSite[]): TestRun => ({ failures, passed, completed: [site.file], elapsedMs: 0 });
  const base = run([], [site]), head = run([site], []);
  await expect(confirmFailures(base, head, side => side === "base" ? base : run([], []))).rejects.toThrow("missing or skipped test");
  await expect(confirmFailures(base, head, () => run([{ ...site, kind: "error" }], []))).rejects.toThrow("incomplete runner");
  await expect(confirmFailures(base, head, () => { throw new Error("flaky rerun budget exhausted"); })).rejects.toThrow("budget exhausted");
  // A passing duplicate cannot certify recovery of another stable failing copy.
  const first = { ...site, occurrence: 0 }, second = { ...site, occurrence: 1 };
  const duplicate = run([first, second], []);
  expect((await confirmFailures(run([], [first, second]), duplicate, side => side === "base" ? run([], [first, second]) : duplicate)).introduced).toHaveLength(2);
});

test("a failing base retry still requires a complete paired head sample before retirement", async () => {
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test", occurrence: 0 };
  const sample = (failures: TestSite[], passed: TestSite[]): TestRun => ({ failures, passed, completed: [site.file], elapsedMs: 0 });
  const base = sample([], [site]), head = sample([site], []);
  await expect(confirmFailures(base, head, side => side === "base" ? head : sample([], [])))
    .rejects.toThrow("head rerun: missing or skipped test");
  await expect(confirmFailures(base, head, side => side === "base" ? head : sample([{ ...site, kind: "error", name: "new diagnostic" }], [])))
    .rejects.toThrow("head rerun: incomplete runner or between-tests error");
});

test.each(["accepts", "refuses"] as const)("confirmation sides overlap and await their peer when the base %s", async mode => {
  const refuse = mode === "refuses";
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test", occurrence: 0 };
  const base: TestRun = { failures: [], passed: [site], completed: [site.file], elapsedMs: 0 };
  const head: TestRun = { ...base, failures: [site], passed: [] };
  const entered: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const confirmation = confirmFailures(base, head, async side => {
    entered.push(side);
    if (side === "base" && refuse) throw new Error("base refusal");
    await held;
    return base;
  });
  const observed = confirmation.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  let assertionError: unknown;
  try {
    await Promise.resolve();
    expect(entered).toEqual(["base", "head"]);
    expect(settled).toBe(false);
  } catch (error) { assertionError = error; }
  finally { release(); }
  const outcome = await observed;
  if (assertionError) throw assertionError;
  if ("error" in outcome) {
    expect(refuse).toBe(true);
    expect(outcome.error.message).toBe("base refusal");
  } else {
    expect(refuse).toBe(false);
    expect(outcome.value.introduced).toHaveLength(0);
    expect(outcome.value.flaky).toHaveLength(1);
  }
});

test.each(["base", "head", "both", "neither"] as const)("confirmation preserves ordinary peer refusals when %s sides exhaust their budget", async budgetSide => {
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test", occurrence: 0 };
  const base: TestRun = { failures: [], passed: [site], completed: [site.file], elapsedMs: 0 };
  const head: TestRun = { ...base, failures: [site], passed: [] };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered: string[] = [];
  const confirmation = confirmFailures(base, head, async side => {
    entered.push(side);
    await held;
    if (side === budgetSide || budgetSide === "both") throw new BudgetExhausted(`${side} deadline`);
    throw new Error(`${side} cleanup refusal`);
  });
  const observed = confirmation.catch(error => error);
  try { expect(entered).toEqual(["base", "head"]); }
  finally { release(); }
  const ending = comparatorEnding(await observed);
  expect(ending.code).toBe(budgetSide === "both" ? 75 : 1);
  for (const side of ["base", "head"]) {
    if (side !== budgetSide && budgetSide !== "both") expect(ending.line).toContain(`${side} cleanup refusal`);
  }
});

test.each(["base", "head"] as const)("confirmation checks a completed peer's runner diagnostics before the %s deadline", async budgetSide => {
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test", occurrence: 0 };
  const diagnostic: TestSite = { file: site.file, suite: "", name: "<runner error> cleanup refusal", kind: "error" };
  // Existing diagnostics retain their comparison policy; only a newly observed
  // runner failure is decisive when the other side runs out of time.
  for (const known of [false, true]) {
    const base: TestRun = { failures: known ? [diagnostic] : [], passed: [site], completed: [site.file], elapsedMs: 0 };
    const head: TestRun = { ...base, failures: [site, ...base.failures], passed: [] };
    const error = await confirmFailures(base, head, async side => {
      if (side === budgetSide) throw new BudgetExhausted(`${side} deadline`);
      return { ...base, failures: [diagnostic] };
    }).catch(error => error);
    const ending = comparatorEnding(error);
    expect(ending.code).toBe(known ? 75 : 1);
    if (!known) expect(ending.line).toContain(`${budgetSide === "base" ? "head" : "base"} rerun: incomplete runner or between-tests error`);
  }
});

test.each(["base", "head"] as const)("confirmation checks a completed peer's test counts before the %s deadline", async budgetSide => {
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test", occurrence: 0 };
  const base: TestRun = { failures: [], passed: [site], completed: [site.file], elapsedMs: 0 };
  const head: TestRun = { ...base, failures: [site], passed: [] };
  const error = await confirmFailures(base, head, async side => {
    if (side === budgetSide) throw new BudgetExhausted(`${side} deadline`);
    return { ...base, passed: [] };
  }).catch(error => error);
  const ending = comparatorEnding(error);
  expect(ending.code).toBe(1);
  expect(ending.line).toContain(`${budgetSide === "base" ? "head" : "base"} rerun: missing or skipped test example.test.ts: target`);
});

test.each(["assertion confirmation", "diagnostic retry"] as const)("initial file refusals survive a later %s deadline", async boundary => {
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test", occurrence: 0 };
  const transient: TestSite = { ...site, name: "<between-tests error> transient", kind: "error" };
  for (const reason of ["owned runner: surviving owned processes: 123", "hook cleanup failed", "incomplete report", "runner did not finish (124)"]) {
    const diagnostic: TestSite = { ...site, name: `${reason.startsWith("owned runner:") ? "<ownership error>" : "<runner error>"} ${reason}`, kind: "error" };
    for (const known of [false, true]) {
      const base: TestRun = { failures: known ? [diagnostic] : [], passed: [site], completed: [site.file], elapsedMs: 0 };
      const head: TestRun = { ...base, failures: [site, diagnostic, ...(boundary === "diagnostic retry" ? [transient] : [])], passed: [] };
      const calls: string[] = [];
      const error = await confirmFailures(base, head, side => {
        calls.push(side);
        if (side === "head") throw new BudgetExhausted("head confirmation deadline");
        return base;
      }).catch(error => error);
      const ending = comparatorEnding(error);
      expect(calls).toEqual(boundary === "diagnostic retry" ? ["head"] : ["base", "head"]);
      const blocking = !known && reason !== "runner did not finish (124)";
      expect(ending.code).toBe(blocking ? 1 : 75);
      expect(ending.line).toContain("head confirmation deadline");
      if (blocking) {
        expect(ending.line).toContain(`NEW example.test.ts: ${diagnostic.name}`);
        expect(ending.line).toContain("gate error (blocking)");
      }
    }
  }
});

test.each(["repeated between-tests error", "new ownership error"] as const)("a completed diagnostic retry retains its %s before a later deadline", async mode => {
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test", occurrence: 0 };
  const diagnostic: TestSite = { ...site, name: "<between-tests error> transient", kind: "error" };
  const retained: TestSite = mode === "new ownership error"
    ? { ...diagnostic, name: "<runner error> owned runner: surviving owned processes: 123" } : diagnostic;
  const base: TestRun = { failures: [], passed: [site], completed: [site.file], elapsedMs: 0 };
  const head: TestRun = { ...base, failures: [site, diagnostic], passed: [] };
  const error = await confirmFailures(base, head, (side, sites) => {
    if (sites.some(site => site.kind === "error")) return { ...head, failures: [site, retained] };
    if (side === "head") throw new BudgetExhausted("later confirmation deadline");
    return base;
  }).catch(error => error);
  const ending = comparatorEnding(error);
  expect(ending.code).toBe(1);
  expect(ending.line).toContain(`NEW example.test.ts: ${retained.name}`);
  expect(ending.line).toContain("later confirmation deadline");
});

test("an unconfirmed between-tests diagnostic alone retains the deadline policy", async () => {
  const diagnostic: TestSite = { file: "example.test.ts", suite: "", name: "<between-tests error> transient", kind: "error" };
  const base: TestRun = { failures: [], passed: [], completed: [diagnostic.file], elapsedMs: 0 };
  const error = await confirmFailures(base, { ...base, failures: [diagnostic] }, () => {
    throw new BudgetExhausted("diagnostic retry deadline");
  }).catch(error => error);
  expect(comparatorEnding(error).code).toBe(75);
});

const serviceTest = test.skipIf(process.platform !== "linux"
  || spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status !== 0);
serviceTest.each(["timeout first", "cleanup first", "only timeouts"] as const)("filtered worker refusals survive comparator restarts: %s", mode => {
  const timeout = 'import { test } from "bun:test"; test("contract", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000));';
  const cleanup = `import { test } from "bun:test";
test("contract", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).unref(); process.exit(0)'], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  process.exit(0);
});`;
  const f = fixture(source(true));
  const files = ["a.test.ts", "b.test.ts"];
  const cleanupFile = mode === "cleanup first" ? files[0]! : files[1]!;
  for (const file of files) writeFileSync(path.join(f.dir, file), mode !== "only timeouts" && file === cleanupFile ? cleanup : timeout);
  f.git("add", "."); f.git("commit", "-m", "Filtered worker refusal baseline");
  const base = f.git("rev-parse", "HEAD");
  for (const file of files) writeFileSync(path.join(f.dir, file), 'import { test, expect } from "bun:test"; test("contract", () => expect(false).toBe(true));');
  const driver = path.join(f.dir, "driver.ts");
  writeFileSync(driver, `import { touchedTests, comparatorEnding } from ${JSON.stringify(path.join(root, "scripts/local-gate-tests.ts"))};
import { publicationDeadlineOnly } from ${JSON.stringify(path.join(root, "src/lib/pipelines/publication.ts"))};
try { await touchedTests(${JSON.stringify(f.dir)}, ${JSON.stringify(base)}, ${JSON.stringify(files)}, { budgets: { fileMs: 3500, runMs: 60000 } }); }
catch (error) { const ending = comparatorEnding(error); console.log(ending.line); console.log("retryable=" + publicationDeadlineOnly(ending.line)); process.exitCode = ending.code; }`);
  // Restart the real comparator: no in-memory state may conceal a refusal on
  // the next publication attempt. The owned runners reap the fixture children.
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = spawnSync(process.execPath, [driver], { cwd: f.dir, env: f.env, encoding: "utf8", timeout: 30000 });
    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(mode === "only timeouts" ? 75 : 1);
    expect(outcome.stdout).toContain(`retryable=${mode === "only timeouts"}`);
    if (mode === "only timeouts") expect(outcome.stdout).toContain("nothing was judged");
    else {
      expect(outcome.stdout).toContain(`baseline: ${cleanupFile}:`);
      expect(outcome.stdout).toContain("owned runner: surviving owned processes:");
      expect(outcome.stdout).toContain("gate error (blocking)");
    }
  }
}, 60000);

serviceTest.each(["head-only cleanup", "pre-existing cleanup", "no cleanup"] as const)("initial refusal precedence survives comparator restarts: %s", mode => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "initial-refusal-runs");
  const scheduled = `import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const marker = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
writeFileSync(marker, String(run));
test("contract", async () => {
  if (side === "head" && run === 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  if (run === 1 && (${JSON.stringify(mode)} === "pre-existing cleanup" || (${JSON.stringify(mode)} === "head-only cleanup" && side === "head"))) {
    const child = Bun.spawn([process.execPath, "-e", 'require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).unref(); process.exit(0)'], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
  }
  expect(side === "base" || run > 1).toBe(true);
});`;
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduled);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "Initial refusal baseline");
  const base = f.git("rev-parse", "HEAD");
  writeFileSync(path.join(f.dir, "example.test.ts"), `${scheduled}\n// reviewed head`);
  const driver = path.join(f.dir, "driver.ts");
  writeFileSync(driver, `import { touchedTests, comparatorEnding } from ${JSON.stringify(path.join(root, "scripts/local-gate-tests.ts"))};
import { publicationDeadlineOnly } from ${JSON.stringify(path.join(root, "src/lib/pipelines/publication.ts"))};
try { const result = await touchedTests(${JSON.stringify(f.dir)}, ${JSON.stringify(base)}, ["example.test.ts"], { budgets: { fileMs: 2500, runMs: 60000 } }); process.exitCode = result.introduced.length ? 1 : 0; }
catch (error) { const ending = comparatorEnding(error); console.log(ending.line); console.log("retryable=" + publicationDeadlineOnly(ending.line)); process.exitCode = ending.code; }`);
  const invoke = () => spawnSync(process.execPath, [driver], { cwd: f.dir, env: f.env, encoding: "utf8", timeout: 30000 });
  for (let attempt = 0; attempt < 2; attempt++) {
    writeFileSync(marker + "-head", "0"); writeFileSync(marker + "-base", "0");
    const outcome = invoke();
    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(mode === "head-only cleanup" ? 1 : 75);
    expect(outcome.stdout).toContain(`retryable=${mode !== "head-only cleanup"}`);
    expect(outcome.stdout).toContain("head rerun: example.test.ts: runner did not finish (124)");
    if (mode === "head-only cleanup") {
      expect(outcome.stdout).toContain("NEW example.test.ts: <ownership error> owned runner: surviving owned processes:");
      expect(outcome.stdout).toContain("gate error (blocking)");
    }
    const next = invoke();
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).toContain("green head; no baseline checkout or sample needed");
  }
}, 60000);


test("the shared retry deadline blocks before another child starts", async () => {
  const f = fixture(source(true));
  writeFileSync(path.join(f.dir, "example.test.ts"), source(false));
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    await expect(touchedTests(f.dir, f.base, ["./example.test.ts"], { env: f.env, log: line => {
      if (line.startsWith("touched-tests: baseline run ")) {
        // The budget starts at zero, then advances past the shared deadline.
        clock = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(FLAKY_BUDGET_MS + 1);
      }
    } })).rejects.toThrow("flaky rerun budget");
  } finally { clock?.mockRestore(); }
});

test("a filtered retry that executes past its file budget returns no verdict", async () => {
  const f = scheduledFixture([], [1, 2, 3, 4]);
  writeFileSync(path.join(f.dir, "example.test.ts"), `${scheduledSource(f.marker, [], [1, 2, 3, 4])}
if (side === "head" && run > 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);`);
  await expect(touchedTests(f.dir, f.git("rev-parse", "HEAD"), ["./example.test.ts"], {
    env: f.env, log: () => {}, budgets: { fileMs: 5000, runMs: 60000 },
  })).rejects.toBeInstanceOf(BudgetExhausted);
}, 30000);
