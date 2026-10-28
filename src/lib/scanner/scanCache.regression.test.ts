import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-scan-regression-"));
const keys = ["LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CLAUDE_CODE_TMPDIR", "TMPDIR"];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.TMPDIR = path.join(sandbox, "tmp");
process.env.CLAUDE_CODE_TMPDIR = process.env.TMPDIR;
const sessions = path.join(process.env.LLV_CODEX_HOME, "sessions");
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { cachedFileScan, currentFileScan, resetFilesRouteCacheForTests, setFileScanRunnerForTests } = await import("./scanCache");
const { runFileCatalogScan } = await import("./scanCoordinator");
const { readResourceFileSnapshot } = await import("@/lib/resources");
const { resourceWorkerRequestProblem } = await import("@/lib/resourceWorkerRequest");
const { closeAgentRegistryForTests } = await import("@/lib/agent/registry");

function transcript(name: string): string {
  const filename = path.join(sessions, `${name}.jsonl`);
  fs.writeFileSync(filename, [
    { type: "session_meta", payload: { cwd: "fixture-project" } },
    { type: "event_msg", payload: { type: "task_started" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  return filename;
}

afterEach(() => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(null);
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "files-scan-snapshot.json"), { force: true });
  for (const filename of fs.readdirSync(sessions)) fs.unlinkSync(path.join(sessions, filename));
});
afterAll(() => {
  closeAgentRegistryForTests();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("unchanged transcript polls reuse one completed scan and preserve its open turn", async () => {
  const filename = transcript("unchanged");
  let scans = 0;
  setFileScanRunnerForTests((...args) => {
    scans++;
    return runFileCatalogScan(...args);
  });
  const first = await currentFileScan();
  for (let poll = 0; poll < 50; poll++) {
    const next = await cachedFileScan(undefined, filename);
    expect(next.generation).toBe(first.generation);
    expect(next.snapshot.files.find(row => row.path === filename)?.authoritativeTurn?.state).toBe("busy");
  }
  expect(scans).toBe(1);
});

test("a cold catalog read stays pending instead of publishing an empty catalog during scanning", async () => {
  const filename = transcript("cold");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  setFileScanRunnerForTests(async (...args) => {
    const snapshot = await runFileCatalogScan(...args);
    started.resolve();
    await release.promise;
    return snapshot;
  });
  let settled = false;
  const read = cachedFileScan().then(scan => { settled = true; return scan; });
  try {
    await started.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally {
    release.resolve();
  }
  expect((await read).snapshot.files.map(row => row.path)).toContain(filename);
});

test("fresh resource reads include a new active transcript before enrichment and drop deleted scope", async () => {
  const old = transcript("old");
  await currentFileScan();
  fs.unlinkSync(old);
  const active = transcript("active");
  const published = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  setFileScanRunnerForTests(async (intent, options, signal) => {
    const snapshot = await runFileCatalogScan(intent, {
      ...options,
      onResourceSnapshot: snapshot => {
        options?.onResourceSnapshot?.(snapshot);
        published.resolve();
      },
    }, signal);
    await release.promise;
    return snapshot;
  });
  let settled = false;
  const read = readResourceFileSnapshot(true).then(files => { settled = true; return files; });
  try {
    await published.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(true);
    const files = await read;
    expect(files.map(row => row.path)).toContain(active);
    expect(files.map(row => row.path)).not.toContain(old);
    expect(resourceWorkerRequestProblem({ type: "collect", fresh: true, files, identityEpoch: null, hosts: [] })).toBeNull();
  } finally {
    release.resolve();
    await currentFileScan();
  }
});
