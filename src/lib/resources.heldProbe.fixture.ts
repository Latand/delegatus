import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const WATCHDOG_MS = 400;
const WAIT_MS = 75;
const HEARTBEAT_MS = 25;
const HOST_PID = 41_100;
const HELPER_PID = HOST_PID + 1;
const directory = process.env.LLV_TEST_PROBE_DIR!;
const heldProbe = process.env.LLV_TEST_HELD_PROBE!;
const viewerPid = Number(process.env.LLV_TEST_PROBE_VIEWER_PID);

async function command(name: string, args: string[]): Promise<void> {
  let probe = name;
  if (name === "ps" && args.includes("pid=,rss=")) probe = "rss";
  if (name === "sysctl") probe = args.at(-1)!;
  if (probe === heldProbe && !existsSync(path.join(directory, "collection-complete"))) {
    const started = path.join(directory, `started-${process.pid}`);
    const release = path.join(directory, `release-${process.pid}`);
    writeFileSync(started, "");
    const deadline = performance.now() + WATCHDOG_MS;
    while (!existsSync(release) && performance.now() < deadline) await Bun.sleep(5);
    if (!existsSync(release)) writeFileSync(path.join(directory, `expired-${process.pid}`), "");
  }

  const outputs: Record<string, string> = {
    vm_stat: "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 20.\nPages inactive: 10.",
    "vm.swapusage": "total = 1M used = 0M",
    "kern.boottime": "{ sec = 100, usec = 0 }",
    ps: `${viewerPid} 1 ?? bun viewer.ts\n${HOST_PID} ${viewerPid} ?? codex app-server\n${HELPER_PID} ${HOST_PID} ?? helper`,
    lsof: `p${HOST_PID}\nn${directory}`,
    rss: `${viewerPid} 1024\n${HOST_PID} 512\n${HELPER_PID} 256`,
    "powershell.exe": [
      "ProcessId,ParentProcessId,CommandLine,WorkingSetSize,UserModeTime,KernelModeTime,Created",
      `${viewerPid},1,bun viewer.ts,1048576,0,0,100`,
    ].join("\n"),
  };
  console.log(outputs[probe] ?? "");
  // lsof can emit valid cwd records and still report an inaccessible process.
  if (probe === "lsof") process.exitCode = 1;
}

function markers(prefix: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith(prefix));
}

async function startedProbe(ignored: string[] = []): Promise<string> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const started = markers("started-").find((name) => !ignored.includes(name));
    if (started) return started;
    await Bun.sleep(5);
  }
  throw new Error(`no start acknowledgment from ${heldProbe}`);
}

function releaseProbe(started: string): void {
  assert.deepEqual(markers("expired-"), [], `${heldProbe} blocked the Viewer until the 400 ms watchdog released it`);
  writeFileSync(path.join(directory, started.replace("started-", "release-")), "");
}

async function exerciseProductionRead(): Promise<void> {
  process.env.LLV_TEST_PROBE_VIEWER_PID = String(process.pid);
  const { procBackend } = await import("./proc");
  const { statePath } = await import("./configDir");
  const { agentRegistry } = await import("./agent/registry");
  const { setFileCatalogMembershipProbeForTests, setFileScanRunnerForTests } = await import("./scanner/scanCache");
  const { readResourcesWithDiagnostic } = await import("./resources");
  const { readDiskPressure } = await import("./state/diskPressure");
  const { stopWorktreeSweepWorker } = await import("./pipelines/worktreeSweepWorker");
  await Promise.all([
    import("./agentState/service"), import("./pipelines/worktreeSweep"), import("./tempSweep"),
    import("./selfUpdate/retention"), import("./scanner/filesResponseResults"),
  ]);
  Object.defineProperty(process, "platform", { value: procBackend.name === "portable" ? "darwin" : "win32" });
  // Fix unrelated inputs, leaving snapshot assembly and response handling real.
  mkdirSync(statePath(), { recursive: true });
  agentRegistry().readOnlySnapshot();
  setFileCatalogMembershipProbeForTests(async () => null);
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: true }));
  writeFileSync(statePath("viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:2" }));
  await readDiskPressure();
  procBackend.processIdentity = (pid) => pid === HOST_PID ? "fixture-start" : null;
  procBackend.readEnvVar = (pid, name) => pid === HOST_PID && name === "LLV_STRUCTURED_HOST" ? statePath() : null;

  let complete: ReturnType<typeof readResourcesWithDiagnostic> | undefined;
  try {
    complete = readResourcesWithDiagnostic();
    // A synchronous reader can acknowledge from its subprocess but cannot let
    // the Viewer observe that acknowledgment before the watchdog expires.
    const started = await startedProbe();
    assert.deepEqual(markers("expired-"), [], `${heldProbe} blocked before its start acknowledgment could be observed`);
    const start = performance.now();
    const [pending, heartbeatAt] = await Promise.all([
      readResourcesWithDiagnostic(false, { waitMs: WAIT_MS }).then((read) => ({ read, at: performance.now() - start })),
      Bun.sleep(HEARTBEAT_MS).then(() => performance.now() - start),
    ]);
    assert.equal(pending.read.diagnostic.status, "pending");
    assert.match(pending.read.diagnostic.collectorId, /^in-process:/);
    assert.equal(pending.read.payload.sessionsStale, true);
    assert.deepEqual(pending.read.payload.sessions, []);
    if (heldProbe === "vm_stat" || heldProbe === "vm.swapusage") assert.equal(pending.read.payload.system, null);
    assert.ok(heartbeatAt < WAIT_MS, `25 ms heartbeat fired after ${heartbeatAt.toFixed(1)} ms`);
    assert.ok(pending.at < 250, `75 ms read returned after ${pending.at.toFixed(1)} ms`);
    releaseProbe(started);

    // Darwin's separate Viewer-tree RSS sample uses the same command. A
    // synchronous Viewer-tree read cannot observe its own start marker.
    if (heldProbe === "rss") {
      const viewerStarted = await startedProbe([started]);
      const cached = await readResourcesWithDiagnostic(false, { waitMs: WAIT_MS });
      assert.equal(cached.diagnostic.status, "complete");
      assert.equal(cached.diagnostic.generation, pending.read.diagnostic.generation);
      assert.equal(cached.payload.viewer, null);
      releaseProbe(viewerStarted);
    }
    const completed = await complete;
    assert.deepEqual(markers("expired-"), [], `${heldProbe} ran again and blocked after release`);
    assert.equal(completed.diagnostic.status, "complete");
    assert.equal(completed.diagnostic.generation, pending.read.diagnostic.generation);
    assert.equal(completed.payload.sessionsStale, false);
    assert.equal(completed.payload.viewer?.rssBytes, 1_048_576);
    assert.equal(completed.payload.viewer?.procCount, 1);
    if (procBackend.name === "portable") {
      assert.equal(completed.payload.system?.ramAvailable, 122_880);
      assert.equal(completed.payload.system?.swapTotal, 1_048_576);
      assert.deepEqual(completed.payload.sessions.map(({ panePid, rssBytes, procCount }) => ({ panePid, rssBytes, procCount })),
        [{ panePid: HOST_PID, rssBytes: 786_432, procCount: 2 }]);
    } else {
      assert.ok(completed.payload.system?.ramTotal);
    }
    writeFileSync(path.join(directory, "collection-complete"), "");
    const next = await readResourcesWithDiagnostic(false, { waitMs: WAIT_MS });
    assert.equal(next.diagnostic.status, "complete");
    assert.equal(next.diagnostic.generation, completed.diagnostic.generation);
    console.log(`${heldProbe}: heartbeat ${heartbeatAt.toFixed(1)} ms, pending ${pending.at.toFixed(1)} ms, complete after release`);
  } finally {
    // Let every command we started settle, including one entered on failure.
    for (const started of markers("started-")) {
      writeFileSync(path.join(directory, started.replace("started-", "release-")), "");
    }
    await complete?.catch(() => {});
    await stopWorktreeSweepWorker();
  }
}

if (process.argv[2] === "command") await command(process.argv[3]!, process.argv.slice(4));
else await exerciseProductionRead();
