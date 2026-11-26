import { expect, test, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { text as streamText } from "node:stream/consumers";
import { MergeBatch, commandRunner } from "./merge-batch";
import { isolatedEnvironment } from "./local-gate";
import { bindGateCheckRoot, runGateCheckTool } from "../src/lib/runtime/gateCheckTool";
import { resolveGateRun } from "../src/lib/runtime/gateCheckRecord";
import { ownFixtureTree, stopFixtureTree } from "../src/lib/testing/fixtureProcess";
import { cleanupBatchFixtures, fixture, fixtureRoot } from "./merge-batch.fixture";

afterEach(cleanupBatchFixtures);

test.each([
  { phase: "gate", locked: false },
  { phase: "land", locked: false },
  { phase: "gate", locked: true },
  { phase: "land", locked: true },
])("a native $phase failure remains available by run ID after the batch exits (locked: $locked)", async ({ phase, locked }) => {
  const root = fixtureRoot("batch-wait-");
  const binding = bindGateCheckRoot(root)!;
  const state = fixtureRoot("batch-state-");
  const lock = join(state, "merge-batch.json.lock");
  const owner = join(lock, "fixture-owner");
  if (locked) {
    mkdirSync(lock);
    writeFileSync(owner, "existing owner");
  }
  const result = await commandRunner(root, [process.execPath, join(import.meta.dir, "merge-batch.ts"), phase, ...(phase === "gate" ? ["--local"] : [])], {
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
  const command = [process.execPath, join(import.meta.dir, "merge-batch.ts"), phase, ...(phase === "gate" ? ["--local"] : [])];
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
