import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { endingOf, NoVerdict, pushDeadline, runAdmittedChecks, runSteps, supervisorTimeoutMs } from "./local-gate";
import { cpuWaitBudget } from "../src/lib/runtime/cpuAdmissionBudget";
import { processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import { publicationHookDeadline, publicationPushBudgetMs } from "../src/lib/pipelines/gateBudget";
import { publicationDeadlineOnly } from "../src/lib/pipelines/publication";
import { createGateTestFixtures } from "./gateTest.fixture";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
const { stepRunner, soon } = createGateTestFixtures(roots, owned);
afterEach(async () => {
  for (const identity of owned.splice(0)) await stopFixtureIdentity(identity);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("supervision covers the remaining execution budget and completed CPU wait with cleanup margin", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    const ledger = JSON.parse(budget.env.LLV_CPU_WAIT_ROOTS!)[0];
    writeFileSync(path.join(ledger, "queue.json"), JSON.stringify({ start: 100, end: 600 }));
    // A stale inherited cap must not govern the next child.
    expect(supervisorTimeoutMs(1000, { ...budget.env, LLV_OWNED_RUN_TIMEOUT_MS: "1" }, 800)).toBe(30_700);
    expect(supervisorTimeoutMs(1000, { NODE_ENV: "test" }, 800)).toBe(30_200);
    expect(supervisorTimeoutMs(1000, { NODE_ENV: "test" }, 1200)).toBe(30_001);
    expect(publicationHookDeadline(publicationPushBudgetMs(["Dockerfile"]), 0)).toBeGreaterThan(894_000);
    expect(publicationHookDeadline(publicationPushBudgetMs(["scripts/example.ts"]), 0)).toBeGreaterThan(562_000);
  } finally { budget.close(); }
});

test("a phase child receives its current allowance instead of a stale inherited supervisor cap", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-supervisor-cap-")); roots.push(dir);
  const record = path.join(dir, "allowance");
  const now = Date.now;
  Date.now = () => 1000;
  try {
    await runSteps("pre-push", [{ name: "types", command: [] }], {
      root: dir, deadline: { startedAt: 1000, at: 2000 }, logDir: dir, say: () => {},
      prepare: () => ({ env: { ...process.env, LLV_OWNED_RUN_TIMEOUT_MS: "1" }, command: [process.execPath, "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(record)}, process.env.LLV_OWNED_RUN_TIMEOUT_MS);`] }),
    });
    expect(readFileSync(record, "utf8")).toBe("31000");
  } finally { Date.now = now; }
});

test.each([0, 1, 124])("a fresh admitted runner preserves success, refusal and deadline outcomes (%s)", async code => {
  const deadline = soon(10_000);
  const outcome = await runAdmittedChecks(["bash", "-c", `exit ${code}`], root, process.env, deadline).then(() => null, (error: unknown) => error);
  if (code === 0) expect(outcome).toBeNull();
  else if (code === 124) {
    expect(outcome).toBeInstanceOf(NoVerdict);
    expect(endingOf("pre-push", outcome).code).toBe(75);
    expect(endingOf("pre-push", outcome).line).toContain('"push checks"');
  } else expect(outcome).not.toBeInstanceOf(NoVerdict);
});

test.each([false, true])("a phase runner's deadline status remains retryable (grouped: %s)", async grouped => {
  const runner = stepRunner(soon(10_000), () => ({ types: "exit 124" }));
  const error = await runner.run([{ name: "types", command: [], ...(grouped ? { group: "push checks" } : {}) }]);
  expect(error).toBeInstanceOf(NoVerdict);
  expect(endingOf("pre-push", error).code).toBe(75);
  expect(endingOf("pre-push", error).line).toContain('"types"');
});

for (const grouped of [false, true]) test.each(["pure", "assertion", "cleanup"] as const)(`owned timeout retains earlier refusal evidence (grouped: ${grouped}): %s`, async kind => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-deadline-evidence-")); roots.push(dir);
  const subject = path.join(dir, "pending.test.ts");
  writeFileSync(subject, `import { test, expect } from "bun:test";
    test("first result", () => { ${kind === "assertion" ? "expect(1).toBe(2);" : kind === "cleanup" ? 'console.error("owned runner: budget cleanup failed: fixture refusal");' : "expect(1).toBe(1);"} });
    test("pending result", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); }, 60000);`);
  const lines: string[] = [];
  const error = await runSteps("pre-push", [{ name: "types", command: [], ...(grouped ? { group: "checks" } : {}) }], {
    root: dir, deadline: soon(20_000), logDir: dir, say: line => lines.push(line),
    prepare: () => ({ env: process.env, command: [process.execPath, path.join(root, "scripts/owned-runner.ts"), "--budget", "3000", process.execPath, "test", subject] }),
  }).then(() => null, (error: unknown) => error);
  const ending = endingOf("pre-push", error);
  expect(ending.code, lines.join("\n")).toBe(kind === "pure" ? 75 : 1);
  expect(publicationDeadlineOnly([...lines, ending.line].join("\n"))).toBe(kind === "pure");
}, 30_000);

test.skipIf(process.platform !== "linux" || !process.env.LLV_OWNED_TEST_RUN_CGROUP).each(["pure", "assertion", "leak"] as const)("native service cleanup preserves the hook verdict: %s", async kind => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-native-deadline-")); roots.push(dir);
  const record = path.join(dir, "child.json");
  const lines: string[] = [];
  const subject = path.join(dir, kind === "leak" ? "leak.ts" : "pending.test.ts");
  writeFileSync(subject, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { captureProcessIdentity } from ${JSON.stringify(path.join(root, "src/lib/processIdentity.ts"))};
    ${kind === "leak" ? `
      const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      child.unref();
      writeFileSync(${JSON.stringify(record)}, JSON.stringify(captureProcessIdentity(child.pid)));
      process.exit(0);
    ` : `
      import { test, expect } from "bun:test";
      import { spawn } from "node:child_process";
      test("decisive native assertion", () => {
        writeFileSync(${JSON.stringify(record)}, JSON.stringify(captureProcessIdentity(process.pid)));
        expect(1).toBe(${kind === "assertion" ? 2 : 1});
      });
      test("pending native result", async () => {
        ${kind === "pure" ? `
          const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
          child.unref();
          writeFileSync(${JSON.stringify(record + ".child")}, JSON.stringify(captureProcessIdentity(child.pid)));
        ` : ""}
        await new Promise(() => {});
      }, 60000);
    `}`);
  const error = await runSteps("pre-push", [{ name: "types", command: [] }], {
    root: dir, deadline: soon(20_000), logDir: dir, say: line => lines.push(line),
    prepare: () => ({ env: process.env, command: ["bash", "-c", 'export LLV_OWNED_RUN_TIMEOUT_MS=2500; exec "$@"', "native-deadline",
      process.execPath, path.join(root, "scripts/owned-runner.ts"), process.execPath, ...(kind === "leak" ? [subject] : ["test", subject])] }),
  }).then(() => null, (caught: unknown) => caught);
  const output = lines.join("\n");
  expect(existsSync(record), output).toBeTrue();
  const identity: ProcessIdentity = JSON.parse(readFileSync(record, "utf8")); owned.push(identity);
  // The real systemd --wait client must finish containment before the hook
  // accepts a retry, including a detached child left by a successful command.
  expect(processIdentityStatus(identity), output).toBe("dead");
  if (kind === "pure") {
    expect(existsSync(record + ".child"), output).toBeTrue();
    const child: ProcessIdentity = JSON.parse(readFileSync(record + ".child", "utf8")); owned.push(child);
    expect(processIdentityStatus(child), output).toBe("dead");
    expect(output).not.toContain("surviving owned processes");
  }
  const ending = endingOf("pre-push", error);
  expect(ending.code, output).toBe(kind === "pure" ? 75 : 1);
  if (kind === "pure") expect(error).toBeInstanceOf(NoVerdict);
  expect(output).toContain(kind === "leak" ? "surviving owned processes:" : "owned runner: deadline expired");
  if (kind === "assertion") expect(output).toContain("(fail) decisive native assertion");
  expect(publicationDeadlineOnly([...lines, ending.line].join("\n"))).toBe(kind === "pure");
}, 30_000);

test("a peer timeout cannot erase a named assertion from a cancelled lane", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-peer-deadline-")); roots.push(dir);
  const ready = path.join(dir, "ready"), subject = path.join(dir, "assertion.test.ts");
  writeFileSync(subject, `import { test, expect } from "bun:test"; import { writeFileSync } from "node:fs";
    test("decisive assertion", () => expect(1).toBe(2));
    test("pending", async () => { writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000); await new Promise(() => {}); }, 60000);`);
  const lines: string[] = [];
  const result = await runSteps("pre-push", ["timeout", "assertion"].map(name => ({ name, command: [], group: "checks" })), {
    root: dir, deadline: soon(10_000), logDir: dir, say: line => lines.push(line), prepare: step => ({ env: process.env,
      command: step.name === "assertion" ? [process.execPath, "test", subject] : [process.execPath, "-e", `const fs = require("node:fs"); while (!fs.existsSync(${JSON.stringify(ready)})) await Bun.sleep(5); process.exit(124);`],
    }),
  }).then(() => null, (error: unknown) => error);
  const ending = endingOf("pre-push", result);
  expect(ending.code, lines.join("\n")).toBe(1);
  expect(lines.join("\n")).toContain("(fail) decisive assertion");
  expect(publicationDeadlineOnly([...lines, ending.line].join("\n"))).toBe(false);
});

test("a caller's deadline is authoritative and must be a Unix time in milliseconds", () => {
  expect(pushDeadline({}, 1_000)).toBeNull();
  expect(pushDeadline({ LLV_GATE_PUSH_DEADLINE: "" }, 1_000)).toBeNull();
  expect(pushDeadline({ LLV_GATE_PUSH_DEADLINE: "5000" }, 1_000)).toEqual({ at: 5_000, startedAt: 1_000 });
  for (const bad of ["soon", "-1", "1.5"]) expect(() => pushDeadline({ LLV_GATE_PUSH_DEADLINE: bad }, 1_000)).toThrow("LLV_GATE_PUSH_DEADLINE");
});

test.each(["recovers", "repeats", "assertion", "runner", "cleanup", "incomplete", "cancel-retry"] as const)("a comparator-authorized phase retry is bounded across real hook processes: %s", mode => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-flaky-phase-")); roots.push(dir);
  const counter = path.join(dir, "attempts"), subject = path.join(dir, "check.ts"), harness = path.join(dir, "hook.ts");
  writeFileSync(subject, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const counter = ${JSON.stringify(counter)};
    const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
    writeFileSync(counter, String(n));
    if (${JSON.stringify(mode)} === "recovers" && n > 1) process.exit(0);
    if (${JSON.stringify(mode)} === "cancel-retry" && n > 1) { setInterval(() => {}, 1000); await new Promise(() => {}); }
    console.log("FLAKY example.test.ts: <between-tests error> first diagnostic");
    console.log(${JSON.stringify(mode)} === "assertion" ? "NEW example.test.ts: reproducible assertion" : ${JSON.stringify(mode)} === "runner" ? "NEW example.test.ts: <runner error> incomplete report" : "NEW example.test.ts: <between-tests error> second diagnostic");
    if (${JSON.stringify(mode)} === "cleanup") console.log("owned runner: budget cleanup failed: fixture refusal");
    if (${JSON.stringify(mode)} !== "incomplete") console.log("touched-tests: 1 new failures, 0 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
    process.exitCode = 1;`);
  for (const grouped of [false, true]) {
    writeFileSync(harness, `import { existsSync, readFileSync } from "node:fs";
      import { runSteps } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
      const cancel = new AbortController(); let done = false;
      const result = runSteps("pre-push", [{ name: "touched tests", command: [], ${grouped ? 'group: "tests", lane: "tests"' : ""} }], {
        root: ${JSON.stringify(dir)}, deadline: null, logDir: ${JSON.stringify(dir)}, cancel: cancel.signal,
        prepare: () => ({ command: [process.execPath, ${JSON.stringify(subject)}], env: process.env }),
      }).then(() => true, () => false).finally(() => { done = true; });
      if (${JSON.stringify(mode)} === "cancel-retry") {
        while (!done && (!existsSync(${JSON.stringify(counter)}) || Number(readFileSync(${JSON.stringify(counter)}, "utf8")) < 2)) await Bun.sleep(10);
        if (!done) cancel.abort();
      }
      if (!await result) process.exitCode = 1;`);
    for (let restart = 0; restart < 2; restart++) {
      writeFileSync(counter, "0");
      const result = spawnSync(process.execPath, [harness], { cwd: dir, env: process.env, encoding: "utf8", timeout: 25_000, killSignal: "SIGKILL" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(mode === "recovers" ? 0 : 1);
      expect(readFileSync(counter, "utf8")).toBe(["recovers", "repeats", "cancel-retry"].includes(mode) ? "2" : "1");
      if (mode === "cancel-retry") expect(result.stderr).toContain("retaining the comparator refusal");
    }
  }
}, 60_000);
