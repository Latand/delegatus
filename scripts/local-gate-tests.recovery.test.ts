import { betweenTests, cliAt, expect, fixture, path, readFileSync, root, SAME_WAY, scheduledFixture, scheduledSource, source, spawnSync, test, touchedTests, writeFileSync } from "./local-gate-tests.fixture";

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

test.each([
  ["between-tests", "shared"], ["hook", "shared"],
  ["between-tests", "head-only"], ["hook", "head-only"],
  ["between-tests", "no diagnostic"],
] as const)("paired CLI confirmation judges %s diagnostics (%s)", (kind, mode) => {
  const f = fixture(source(true));
  const counter = path.join(f.dir, "paired-diagnostics");
  const schedule = `import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const marker = ${JSON.stringify(counter)} + "-" + side;
const run = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
writeFileSync(marker, String(run));
test("contract", () => expect(side === "base" || run !== 1).toBe(true));
const mode = ${JSON.stringify(mode)};
if (run === 2 && (mode === "shared" || (mode === "head-only" && side === "head"))) {
  if (${JSON.stringify(kind)} === "hook") afterAll(() => {
    const pid = side === "base" ? 21 : 31;
    throw new Error(\`owned test scope children survived teardown: \${pid} (\${pid}:1)\`);
  });
  else {
    describe("confirmation diagnostic", () => { throw new TypeError("confirmation tail"); });
    if (side === "base") describe("additional base diagnostic", () => { throw new Error("base storage unavailable"); });
  }
}`;
  writeFileSync(path.join(f.dir, "example.test.ts"), schedule);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "Paired confirmation schedule");
  const outcome = cliAt(f, f.git("rev-parse", "HEAD"));
  expect(outcome.status, outcome.stdout + outcome.stderr).toBe(mode === "head-only" ? 1 : 0);
  expect(readFileSync(counter + "-base", "utf8")).toBe("2");
  expect(readFileSync(counter + "-head", "utf8")).toBe("2");
  expect(outcome.stdout).toContain("FLAKY example.test.ts: contract (base 2 pass/0 fail; head 1 pass/1 fail)");
  if (mode === "no diagnostic") return;
  const expected = kind === "hook" ? "<hook error> owned test scope children survived teardown: 31 (31:1)" : "<between-tests error> TypeError: confirmation tail";
  expect(outcome.stdout).toContain(`${mode === "shared" ? "PRE-EXISTING" : "NEW"} example.test.ts: ${expected}`);
  if (mode === "shared") expect(outcome.stdout).toContain(`Base diagnostic example.test.ts: ${expected.replace("31 (31:1)", "21 (21:1)")}`);
});

test("paired full-file confirmation can reproduce an initially head-only diagnostic on base", () => {
  const f = fixture(source(true));
  const counter = path.join(f.dir, "full-diagnostics");
  const schedule = `import { describe, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const base = basename(process.cwd()) === "baseline";
const marker = ${JSON.stringify(counter)};
test("contract", () => {});
const repeated = existsSync(marker);
if (base) writeFileSync(marker, "sampled");
if (!base || repeated) describe("diagnostic", () => { throw new Error("repeated full diagnostic"); });`;
  writeFileSync(path.join(f.dir, "example.test.ts"), schedule);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "Full diagnostic confirmation schedule");
  const outcome = cliAt(f, f.git("rev-parse", "HEAD"));
  expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
  expect(outcome.stdout).toContain("PRE-EXISTING example.test.ts: <between-tests error> error: repeated full diagnostic");
  expect(outcome.stdout).toContain("Base diagnostic example.test.ts: <between-tests error> error: repeated full diagnostic");
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
  expect(accepted.stdout).toContain("PRE-EXISTING example.test.ts: steady red (base: FAIL; head: FAIL; non-blocking note)\n");
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
