import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, symlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { text as streamText } from "node:stream/consumers";
import { report, GATE_SLOT, git, patchId, MergeBatch, localGateCommands, commandRunner, type CommandRunner } from "./merge-batch";
import { isolatedEnvironment } from "./local-gate";
import { readWorktreeProvenance } from "../src/lib/pipelines/worktreeProvenance";
import { bindGateCheckRoot, runGateCheckTool } from "../src/lib/runtime/gateCheckTool";
import { resolveGateRun } from "../src/lib/runtime/gateCheckRecord";
import { ownFixtureTree, stopFixtureTree } from "../src/lib/testing/fixtureProcess";
import { betweenTestError, extendPr, fixture, roots, successfulCommand, testResult, installMergeBatchFixtures } from "./merge-batch.fixture";

installMergeBatchFixtures();

test.each([
  { phase: "gate", locked: false },
  { phase: "land", locked: false },
  { phase: "gate", locked: true },
  { phase: "land", locked: true },
])("a native $phase failure remains available by run ID after the batch exits (locked: $locked)", async ({ phase, locked }) => {
  const root = mkdtempSync(join(tmpdir(), "batch-wait-"));
  roots.push(root);
  const binding = bindGateCheckRoot(root)!;
  const state = mkdtempSync(join(tmpdir(), "batch-state-"));
  roots.push(state);
  const lock = join(state, "merge-batch.json.lock");
  const owner = join(lock, "fixture-owner");
  if (locked) {
    mkdirSync(lock);
    writeFileSync(owner, "existing owner");
  }
  const result = await commandRunner(root, [process.execPath, join(import.meta.dir, "merge-batch.ts"), phase], {
    ...isolatedEnvironment(join(root, "isolated"), process.env), TMPDIR: state,
    LLV_GATE_CHECK_LAUNCH_ROOT: binding.root, LLV_GATE_CHECK_ROOT: binding.physicalRoot,
    LLV_GATE_CHECK_ROOT_DIRECTORY_IDENTITY: binding.rootDirectoryIdentity,
  });
  expect(result.code).toBe(1);
  const runId = /runId=([a-f0-9]{64})/.exec(result.output)?.[1];
  expect(runId).toBeDefined();
  const response = await runGateCheckTool({ runId, reason: phase }, binding, new AbortController().signal);
  expect(response.success).toBe(true);
  expect(JSON.parse(response.contentItems[0]!.text)).toMatchObject({
    terminal: true, code: 1, runId, tail: expect.stringContaining(locked ? "EEXIST" : "ENOENT"),
  });
  expect(existsSync(lock)).toBe(locked);
  if (locked) expect(readFileSync(owner, "utf8")).toBe("existing owner");
});

test.each([
  { phase: "gate", result: "refused" },
  { phase: "land", result: "completed" },
  { phase: "land", result: "recorder lost" },
])("one native $phase wait observes $result across separate roots", async ({ phase, result }) => {
  const f = fixture();
  const launch = join(f.root, "launch");
  const state = join(f.root, "batch");
  const bin = join(f.root, "bin");
  for (const directory of [launch, state, bin]) mkdirSync(directory);
  const binding = bindGateCheckRoot(launch)!;
  const stateFile = join(state, "merge-batch.json");
  const lock = stateFile + ".lock";
  const batch = new MergeBatch(f.repo, stateFile, f.good, f.gh);
  const head = f.addPr(12, "unused.txt", "draft fixture");
  f.views.get(12)!.isDraft = true;
  await batch.build(`12@${head}`);
  if (phase === "land") await batch.gate();

  // The production CLI blocks inside an external command with the lock held.
  // A local barrier lets the test attach before supplying the command result.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      entered.resolve();
      await release.promise;
      return new Response(null, { status: 204 });
    },
  });
  const abort = new AbortController();
  const barrier = join(bin, "barrier.ts");
  writeFileSync(barrier, 'const response = await fetch(process.env.BATCH_FIXTURE_BARRIER!); if (!response.ok) process.exit(1);\nexport {};\n');
  const realGit = Bun.which("git")!;
  // A launched Git shim must resolve its delegate outside this fixture bin.
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$BATCH_FIXTURE_PHASE" = gate ] && [ "$PWD" = "$BATCH_FIXTURE_REPO" ] && [ "$*" = "rev-parse --path-format=absolute --git-common-dir" ]; then
  "$BATCH_FIXTURE_BUN" "$BATCH_FIXTURE_SCRIPT" || exit 1
  printf '%s\\n' "different common directory"
  exit 0
fi
PATH="$BATCH_FIXTURE_PATH" exec "$BATCH_FIXTURE_GIT" "$@"
`, { mode: 0o700 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "repo view")
    "$BATCH_FIXTURE_BUN" "$BATCH_FIXTURE_SCRIPT" || exit 1
    printf '%s\\n' "example/fixture" ;;
  "api repos/example/fixture/branches/main/protection")
    printf '%s\\n' '{"required_status_checks":{"strict":true,"contexts":["privacy"]}}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  const env = {
    ...isolatedEnvironment(join(f.root, "isolated"), process.env), TMPDIR: state, PATH: `${bin}:${process.env.PATH}`,
    LLV_GATE_CHECK_LAUNCH_ROOT: binding.root, LLV_GATE_CHECK_ROOT: binding.physicalRoot,
    LLV_GATE_CHECK_ROOT_DIRECTORY_IDENTITY: binding.rootDirectoryIdentity,
    BATCH_FIXTURE_BARRIER: server.url.href, BATCH_FIXTURE_REPO: f.repo, BATCH_FIXTURE_PHASE: phase,
    BATCH_FIXTURE_GIT: realGit, BATCH_FIXTURE_PATH: process.env.PATH, BATCH_FIXTURE_BUN: process.execPath, BATCH_FIXTURE_SCRIPT: barrier,
  };
  const command = [process.execPath, join(import.meta.dir, "merge-batch.ts"), phase];
  const child = ownFixtureTree(spawn(command[0]!, command.slice(1), { cwd: f.repo, env, stdio: ["ignore", "pipe", "pipe"] }));
  const closed = once(child, "close").then(([code]) => code as number | null);
  const stdout = streamText(child.stdout);
  const stderr = streamText(child.stderr);
  try {
    const ready = setTimeout(() => entered.reject(new Error("Batch did not reach its barrier")), 10_000);
    try {
      await Promise.race([entered.promise, closed.then(async code => {
        throw new Error(`Batch exited before reaching its barrier (${code}): ${await stderr}`);
      })]);
    } finally { clearTimeout(ready); }
    expect(existsSync(lock)).toBe(true);
    const [entry] = readdirSync(join(launch, ".gate-runs"));
    const runId = entry!.replace(/\.json$/, "");
    const record = resolveGateRun(launch, runId);
    const args = { runId, reason: phase };
    const readFresh = async (mode: "expire" | "read") => {
      const reader = await commandRunner(import.meta.dir, [process.execPath, "-e", `
        import { bindGateCheckRoot, runGateCheckTool } from "../src/lib/runtime/gateCheckTool";
        const [root, args, mode] = process.argv.slice(-3);
        if (mode === "expire") {
          let now = 0;
          const schedule = setTimeout;
          Object.defineProperty(performance, "now", { value: () => now });
          globalThis.setTimeout = (callback) => {
            now = 24 * 60 * 60_000;
            return schedule(callback, 0);
          };
        }
        const result = await runGateCheckTool(JSON.parse(args!), bindGateCheckRoot(root!), new AbortController().signal);
        console.log(JSON.stringify(result));
      `, launch, JSON.stringify(args), mode], env);
      expect(reader.code).toBe(0);
      return JSON.parse(reader.output);
    };
    let settled = false;
    const waiting = runGateCheckTool(args, binding, abort.signal).then(answer => { settled = true; return answer; });
    const expired = await readFresh("expire");
    expect(expired.success).toBe(true);
    expect(JSON.parse(expired.contentItems[0].text)).toMatchObject({ terminal: false, outcome: "unknown", state: "running", code: 124, runId });
    expect(settled).toBe(false);
    expect(existsSync(lock)).toBe(true);

    if (result === "recorder lost") {
      await stopFixtureTree(child);
      await closed;
      // Abort only as a bounded red control if owner loss fails to wake the wait.
      const deadline = setTimeout(() => abort.abort(), 5_000);
      try {
        const answer = await waiting;
        const late = await readFresh("read");
        expect(answer.success).toBe(false);
        expect(answer.contentItems[0]!.text).toContain(`(runId=${runId}): gate recorder ownership unavailable; no exit result recorded`);
        expect(late).toEqual(answer);
        expect((await stdout).match(/runId=[a-f0-9]{64}/g)).toEqual([`runId=${runId}`]);
        expect(resolveGateRun(launch, runId)).toEqual(record);
        expect(existsSync(`${record.log}.gate/exit`)).toBe(false);
        expect(existsSync(lock)).toBe(true);
      } finally { clearTimeout(deadline); }
      return;
    }

    const contention = await commandRunner(f.repo, command, env);
    expect(contention.code).toBe(1);
    expect(contention.output).toContain("EEXIST");
    expect(settled).toBe(false);
    expect(existsSync(lock)).toBe(true);
    release.resolve();
    const answer = await waiting;
    const code = result === "completed" ? 0 : 1;
    expect(answer.success).toBe(true);
    expect(JSON.parse(answer.contentItems[0]!.text)).toMatchObject({ terminal: true, code, runId });
    expect(existsSync(lock)).toBe(false);
    expect(await closed).toBe(code);
    expect((await stdout).match(/runId=[a-f0-9]{64}/g)).toEqual([`runId=${runId}`]);
    expect(await readFresh("read")).toEqual(answer);
  } finally {
    abort.abort();
    try { await stopFixtureTree(child); }
    finally {
      release.resolve();
      await server.stop(true);
    }
    await closed;
  }
}, 20_000);

test("gh 2.45 builds a batch with the same closing lines despite its unsupported JSON field", async () => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  f.views.get(12)!.closingIssuesReferences = [{ number: 112 }, { number: 113 }];
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view" && args[args.indexOf("--json") + 1]?.split(",").includes("closingIssuesReferences")) {
      throw new Error('Unknown JSON field: "closingIssuesReferences"\nAvailable fields:\n  baseRefName\n  body\n  headRefOid\n  number');
    }
    if (args[0] === "api" && args[1] === "graphql") return "112\n113";
    return f.gh(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, gh);
  const state = await batch.build(`12@${head}`);
  expect(state.rows.map(row => row.status)).toEqual(["clean"]);
  expect(state.rows[0]!.view.closingIssuesReferences).toEqual([{ number: 112 }, { number: 113 }]);
  expect(batch["body"](state).split("\n").filter(line => line.startsWith("Closes "))).toEqual(["Closes #112", "Closes #113"]);
  expect(calls.some(args => args[0] === "api" && args[1] === "graphql" && args.includes("--paginate"))).toBeTrue();
});

test.each(["missing flag", "help failed", "old metadata", "unknown version"])("gh without a required capability refuses before worktree or bootstrap: %s", async fault => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  const before = git(f.repo, ["worktree", "list", "--porcelain"]);
  const files = readdirSync(f.root).sort();
  const commands: string[][] = [], calls: string[][] = [];
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), async (_cwd, args) => {
    commands.push(args); return successfulCommand(args);
  }, async args => {
    calls.push(args);
    if (args[0] === "--version") {
      if (fault === "old metadata") return "gh version 2.17.0 (fixture)";
      if (fault === "unknown version") throw new Error("version unavailable");
      return f.gh(args);
    }
    if (args.join(" ") === "pr merge --help") {
      if (fault === "help failed") throw new Error("unknown command");
      return "Usage: gh pr merge [flags]\n  --rebase";
    }
    return f.gh(args);
  });
  const metadataMissing = ["old metadata", "unknown version"].includes(fault);
  await expect(batch.build(`12@${head}`)).rejects.toThrow(metadataMissing
    ? "Missing gh capability: pr view --json headRefOid (requires gh >= 2.18.0)"
    : "Missing gh capability: pr merge --match-head-commit (requires gh >= 2.13.0)");
  expect(calls).toEqual(metadataMissing ? [["--version"]] : [["--version"], ["pr", "merge", "--help"]]);
  expect(commands).toEqual([]);
  expect(git(f.repo, ["worktree", "list", "--porcelain"])).toBe(before);
  expect(readdirSync(f.root).sort()).toEqual(files);
});

test.each(["2.18.0", "3.0.0"])("gh %s can build at the metadata floor or a later major", async version => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, async args =>
    args[0] === "--version" ? `gh version ${version} (fixture)` : f.gh(args));
  const state = await batch.build(`12@${head}`);
  expect(state.rows.map(row => row.status)).toEqual(["clean"]);
  expect(batch["body"](state)).toContain("Closes #112");
});

test.each([0, 101])("GraphQL closing references preserve all %i issues in the batch body", async count => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  const references = Array.from({ length: count }, (_, index) => ({ number: index + 100 }));
  f.views.get(12)!.closingIssuesReferences = references;
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, async args => {
    if (args[0] === "api" && args[1] === "graphql") {
      expect(args).toContain("--paginate");
      expect(args).toContain("owner={owner}");
      expect(args).toContain("name={repo}");
      expect(args).toContain("number=12");
      expect(args[args.indexOf("--jq") + 1]).toBe(".data.repository.pullRequest.closingIssuesReferences.nodes[].number");
    }
    return f.gh(args);
  });
  const state = await batch.build(`12@${head}`);
  expect(state.rows[0]!.view.closingIssuesReferences).toEqual(references);
  expect(batch["body"](state).split("\n").filter(line => line.startsWith("Closes ")))
    .toEqual(references.map(issue => `Closes #${issue.number}`));
});

test.each(["refused", "invalid"])("an unreadable closing reference response refuses batch construction: %s", async fault => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  const commands: string[][] = [];
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), async (_cwd, args) => {
    commands.push(args); return successfulCommand(args);
  }, async args => {
    if (args[0] === "api" && args[1] === "graphql") {
      if (fault === "refused") throw new Error("GraphQL read refused");
      return "112\ninvalid";
    }
    return f.gh(args);
  });
  await expect(batch.build(`12@${head}`)).rejects.toThrow(fault === "refused" ? "GraphQL read refused" : "Invalid closing issue response");
  expect(commands).toEqual([]);
});

test("real squash accepts context drift, preserves reviewed patch and defers every conflict", async () => {
  const f = fixture();
  const clean = f.addPr(12, "story.txt", "first\nsecond changed\nthird\nfourth\nfifth\n");
  const conflict = f.addPr(13, "story.txt", "first\nsecond alternative\nthird\nfourth\nfifth\n");
  writeFileSync(join(f.repo, "story.txt"), "first\nsecond\nthird\nnew fourth\nfifth\n");
  git(f.repo, ["commit", "-am", "Context drift"]); git(f.repo, ["push", "origin", "main"]);
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, f.gh);
  const state = await batch.build(`12@${clean.slice(0, 9)},13@${conflict}`);
  expect(state.rows.map((row) => row.status)).toEqual(["clean", "deferred"]);
  expect(readWorktreeProvenance(state.work)).toMatchObject({ creator: "merge-batch", id: state.branch });
  expect(patchId(state.work, `${state.tip}^`, state.tip)).toBe(patchId(f.repo, f.base, clean));
  expect(git(state.work, ["show", `${state.tip}:story.txt`])).toStartWith("first\nsecond changed\nthird\nnew fourth");
  expect(git(f.repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
  expect(git(state.work, ["rev-list", "--count", `${state.base}..HEAD`])).toBe("1");
});

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

test("a clean squash with a partial overlap is deferred because the reviewed patch changed", async () => {
  const f = fixture();
  const a = f.addPr(12, "a.txt", "shared");
  f.addPr(13, "a.txt", "shared");
  git(f.repo, ["checkout", "topic-13"]);
  writeFileSync(join(f.repo, "b.txt"), "extra");
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Extra change"]);
  const b = git(f.repo, ["rev-parse", "HEAD"]);
  f.views.get(13)!.headRefOid = b;
  git(f.repo, ["push", "origin", `${b}:refs/pull/13/head`]); git(f.repo, ["checkout", "main"]);
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, f.gh);
  const state = await batch.build(`12@${a},13@${b}`);
  expect(state.rows[1]!.status).toBe("deferred");
  expect(state.rows[1]!.detail).toBe("changed patch");
  expect(existsSync(join(state.work, "b.txt"))).toBe(false);
});

test("preflight drops moved, draft and wrong-base heads without applying them", async () => {
  const f = fixture();
  const sha = f.addPr(12, "a.txt", "feature");
  f.views.get(12)!.isDraft = true;
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, f.gh);
  expect((await batch.build(`12@${sha}`)).rows[0]!.status).toBe("head-moved");
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
    reason: "full browser campaign: opt in with gate --browser" }]);
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
