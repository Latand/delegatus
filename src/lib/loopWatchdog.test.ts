import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loopWatchdogLayout, readLoopStall } from "./loopWatchdog";

const moduleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "loopWatchdog.ts")).href;

async function runProbe(script: string, deadlineMs = 20_000) {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-watchdog-test-"));
  const roots = Object.fromEntries(["home", "config", "state", "tmp"].map(key => [key, path.join(directory, key)]));
  await Promise.all(Object.values(roots).map(root => mkdir(root)));
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, HOME: roots.home, XDG_CONFIG_HOME: roots.config, LLV_STATE_DIR: roots.state,
      TMPDIR: roots.tmp, LLV_STATE_OWNER: undefined, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
  try {
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    return JSON.parse(output);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}

const setup = `
  const { startLoopWatchdog } = await import(${JSON.stringify(moduleUrl)});
  const watchdog = startLoopWatchdog();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const readyDeadline = performance.now() + 10000;
  while (!watchdog.snapshot().available) {
    if (performance.now() > readyDeadline) throw Error("watchdog did not start");
    watchdog.heartbeat(); await delay(20);
  }
`;

test("trigger storage is numeric, fixed, and unpublished rows are rejected", () => {
  const cells = new BigInt64Array(new SharedArrayBuffer(loopWatchdogLayout.cells * 8));
  expect(cells.byteLength).toBe(43_272);
  expect(readLoopStall(cells)).toBeNull();
  const at = loopWatchdogLayout.trigger;
  [0, 1_500_000, 100_000, 12345, 7, 1_400_000].forEach((value, offset) => Atomics.store(cells, at + offset, BigInt(value)));
  expect(readLoopStall(cells)).toBeNull();
  Atomics.store(cells, at, BigInt(1));
  expect(readLoopStall(cells)).toEqual({ sequence: 1, monotonicUs: 1_500_000, heartbeatUs: 100_000,
    utcMs: 12345, site: 7, ageMs: 1400 });
});

test("independent worker records a stale heartbeat before recovery, once per stall, across fresh processes", async () => {
  for (let run = 0; run < 2; run++) {
    const report = await runProbe(setup + `
      watchdog.heartbeat(); watchdog.site(7);
      const began = Date.now();
      function namedBlockedControl() { const until = performance.now() + 1800; while (performance.now() < until) {} }
      namedBlockedControl();
      const recovered = Date.now();
      // Delay observation beyond recovery; no recovery callback creates the trigger.
      await delay(400);
      const first = watchdog.snapshot().stall;
      watchdog.heartbeat();
      const heartbeat = setInterval(() => watchdog.heartbeat(), 10);
      await delay(250);
      clearInterval(heartbeat);
      // A second stale heartbeat inside the minute keeps the first trigger.
      watchdog.heartbeat(); namedBlockedControl();
      const second = watchdog.snapshot().stall;
      await watchdog.stop();
      console.log(JSON.stringify({ began, recovered, first, second }));
    `);
    expect(report.first.sequence).toBe(1);
    expect(report.first.site).toBe(7);
    expect(report.first.utcMs).toBeGreaterThanOrEqual(report.began + 1000);
    expect(report.first.utcMs).toBeLessThan(report.recovered);
    expect(report.first.ageMs).toBeGreaterThan(1000);
    expect(report.second).toEqual(report.first);
  }
}, 45_000);

test("actual producer wraps at 600 samples and a healthy heartbeat never triggers", async () => {
  const report = await runProbe(setup + `
    const heartbeat = setInterval(() => watchdog.heartbeat(), 10);
    const deadline = performance.now() + 90000;
    let snapshot;
    do {
      await delay(100);
      snapshot = watchdog.snapshot();
      if (performance.now() > deadline) throw Error("ring did not wrap");
    } while ((snapshot.samples.at(-1)?.sequence ?? 0) < 605);
    clearInterval(heartbeat); await watchdog.stop();
    console.log(JSON.stringify({ count: snapshot.samples.length, stall: snapshot.stall,
      first: snapshot.samples[0].sequence, last: snapshot.samples.at(-1).sequence,
      ordered: snapshot.samples.every((row, i, rows) => !i || row.sequence > rows[i - 1].sequence) }));
  `, 100_000);
  expect(report.count).toBeLessThanOrEqual(600);
  expect(report.count).toBeGreaterThanOrEqual(599);
  expect(report.last - report.first).toBeLessThanOrEqual(599);
  expect(report.ordered).toBe(true);
  expect(report.stall).toBeNull();
}, 110_000);
