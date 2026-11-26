import { cliAt, confirmFailures, expect, fixture, FLAKY_BUDGET_MS, FLAKY_RERUNS, path, readFileSync, root, scheduledFixture, scheduledSource, source, spawnSync, spyOn, test, type TestRun, type TestSite, touchedTests, writeFileSync } from "./local-gate-tests.fixture";
import { BudgetExhausted, comparatorEnding } from "./local-gate-tests";
test("the retry bound stays small and incomplete samples cannot become FLAKY", async () => {
  expect(FLAKY_RERUNS).toBe(3); expect(FLAKY_BUDGET_MS).toBe(300000);
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test" };
  const run = (failures: TestSite[], passed: TestSite[]): TestRun => ({ failures, passed, completed: [site.file], elapsedMs: 0 });
  const base = run([], [site]), head = run([site], []);
  await expect(confirmFailures(base, head, side => side === "base" ? base : run([], []))).rejects.toThrow("missing or skipped test");
  await expect(confirmFailures(base, head, () => run([{ ...site, kind: "error" }], []))).rejects.toThrow("missing or skipped test");
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
  const diagnostic: TestSite = { ...site, kind: "error", name: "<hook error> new diagnostic" };
  const outcome = await confirmFailures(base, head, side => side === "base" ? head : sample([diagnostic], [site]));
  expect(outcome.introduced).toEqual([diagnostic]);
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
    if (!known) {
      expect(ending.line).toContain(`${budgetSide === "base" ? "head" : "base"} rerun: incomplete runner or between-tests error`);
      expect(ending.line).toContain(`${diagnostic.file}: ${diagnostic.name}`);
    }
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
      expect(calls).toEqual(["base", "head"]);
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
    if (sites.some(site => site.kind === "error")) return side === "base" ? base : { ...head, failures: [site, retained] };
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

test.each([true, false] as const)("a later deadline respects whether the same-selection diagnostic was already matched: %s", async matched => {
  const site: TestSite = { file: "example.test.ts", suite: "", name: "target", kind: "test", occurrence: 0 };
  const diagnostic: TestSite = { file: site.file, suite: "", name: "<hook error> shared tail", kind: "error", selection: "filtered", provenance: "at sourceFault (<checkout>/example.test.ts:8:2)" };
  const otherOrigin = { ...diagnostic, provenance: "at unrelatedFault (<checkout>/example.test.ts:18:2)" };
  const base: TestRun = { failures: [], passed: [site], completed: [site.file], elapsedMs: 0 };
  const head: TestRun = { ...base, failures: [site], passed: [] };
  let headRounds = 0;
  const error = await confirmFailures(base, head, side => {
    if (side === "base") return { ...base, failures: [matched ? diagnostic : otherOrigin] };
    headRounds++;
    if (headRounds === 1) return { ...head, failures: [site, diagnostic], passed: [] };
    throw new BudgetExhausted("confirmation deadline");
  }).catch(error => error);
  expect(comparatorEnding(error).code).toBe(matched ? 75 : 1);
});

test.each(["deadline", "completed", "no retry refusal", "pre-existing retry refusal"] as const)("diagnostic retry assertions keep their verdict across comparator processes: %s", mode => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "retry-assertion-runs");
  const scheduled = `import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const marker = ${JSON.stringify(marker)} + "-" + side;
const run = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
writeFileSync(marker, String(run));
test("A initial assertion", () => expect(side === "base" || run > 2).toBe(true));
test("B retry regression", () => expect(side === "base"
  ? ${JSON.stringify(mode)} !== "pre-existing retry refusal"
  : run !== 2 || ${JSON.stringify(mode)} === "no retry refusal").toBe(true));
describe("diagnostic", () => { if (side === "head" && run === 1) throw new Error("E initial diagnostic"); });`;
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduled);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "Diagnostic retry assertion schedule");
  const base = f.git("rev-parse", "HEAD");
  const driver = path.join(f.dir, "driver.ts");
  writeFileSync(driver, `import { touchedTests, comparatorEnding, FLAKY_BUDGET_MS } from ${JSON.stringify(path.join(root, "scripts/local-gate-tests.ts"))};
import { publicationDeadlineOnly } from ${JSON.stringify(path.join(root, "src/lib/pipelines/publication.ts"))};
// Only the comparator clock advances. The real test processes complete their
// reports and cleanup before the next filtered confirmation is denied admission.
let now = 0;
Object.defineProperty(performance, "now", { value: () => now });
try {
  const result = await touchedTests(${JSON.stringify(f.dir)}, ${JSON.stringify(base)}, ["example.test.ts"], { log: line => {
    console.log(line);
    if (${JSON.stringify(mode)} !== "completed" && line.startsWith("touched-tests: head rerun file ")) now = FLAKY_BUDGET_MS + 1;
  } });
  console.log("retryable=false"); process.exitCode = result.introduced.length ? 1 : 0;
} catch (error) { const ending = comparatorEnding(error); console.log(ending.line); console.log("retryable=" + publicationDeadlineOnly(ending.line)); process.exitCode = ending.code; }`);
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const side of ["base", "head"]) writeFileSync(marker + "-" + side, "0");
    const outcome = spawnSync(process.execPath, [driver], { cwd: f.dir, env: f.env, encoding: "utf8", timeout: 30000 });
    const blocking = mode === "deadline" || mode === "completed";
    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(blocking ? 1 : 75);
    expect(outcome.stdout).toContain(`retryable=${!blocking}`);
    expect(outcome.stdout).toContain("touched-tests: head rerun file example.test.ts:");
    if (blocking) expect(outcome.stdout).toContain("NEW example.test.ts: B retry regression");
    else expect(outcome.stdout).not.toContain("NEW example.test.ts:");
    if (mode !== "completed") {
      expect(outcome.stdout).toContain("flaky rerun budget");
      expect(readFileSync(marker + "-head", "utf8")).toBe("2");
      expect(outcome.stdout).not.toContain("NEW example.test.ts: A initial assertion");
    }
    // The schedule becomes green in a fresh process; it cannot undo the
    // established refusal or turn that refusal into an automatic retry.
    const next = cliAt(f, base);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).toContain("green head; no baseline checkout or sample needed");
  }
});

test.each(["base", "head"] as const)("diagnostic retry assertions retain later %s exit causes", async failingSide => {
  const initial: TestSite = { file: "example.test.ts", suite: "", name: "A initial assertion", kind: "test", occurrence: 0 };
  const added: TestSite = { ...initial, suite: "contract", name: "B retry regression" };
  const diagnostic: TestSite = { ...initial, name: "<between-tests error> transient", kind: "error" };
  const base: TestRun = { failures: [], passed: [initial, added], completed: [initial.file], elapsedMs: 0 };
  const head: TestRun = { ...base, failures: [initial, diagnostic], passed: [added] };
  for (const cause of [new BudgetExhausted("confirmation deadline"), new Error("confirmation cancelled"),
    new Error("ownership refused"), new Error("cleanup refused")]) {
    const error = await confirmFailures(base, head, (side, sites) => {
      if (sites.some(site => site.kind === "error")) return side === "base" ? base : { ...head, failures: [initial, added], passed: [] };
      if (side === failingSide) throw cause;
      return side === "base" ? base : { ...head, failures: [initial], passed: [added] };
    }).catch(error => error);
    const ending = comparatorEnding(error);
    expect(ending.code).toBe(1);
    expect(ending.line).toContain(cause.message);
    expect(ending.line).toContain("NEW example.test.ts: contract > B retry regression");
    expect(ending.line).not.toContain("NEW example.test.ts: A initial assertion");
  }
});

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
