import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pruneDockerCache, DOCKER_CACHE_PRUNE_COMMANDS } from "./dockerCacheRetention";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-retention-")); roots.push(root); return path.join(root, "daily.json"); }
test("one day calls only cache and unused image pruning once", async () => {
  const file = fixture(), calls: string[][] = []; let now = Date.UTC(2035, 0, 1);
  const options = { file, now: () => now, run: async (args: readonly string[]) => { calls.push([...args]); } };
  expect(await pruneDockerCache(options)).toMatchObject({ commands: 2, errors: 0 });
  for (let i = 0; i < 10; i++) { now += 1000; expect(await pruneDockerCache(options)).toMatchObject({ commands: 0 }); }
  expect(calls).toEqual(DOCKER_CACHE_PRUNE_COMMANDS.map(args => [...args]));
  now += 86400000; await pruneDockerCache(options); expect(calls).toHaveLength(4);
});
test("a refused or missing daemon records a fixed cause and waits until tomorrow", async () => {
  const file = fixture(), now = Date.UTC(2035, 0, 1); let calls = 0;
  const options = { file, now: () => now, run: async () => { calls++; throw new Error("fixture daemon refusal"); } };
  expect(await pruneDockerCache(options)).toMatchObject({ state: "docker-prune-unavailable", errors: 2 });
  expect(await pruneDockerCache(options)).toMatchObject({ state: "waiting", commands: 0 }); expect(calls).toBe(2);
});
test("dry-run makes no Docker call and writes no daily checkpoint", async () => {
  const file = fixture();
  expect(await pruneDockerCache({ file, mode: "dry-run", run: async () => { throw new Error("unexpected Docker call"); } })).toMatchObject({ state: "dry-run", commands: 0 });
  expect(fs.existsSync(file)).toBeFalse();
});
test("a corrupt checkpoint refuses repeated destructive work", async () => {
  const file = fixture(); fs.writeFileSync(file, "{}");
  await expect(pruneDockerCache({ file, run: async () => { throw new Error("unexpected Docker call"); } })).rejects.toThrow("invalid Docker retention checkpoint");
});
test("a real process restart preserves the daily attempt", async () => {
  const file = fixture(), script = path.join(path.dirname(file), "run.ts"), calls = path.join(path.dirname(file), "calls");
  fs.writeFileSync(script, `import { pruneDockerCache } from ${JSON.stringify(path.join(import.meta.dir, "dockerCacheRetention.ts"))};
    import fs from 'node:fs'; await pruneDockerCache({file:process.argv[2],now:()=>2051222400000,
      run:async args=>{ fs.appendFileSync(process.argv[3],JSON.stringify(args)+'\\n'); }});`);
  for (let i = 0; i < 2; i++) {
    const child = Bun.spawn([process.execPath, script, file, calls], { stdout: "pipe", stderr: "pipe" });
    const error = await new Response(child.stderr).text(); expect(await child.exited, error).toBe(0);
  }
  expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
});

test.each(["test", "fixture-production", "production"])("a default Docker call under %s fails before a command or checkpoint", async mode => {
  const file = fixture(), root = path.dirname(file), calls = path.join(root, "calls");
  fs.writeFileSync(path.join(root, "docker"), `#!/usr/bin/python3 -I\nimport sys,json\nwith open(${JSON.stringify(calls)},'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n`, { mode: 0o700 });
  const previous = { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV,
    LLV_FIXTURE_PARENT_IDENTITY: process.env.LLV_FIXTURE_PARENT_IDENTITY, LLV_TEST_STARTUP_HOME: process.env.LLV_TEST_STARTUP_HOME };
  process.env.PATH = root; process.env.NODE_ENV = mode === "test" ? "test" : "production";
  if (mode === "fixture-production") process.env.LLV_FIXTURE_PARENT_IDENTITY = "fixture-context";
  if (mode === "production") { delete process.env.LLV_FIXTURE_PARENT_IDENTITY; delete process.env.LLV_TEST_STARTUP_HOME; }
  try {
    await expect(pruneDockerCache({ file, now: () => Date.UTC(2035, 0, 1) })).rejects.toThrow("refused the real Docker runner");
    expect(fs.existsSync(calls)).toBeFalse(); expect(fs.existsSync(file)).toBeFalse();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("an injected executable receives both filtered commands", async () => {
  const file = fixture(), root = path.dirname(file), calls = path.join(root, "calls");
  const executable = path.join(root, "docker");
  fs.writeFileSync(executable, `#!/usr/bin/python3 -I\nimport sys,json\nwith open(${JSON.stringify(calls)},'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n`, { mode: 0o700 });
  expect(await pruneDockerCache({ file, now: () => Date.UTC(2035, 0, 1), run: async (args, timeout) => {
    await promisify(execFile)(executable, [...args], { timeout });
  } })).toMatchObject({ commands: 2, errors: 0 });
  expect(fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual(DOCKER_CACHE_PRUNE_COMMANDS.map(args => [...args]));
});

test("a production-mode child inheriting test ownership refuses the real runner", async () => {
  const file = fixture(), script = path.join(path.dirname(file), "guard.ts");
  fs.writeFileSync(script, `import { pruneDockerCache } from ${JSON.stringify(path.join(import.meta.dir, "dockerCacheRetention.ts"))};
    await pruneDockerCache({file:process.argv[2]});`);
  const child = Bun.spawn([process.execPath, script, file], { env: { ...process.env, NODE_ENV: "production", PATH: path.dirname(file) }, stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(error).toContain("refused the real Docker runner");
  expect(fs.existsSync(file)).toBeFalse();
});
