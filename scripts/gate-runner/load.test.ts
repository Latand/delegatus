import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOAD_PROBE, localAdmission, parseLoad, queueReady, saturationReason, type LocalAdmission } from "./load";
import { makeHarness, testFile, type Harness } from "./harness.fixture";

const headroom: LocalAdmission = { load: 11, cpus: 24, pressureReady: true, queueReady: true, slotReady: true };

test("remote saturation and local admission must both allow the fallback", () => {
  for (const load of [24, 33, 43]) {
    expect(saturationReason(parseLoad(`load=${load}\ncpus=16\n`), () => headroom))
      .toBe(`the runner is saturated (load ${load} on 16 CPUs); local admission has headroom (load 11 on 24 CPUs)`);
  }
  for (const local of [null, { ...headroom, load: 18 }, { ...headroom, load: 24 },
    { ...headroom, pressureReady: false }, { ...headroom, queueReady: false },
    { ...headroom, slotReady: false }, { ...headroom, cpus: 0 }, { ...headroom, load: NaN }]) {
    expect(saturationReason({ load: 33, cpus: 16 }, () => local)).toBeNull();
  }
});

test("healthy or unknown remote load does not sample local admission", () => {
  const unexpected = () => { throw new Error("local admission was sampled"); };
  for (const remote of [null, parseLoad("load=23.99\ncpus=16\n")]) {
    expect(saturationReason(remote, unexpected)).toBeNull();
  }
  for (const output of ["", "load=33", "load=NaN\ncpus=16", "load=-1\ncpus=16", "load=33\ncpus=0", "load=33\ncpus=1.5"]) {
    expect(parseLoad(output)).toBeNull();
  }
});

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("admission snapshot respects waiting tickets and spacing without changing the queue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-load-"));
  roots.push(root);
  const file = path.join(root, "admission.sqlite");
  expect(queueReady(file, 10_000)).toBeTrue();
  expect(fs.existsSync(file)).toBeFalse();
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE tickets (key TEXT)");
    db.exec("CREATE TABLE suspended (key TEXT)");
    db.exec("CREATE TABLE stage_admissions (key TEXT)");
    db.exec("CREATE TABLE admission (id INTEGER, last INTEGER)");
    db.exec("INSERT INTO admission VALUES (1, NULL)");
    expect(queueReady(file, 10_000)).toBeTrue();
    db.exec("INSERT INTO tickets VALUES ('waiting')");
    expect(queueReady(file, 10_000)).toBeFalse();
    expect(db.query("SELECT * FROM tickets").all()).toEqual([{ key: "waiting" }]);
    db.exec("INSERT INTO suspended VALUES ('waiting')");
    expect(queueReady(file, 10_000)).toBeTrue();
    db.exec("DELETE FROM suspended");
    db.exec("INSERT INTO stage_admissions VALUES ('waiting')");
    expect(queueReady(file, 10_000)).toBeTrue();
    db.exec("UPDATE admission SET last = 9000");
    expect(queueReady(file, 10_000)).toBeFalse();
    expect(queueReady(file, 11_000)).toBeTrue();
    expect(db.query("SELECT last FROM admission").get()).toEqual({ last: 9000 });
  } finally { db.close(); }
});

test.skipIf(process.platform !== "linux")("local sampling requires readable pressure, queue and slot signals", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-load-signals-")); roots.push(root);
  const previous = process.env.LLV_GATE_LOCK_DIR;
  const load = spyOn(os, "loadavg").mockReturnValue([11, 0, 0]);
  const cpus = spyOn(os, "cpus").mockReturnValue(Array(24).fill({}));
  process.env.LLV_GATE_LOCK_DIR = root;
  const env = { ...process.env, LLV_GATE_SLOTS: "1", LLV_GATE_PSI_FILE: path.join(root, "pressure"), DELEGATUS_CPU_PRESSURE: "on", DELEGATUS_CPU_PRESSURE_RELEASE: "20" };
  try {
    fs.writeFileSync(env.LLV_GATE_PSI_FILE, "some avg10=19.99 avg60=0.00 avg300=0.00 total=0\n");
    expect(localAdmission(env)).toEqual(headroom);
    fs.writeFileSync(env.LLV_GATE_PSI_FILE, "some avg10=20.00 avg60=0.00 avg300=0.00 total=0\n");
    expect(localAdmission(env)?.pressureReady).toBeFalse();
    fs.writeFileSync(env.LLV_GATE_PSI_FILE, "unknown");
    expect(localAdmission(env)?.pressureReady).toBeFalse();
    fs.unlinkSync(env.LLV_GATE_PSI_FILE);
    expect(localAdmission(env)).toBeNull();
    expect(localAdmission({ ...env, DELEGATUS_CPU_PRESSURE: "off" })).toEqual(headroom);
    expect(localAdmission({ ...env, DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_SLOTS: "" })).toEqual(headroom);
    for (const slots of ["0", "1.5", "NaN", "01", "1.0", "+1", "1e0", " 1", "1\n", "1\r\n"]) expect(localAdmission({ ...env, LLV_GATE_SLOTS: slots })).toBeNull();
    const noPressure = { ...env, DELEGATUS_CPU_PRESSURE: "off" };
    expect(localAdmission({ ...noPressure, LLV_GATE_LOCK_DIR: path.join(root, "missing") })?.slotReady).toBeFalse();
    const holder = Bun.spawn(["flock", "-x", path.join(root, "llv-heavy-gate.slot1.lock"), "/bin/sh", "-c", "printf ready; read -r release"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const ready = await holder.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toBe("ready");
      expect(localAdmission(noPressure)?.slotReady).toBeFalse();
    } finally { holder.stdin.end(); await holder.exited; }
    expect(localAdmission(noPressure)?.slotReady).toBeTrue();
    fs.writeFileSync(path.join(root, "admission.sqlite"), "invalid queue");
    expect(localAdmission(noPressure)).toBeNull();
  } finally {
    load.mockRestore(); cpus.mockRestore();
    if (previous === undefined) delete process.env.LLV_GATE_LOCK_DIR;
    else process.env.LLV_GATE_LOCK_DIR = previous;
  }
});

// Override only the routing client's OS samples; the real wrapper still owns
// queue, slot, pressure and containment admission in each fresh process.
function routingFixture(localLoad = 11) {
  const h = makeHarness(); harnesses.push(h);
  const preload = path.join(h.root, "routing-samples.ts"), bun = path.join(h.root, "routing-bun");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(preload, `import os from "node:os"; os.loadavg = () => [${localLoad}, 0, 0]; os.cpus = () => Array(24).fill({});`);
  fs.writeFileSync(bun, `#!/bin/bash\nif [[ "\${1:-}" == */gate-runner/client.ts ]]; then exec ${quote(process.execPath)} --preload ${quote(preload)} "$@"; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  h.settings({ loadProbe: "load=24\ncpus=16\n" });
  const file = testFile(h, "routing.test.ts", `test("one execution", () => console.log("ran-once"));`);
  return { h, file, env: h.env({ LLV_GATE_BUN: bun }) };
}

const E2E_TIMEOUT = 240_000;
test.skipIf(process.platform !== "linux")("saturation chooses local once before shipment, resamples after restart, and off skips probes", () => {
  const { h, file, env } = routingFixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      // The first command consumed spacing. Freeze this fixture's last
      // admission in the past so restart coverage never depends on run time.
      const queue = new Database(path.join(env.LLV_GATE_LOCK_DIR!, "admission.sqlite"));
      try { queue.query("UPDATE admission SET last = 0 WHERE id = 1").run(); }
      finally { queue.close(); }
    }
    const result = h.run(["bun", "test", file], { env });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("gate-runner: running here: the runner is saturated (load 24 on 16 CPUs); local admission has headroom (load 11 on 24 CPUs)");
    expect(result.stdout.match(/ran-once/g)).toHaveLength(1);
    expect(h.calls().filter(call => call.command !== LOAD_PROBE && !call.command.includes("manager=ok"))).toEqual([]);
  }
  expect(h.calls().filter(call => call.command === LOAD_PROBE)).toHaveLength(2);
  expect(JSON.parse(fs.readFileSync(path.join(h.cache, "runner-health.json"), "utf8")).healthy).toBeTrue();
  const decisions = fs.readFileSync(path.join(h.cache, "runner-decisions.log"), "utf8");
  expect(decisions.match(/the runner is saturated/g)).toHaveLength(2);
  const calls = h.calls();
  const off = h.run(["bun", "test", file], { env: { ...env, LLV_GATE_RUNNER: "off" } });
  expect(off.code, off.stderr).toBe(0);
  expect(off.stdout.match(/ran-once/g)).toHaveLength(1);
  expect(off.stderr).not.toContain("the runner is saturated");
  expect(h.calls()).toEqual(calls);
}, E2E_TIMEOUT);

for (const [reason, localLoad, probe] of [
  ["local load has no headroom", 18, "load=24\ncpus=16\n"],
  ["the remote load signal is malformed", 11, "load=NaN\ncpus=16\n"],
] as const) test.skipIf(process.platform !== "linux")(`routing keeps remote execution when ${reason}`, () => {
  const { h, file, env } = routingFixture(localLoad);
  h.settings({ loadProbe: probe });
  const result = h.run(["bun", "test", file], { env });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/^gate-runner: running on the gate runner /m);
  expect(result.stdout.match(/ran-once/g)).toHaveLength(1);
  expect(h.calls().filter(call => call.command.includes("serve.ts run"))).toHaveLength(1);
  expect(result.stderr).not.toContain("the runner is saturated");
}, E2E_TIMEOUT);
