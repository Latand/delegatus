import { expect, test, afterAll, afterEach, beforeAll } from "bun:test";
import { writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { report, GATE_SLOT, git, MergeBatch, localGateCommands, commandRunner, type CommandRunner } from "./merge-batch";
import { cleanupBatchFixtures, extendPr, fixture, isolateBatchGateLocks, landingFixture, successfulCommand, testResult } from "./merge-batch.fixture";

afterEach(cleanupBatchFixtures);
let restoreGateLocks: () => void;
beforeAll(() => { restoreGateLocks = isolateBatchGateLocks(); });
afterAll(() => restoreGateLocks());

test("merger ESLint uses the batch base and retains selected paths through its runner", async () => {
  const f = fixture(); f.seed("example.ts", "export const value = 1;\n");
  const head = f.addPr(12, "example.ts", "export const value = 2;\n");
  const calls: string[][] = [];
  const runner: CommandRunner = async (_cwd, args) => { calls.push(args); return { code: 0, output: "" }; };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  const state = await batch.build(`12@${head}`);
  const lint = localGateCommands(state.work, state.base).find(gate => gate.id === "eslint")!;
  expect(lint.args).toEqual(["bun", "scripts/eslint-changes.ts", "--base", state.base, "example.ts"]);
  await batch.gate();
  expect(calls.some(args => args.some(arg => arg.endsWith("/eslint-changes.ts")) && args.slice(-3).join(" ") === `--base ${state.base} example.ts`)).toBeTrue();
});

test("merger lints baseline commits without the helper and upgrades persisted old ESLint commands", async () => {
  const f = fixture();
  f.seed("eslint.config.mjs", 'export default [{ rules: { "no-unused-vars": "error" } }];\n');
  f.seed("example.js", "function example() { const old = 1; } example();\n");
  const head = f.addPr(12, "example.js", "\nfunction example() { const old = 1; } example();\n");
  const runner: CommandRunner = async (cwd, args, env) => args[3]?.endsWith("eslint-changes.ts")
    ? commandRunner(cwd, args.slice(2), env) : { code: 0, output: "" };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  const state = await batch.build(`12@${head}`);
  const lint = localGateCommands(state.work, state.base).find(gate => gate.id === "eslint")!;
  expect((await batch.bisectSubject(lint)).code).toBe(0);
  git(state.work, ["checkout", "--detach", state.base]);
  try {
    const result = await batch.bisectSubject(lint);
    expect(result.code).toBe(0);
    expect(result.output).toContain("1 errors already on the base");
    const legacy = await batch.bisectSubject({ id: "eslint", args: ["bunx", "eslint", "--", "example.js"] });
    expect(legacy.code).toBe(0); expect(legacy.output).toContain("1 errors already on the base");
  } finally { git(state.work, ["checkout", state.branch]); }
});

test("a type-check gate that cannot run stops the batch without accusing a PR", async () => {
  const f = fixture();
  const a = f.addPr(12, "a.txt", "good");
  const bad = f.addPr(13, "bad.txt", "bad");
  const c = f.addPr(14, "c.txt", "good");
  const runner: CommandRunner = async (cwd, args, env) => {
    if (args[0] === "git" && args[1] === "bisect") {
      return commandRunner(cwd, ["git", "bisect", "run", "node", "-e", "process.exit(require('node:fs').existsSync('bad.txt') ? 1 : 0)"], env);
    }
    return { code: args[2] === "bunx" && args[3] === "tsc" && existsSync(join(cwd, "bad.txt")) ? 1 : 0, output: "" };
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${a},13@${bad},14@${c}`);
  await expect(batch.gate()).rejects.toThrow("tsc gate cannot run");
  expect(batch.read().rows.map(row => row.status)).toEqual(["clean", "clean", "clean"]);
  expect(batch.read().gated).toBeNull();
});

test("batch gate samples fresh native main for every candidate after removal", async () => {
  const f = fixture();
  f.seed("existing.test.ts", "baseline test version");
  const a = f.addPr(12, "good.txt", "good");
  const b = f.addPr(13, "bad.txt", "bad");
  const c = f.addPr(14, "existing.test.ts", "candidate test version");
  let baselineRuns = 0, validatedRemainder = false;
  const runner: CommandRunner = async (cwd, args) => {
    if (args[2] === "bun" && args[3] === "test") {
      const file = args[4]!.replace(/^\.\//, "");
      const native = readFileSync(join(cwd, file), "utf8") === "baseline test version";
      if (native) baselineRuns++;
      else if (!existsSync(join(cwd, "bad.txt"))) validatedRemainder = true;
      return testResult(file, native || !existsSync(join(cwd, "bad.txt")) ? ["pre-existing"] : ["pre-existing", "regression"],
        native || !existsSync(join(cwd, "bad.txt")) ? ["regression"] : []);
    }
    return successfulCommand(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${a},13@${b},14@${c}`);
  const state = await batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit", "clean"]);
  expect(baselineRuns).toBeGreaterThan(1);
  expect(validatedRemainder).toBeTrue();
  expect(state.gated?.tip).toBe(state.tip);
  expect(state.rows[1]!.head).toBe(b);
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(b);
});

test("a hard gate refusal invalidates a previously gated tip", async () => {
  const f = fixture();
  const head = f.addPr(12, "healthy.txt", "healthy");
  let broken = false;
  const runner: CommandRunner = async (_cwd, args) => broken && args[2] === "bunx"
    ? { code: 1, output: "type checker unavailable" } : successfulCommand(args);
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${head}`);
  expect((await batch.gate()).gated).not.toBeNull();
  broken = true;
  await expect(batch.gate()).rejects.toThrow("tsc gate cannot run");
  expect(batch.read().gated).toBeNull();
});

test("full batch gate withholds a regression discovered while the initial failure clears", async () => {
  const f = fixture();
  f.seed("bad.test.ts", "fixture");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const culprit = f.addPr(13, "bad.ts", "regression");
  let candidateRuns = 0;
  const runner: CommandRunner = async (cwd, args) => {
    if (args[2] === "bun" && args[3] === "test") {
      const file = args[4]!.replace(/^\.\//, "");
      if (!existsSync(join(cwd, "bad.ts"))) return testResult(file, [], ["A", "B"]);
      if (++candidateRuns === 1) return testResult(file, ["A"], []);
      return testResult(file, ["B"], ["A"]);
    }
    return successfulCommand(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${healthy},13@${culprit}`);
  const state = await batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
  expect(state.rows[1]!.head).toBe(culprit);
  expect(state.attributionLog[0]!.test.name).toBe("B");
  expect(report(state)).toContain("B; candidate failed; confirmations fail, fail, fail");
  expect(report(state)).toContain("without #13: pass");
  expect(state.gated?.tip).toBe(state.tip);
  expect(existsSync(join(state.work, "bad.ts"))).toBeFalse();
}, 30_000);

function betweenTestError(result: ReturnType<typeof testResult>, message: string) {
  return { ...result, code: 1, output: `# Unhandled error between tests\n-------------------------------\nerror: ${message}\n-------------------------------\n 1 error\n` };
}

test("(a)(c)(d) main's own red never stops the batch; a newly broken case drops only its PR; gates run one at a time through gate-slot.sh", async () => {
  const f = fixture();
  f.seed("board.ts", "export const board = 1;\n");
  f.seed("board.test.ts", "native board detector");
  f.seed("panel.ts", "export const panel = 1;\n");
  f.seed("panel.test.ts", "native panel detector");
  const healthy = f.addPr(12, "board.ts", "export const board = 2;\n");
  extendPr(f, 12, { "panel.ts": "export const panel = 2;\n", "healthy.txt": "healthy" });
  const reviewed = f.views.get(12)!.headRefOid as string;
  const culprit = f.addPr(13, "bad.txt", "bad");
  const other = f.addPr(14, "other.txt", "other");
  let inFlight = 0, maxInFlight = 0;
  const wrappers = new Set<string>(), testEnvs: NodeJS.ProcessEnv[] = [];
  const runner: CommandRunner = async (cwd, args, env) => {
    expect(args[0]).toBe("/bin/bash"); wrappers.add(args[1]!);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await Bun.sleep(1);
    inFlight--;
    if (args[2] !== "bun" || args[3] !== "test") return successfulCommand(args);
    testEnvs.push(env!);
    const file = args[4]!.replace(/^\.\//, "");
    const main = !existsSync(join(cwd, "healthy.txt")) && !existsSync(join(cwd, "bad.txt")) && !existsSync(join(cwd, "other.txt"));
    if (file === "panel.test.ts") {
      // Native main's browser-backed run dies before writing its report.
      return main ? { code: 1, output: "error: Target page, context or browser has been closed\n" }
        : testResult(file, ["never completed on main"], ["panel"]);
    }
    const broken = existsSync(join(cwd, "bad.txt"));
    return betweenTestError(testResult(file, ["main red", ...(broken ? ["regression"] : [])], broken ? [] : ["regression"]),
      "waitFor: Target page, context or browser has been closed");
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${reviewed},13@${culprit},14@${other}`);
  const state = await batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit", "clean"]);
  expect(state.gated?.candidate.prs.map(pr => pr.number)).toEqual([12, 14]);
  expect(state.attributionLog.map(entry => [entry.test.name, entry.prs, entry.reason])).toEqual([["regression", [13], "test regression"]]);
  const text = report(state);
  expect(text).toContain("Pre-existing failures (permitted):\n- board.test.ts > suite > main red\n- board.test.ts >  > <between-tests error>");
  expect(text).toContain("Not compared (native main could not complete the file):\n- panel.test.ts > suite > never completed on main");
  expect([...wrappers]).toEqual([GATE_SLOT]);
  expect(maxInFlight).toBe(1);
  for (const env of testEnvs) {
    expect(env.LLV_VIEWER_CONTROL_URL).toBe("http://127.0.0.1:9");
    expect(env.HOME).toBe(join(dirname(env.LLV_STATE_DIR!), "home"));
    expect(env.LLV_STATE_OWNER).toBeUndefined();
  }
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(culprit);
}, 60_000);

test("(d) concurrent gate requests still run one at a time inside the slot wrapper", async () => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "a");
  let inFlight = 0, maxInFlight = 0;
  const order: string[] = [];
  const runner: CommandRunner = async (_cwd, args) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`start ${args.at(-1)}`);
    await Bun.sleep(5);
    order.push(`end ${args.at(-1)}`);
    inFlight--;
    return { code: args.at(-1) === "first" ? 1 : 0, output: "" };
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${head}`);
  const results = await Promise.all(["first", "second", "third"].map(name => batch.bisectSubject({ id: "tsc", args: ["bunx", "tsc", name] })));
  expect(results.map(result => result.code)).toEqual([1, 0, 0]);
  expect(maxInFlight).toBe(1);
  expect(order).toEqual(["start first", "end first", "start second", "end second", "start third", "end third"]);
});

test("(e) full browser campaigns are opt-in and are named as skipped by default", async () => {
  const f = fixture();
  const file = "kanban.browser.test.tsx";
  const main = "browser driver";
  const reviewed = "browser driver with a new describe block";
  f.seed(file, main);
  const head = f.addPr(12, file, reviewed);
  const sampled: string[] = [];
  const runner: CommandRunner = async (cwd, args) => {
    if (args[2] === "bun" && args[3] === "test") {
      expect(args[4]).toBe(`./${file}`);
      sampled.push(readFileSync(join(cwd, file), "utf8"));
    }
    return successfulCommand(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${head}`);
  const lean = await batch.gate({ browser: false });
  expect(sampled).toEqual([]);
  expect(lean.gated!.notApplicable).toEqual([{ source: "native candidate", file: "kanban.browser.test.tsx",
    reason: "full browser campaign: opt in with gate --local --browser" }]);
  expect(localGateCommands(lean.work, lean.base).some(gate => gate.id === "tests")).toBeFalse();
  expect(localGateCommands(lean.work, lean.base, true).find(gate => gate.id === "tests")!.args).toEqual(["bun", "test", "./kanban.browser.test.tsx"]);
  const opted = await batch.gate({ browser: true });
  expect(opted.gated!.notApplicable).toEqual([]);
  expect(sampled).toEqual([main, reviewed]);
});

test("a distinct browser blob from an omitted member keeps the membership reason", async () => {
  const f = fixture();
  const file = "kanban.browser.test.tsx";
  f.seed(file, "// base browser driver");
  const active = f.addPr(12, file, "// candidate browser driver");
  const omitted = f.addPr(13, file, "// omitted browser driver");
  f.views.get(13)!.isDraft = true;
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, f.gh);
  await batch.build(`12@${active},13@${omitted}`);
  const state = await batch.gate();
  expect(state.gated!.notApplicable).toContainEqual({ source: `#13@${omitted}`, file,
    reason: "#13 is not in this candidate; its reviewed detector is skipped" });
});

test("the batch frozen install repairs the compiler before types, lint and privacy", async () => {
  const f = fixture();
  f.seed(".gitignore", "node_modules/\n");
  const head = f.addPr(12, "example.ts", "export const value = 1;\n");
  const observed: string[] = [];
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), async (cwd, args) => {
    const command = args[3];
    if (command === "install" && cwd === built.work) {
      expect(args.slice(2)).toEqual(["bun", "install", "--frozen-lockfile"]);
      expect(existsSync(compiler)).toBeFalse();
      rmSync(compiler);
      mkdirSync(join(compiler, "bin"), { recursive: true });
      writeFileSync(join(compiler, "bin", "tsc"), "fixture compiler");
      observed.push("install");
    } else if (command === "tsc") {
      expect(readFileSync(join(compiler, "bin", "tsc"), "utf8")).toBe("fixture compiler");
      observed.push("tsc");
    } else if (command?.endsWith("/eslint-changes.ts")) observed.push("lint");
    else if (command === "scripts/privacy-publication-gate.ts") observed.push("privacy");
    return successfulCommand(args);
  }, f.gh);
  const built = await batch.build(`12@${head}`);
  const compiler = join(built.work, "node_modules", "typescript");
  mkdirSync(dirname(compiler));
  symlinkSync("missing-compiler", compiler);
  const state = await batch.gate();
  expect(state.gated?.tip).toBe(built.tip);
  expect(observed).toEqual(["install", "tsc", "lint", "privacy"]);
});

const shellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function compilerShim(root: string, body: string): string {
  const bin = join(root, "compiler-bin"); mkdirSync(bin);
  const file = join(bin, "bunx");
  writeFileSync(file, `#!/bin/sh\n${body}`); chmodSync(file, 0o755);
  return `${bin}:${process.env.PATH}`;
}

test("explicit local validation still bisects real TypeScript failures", async () => {
  const compiler = join(import.meta.dir, "../node_modules/typescript/bin/tsc");
  let bisects = 0;
  const runner: CommandRunner = async (cwd, args, env) => {
    if (args[2] === "bunx" && args[3] === "tsc") {
      return commandRunner(cwd, args.slice(2), { ...(env ?? process.env), PATH: compilerPath });
    }
    if (args[0] === "git" && args[1] === "bisect") {
      bisects++;
      expect(args.slice(2, 4)).toEqual(["run", process.execPath]);
      return commandRunner(cwd, args, { ...(env ?? process.env), PATH: compilerPath });
    }
    return successfulCommand(args);
  };
  const f = landingFixture("green", runner);
  const compilerPath = compilerShim(f.root, `exec ${shellArgument(process.execPath)} ${shellArgument(compiler)} --noEmit\n`);
  f.seed("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, types: [], skipLibCheck: true }, include: ["*.ts"] }));
  f.seed("contract.ts", "export const requireCount = (value: string) => value;\n");
  const healthy = f.addPr(12, "healthy.ts", "export const healthy = true;\n");
  const bad = f.addPr(13, "feature.ts", 'import { requireCount } from "./contract"; requireCount(1);\n');
  await f.batch.build(`12@${healthy},13@${bad}`);
  const gated = await f.batch.gate();
  expect(bisects).toBe(1);
  expect(gated.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
  expect(gated.rows[1]!.detail).toBe("tsc: first failing batch commit");
  expect((await f.batch.land()).rows.map(row => row.status)).toEqual(["merged", "culprit"]);
}, 30_000);

test.each([
  { code: 1, output: "checker startup unavailable" },
  { code: 2, output: "" },
  { code: 3, output: "error TS2322: incomplete checker execution" },
  { code: 127, output: "checker unavailable" },
])("production TypeScript bisect refuses an unavailable intermediate checker ($code: $output)", async ({ code, output }) => {
  const f = fixture();
  const healthy = f.addPr(12, "healthy.txt", "healthy"), bad = f.addPr(13, "bad.txt", "type error");
  const compilerPath = compilerShim(f.root, 'if test -f bad.txt; then echo "error TS2322: fixture type error"; exit 2; fi\n'
    + `if test -f healthy.txt; then printf '%s\\n' ${shellArgument(output)}; exit ${code}; fi\nexit 0\n`);
  let bisects = 0;
  const runner: CommandRunner = async (cwd, args, env) => {
    if (args[2] === "bunx") return commandRunner(cwd, args.slice(2), { ...(env ?? process.env), PATH: compilerPath });
    if (args[0] === "git" && args[1] === "bisect") {
      bisects++;
      expect(args.slice(-2, -1)).toEqual(["_bisect"]);
      return commandRunner(cwd, args, { ...(env ?? process.env), PATH: compilerPath });
    }
    return successfulCommand(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${healthy},13@${bad}`);
  await expect(batch.gate()).rejects.toThrow("Bisect could not attribute tsc");
  expect(bisects).toBe(1);
  expect(batch.read().rows.map(row => row.status)).toEqual(["clean", "clean"]);
  expect(batch.read().gated).toBeNull();
  expect(git(batch.read().work, ["symbolic-ref", "--short", "HEAD"])).toBe(batch.read().branch);
}, 30_000);

test("PR removal keeps the reviewed regression test when its author is healthy", async () => {
  const f = fixture();
  f.seed("adder.js", "exports.add = (a, b) => a + b;\n");
  const source = f.addPr(12, "adder.js", "exports.add = (a, b) => a - b;\n");
  const detector = f.addPr(13, "adder.test.ts", [
    "const { add } = require('./adder');",
    "const { test, expect } = require('bun:test');",
    "test('adds', () => expect(add(5, 3)).toBe(8));",
    "",
  ].join("\n"));
  const runner: CommandRunner = async (cwd, args, env) => {
    if (args[0] === "git" && args[1] === "bisect") {
      return commandRunner(cwd, args, env);
    }
    if (args[2] === "bun" && args[3] === "test") {
      return commandRunner(cwd, args.slice(2), env);
    }
    return { code: 0, output: "" };
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  const built = await batch.build(`12@${source},13@${detector}`);
  const state = await batch.gate();
  expect(state.rows.map((row) => row.status)).toEqual(["culprit", "clean"]);
  expect(state.gated?.tip).toBe(state.tip);
  expect(existsSync(join(state.work, "adder.test.ts"))).toBe(true);
  expect(git(state.work, ["show", `${state.tip}:adder.js`])).toContain("a + b");
  expect(built.gated).toBeNull();
});
