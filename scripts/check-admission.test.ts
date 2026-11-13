import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckAdmission, acquireCheckSlot, checkAdmissionFile, checkCapacity, withTestAdmission } from "./check-admission";
import { onlineCpuCount } from "../src/lib/runtime/cpuPlacement";
import type { ProcessIdentity, ProcessIdentityStatus } from "../src/lib/processIdentity";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";

const identity = (pid: number, start = 1): ProcessIdentity => ({ pid, startIdentity: `${pid}:${start}`, bootEpoch: "fixture" });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-admission-"));
  return { root, file: path.join(root, "checks.sqlite"), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("capacity reserves machine CPUs and rejects malformed headroom", () => {
  expect(checkCapacity({}, 24)).toBe(18);
  expect(checkCapacity({}, 1)).toBe(1);
  expect(checkCapacity({ LLV_GATE_CPU_HEADROOM: "5" }, 24)).toBe(19);
  expect(checkCapacity({ DELEGATUS_GATE_CPU_HEADROOM: "8", LLV_GATE_CPU_HEADROOM: "5" }, 24)).toBe(16);
  expect(checkCapacity({ LLV_GATE_CPU_HEADROOM: "100" }, 24)).toBe(1);
  for (const value of ["", "-1", "1.5", "NaN", "Infinity"]) expect(() => checkCapacity({ LLV_GATE_CPU_HEADROOM: value }, 24)).toThrow("nonnegative integer");
});

test("sandbox homes, state and gate locks cannot split the default machine pool", () => {
  const original = checkAdmissionFile({});
  expect(checkAdmissionFile({ HOME: "elsewhere", XDG_CONFIG_HOME: "elsewhere", LLV_STATE_DIR: "elsewhere", LLV_GATE_LOCK_DIR: "elsewhere" })).toBe(original);
  expect(checkAdmissionFile({ LLV_CHECK_ADMISSION_FILE: "fixture.sqlite" })).toBe("fixture.sqlite");
});

test("FIFO persists through reopen; unknown holders stay and dead or reused owners are reclaimed", () => {
  const f = fixture();
  const state = new Map<string, ProcessIdentityStatus>();
  const observer = { status: (owner: ProcessIdentity) => state.get(owner.startIdentity!) ?? "alive" as const, exited: () => false };
  let queue = new CheckAdmission(f.file, observer);
  const first = identity(101), second = identity(102), third = identity(103);
  try {
    expect(queue.claim(first, 1)).toBe(true);
    expect(queue.claim(second, 1)).toBe(false);
    expect(queue.claim(third, 1)).toBe(false);
    queue.close(); queue = new CheckAdmission(f.file, observer);
    state.set(first.startIdentity!, "unverified");
    expect(queue.claim(third, 1)).toBe(false);
    state.set(first.startIdentity!, "dead");
    expect(queue.claim(third, 1)).toBe(false);
    expect(queue.claim(second, 1)).toBe(true);
    state.set(second.startIdentity!, "dead");
    expect(queue.claim(third, 1)).toBe(true);
    // A new start identity at the same PID cannot reuse the held permit.
    expect(queue.claim(identity(103, 2), 1)).toBe(false);
    state.set(third.startIdentity!, "dead");
    expect(queue.claim(identity(103, 2), 1)).toBe(true);
  } finally { queue.close(); f.close(); }
});

test("strictest concurrent capacity wins and an exited waiter cannot hold the FIFO head", () => {
  const f = fixture(), exited = new Set<number>();
  const queue = new CheckAdmission(f.file, { status: () => "alive", exited: owner => exited.has(owner.pid) });
  try {
    expect(queue.claim(identity(101), 2)).toBe(true);
    expect(queue.claim(identity(102), 1)).toBe(false);
    expect(queue.claim(identity(103), 2)).toBe(false);
    exited.add(102);
    expect(queue.claim(identity(103), 2)).toBe(true);
  } finally { queue.close(); f.close(); }
});

test("legacy admission rows and new service lineage survive reopen in both readers", () => {
  const f = fixture(), first = identity(101), second = identity(102), third = identity(103);
  const legacy = new Database(f.file, { create: true });
  legacy.exec("CREATE TABLE checks(seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT UNIQUE NOT NULL, capacity INTEGER NOT NULL, held INTEGER NOT NULL DEFAULT 0)");
  legacy.query("INSERT INTO checks(owner, capacity, held) VALUES (?, 1, 1)").run(JSON.stringify(first));
  const observer = { status: () => "alive" as const, exited: () => false };
  let queue = new CheckAdmission(f.file, observer);
  try {
    expect(queue.holds(first)).toBe(true);
    expect(queue.claim(second, 1, [first])).toBe(false);
    // The old writer omits lineage, and the old reader selects its own fields.
    legacy.query("INSERT INTO checks(owner, capacity) VALUES (?, 1)").run(JSON.stringify(third));
    expect(legacy.query("SELECT owner, held FROM checks ORDER BY seq").all()).toEqual([
      { owner: JSON.stringify(first), held: 1 }, { owner: JSON.stringify(second), held: 0 }, { owner: JSON.stringify(third), held: 0 },
    ]);
    queue.close(); queue = new CheckAdmission(f.file, observer);
    expect(queue.db.query<{ lineage: string }, []>("SELECT lineage FROM checks ORDER BY seq").all().map(row => JSON.parse(row.lineage))).toEqual([[], [first], []]);
    queue.cancel(first);
    expect(queue.claim(second, 1, [first])).toBe(true);
    expect(queue.claim(third, 1)).toBe(false);
  } finally { queue.close(); legacy.close(); f.close(); }
});

test("binding folds a preload's racing ticket into its launch permit", () => {
  const f = fixture();
  const queue = new CheckAdmission(f.file, { status: () => "alive", exited: () => false });
  try {
    expect(queue.claim(identity(101), 1)).toBe(true);
    expect(queue.claim(identity(102), 1)).toBe(false);
    queue.bind(identity(101), identity(102));
    expect(queue.claim(identity(102), 1)).toBe(true);
    expect(queue.db.query("SELECT owner, held FROM checks").all()).toEqual([{ owner: JSON.stringify(identity(102)), held: 1 }]);
    expect(() => queue.bind(identity(102), { pid: 103, startIdentity: null, bootEpoch: null })).toThrow("verifiable identity");
    expect(() => queue.claim(identity(104), 0)).toThrow("positive capacity");
  } finally { queue.close(); f.close(); }
});

test("baseline test preloads survive the CPU-scope handoff", () => {
  const command = ["bash", "scripts/gate-slot.sh", "--in-cpu-scope", "bun", "test", "baseline.test.ts"];
  const wrapped = withTestAdmission(command, "check-test-preload.ts");
  expect(wrapped).toEqual([...command.slice(0, 5), "--preload", "check-test-preload.ts", "baseline.test.ts"]);
  expect(withTestAdmission(wrapped, "check-test-preload.ts")).toEqual(wrapped);
  expect(withTestAdmission(["bun", "run", "test", "branch.test.ts"], "preload.ts")).toEqual(["bun", "run", "test", "--preload", "preload.ts", "branch.test.ts"]);
});

for (const [capacity, hang, service] of [[1, false, false], [2, false, false], [1, true, false], [1, false, true]] as const) test.skipIf(process.platform !== "linux" || service && !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`nested workers cap=${capacity} hang=${hang} service=${service} preserve the process bound and deadline`, async () => {
  const f = processFixture();
  const worker = path.join(f.root, "nested.test.ts");
  const runner = path.join(import.meta.dir, "owned-runner.ts");
  fs.writeFileSync(worker, `import fs from "node:fs";
    import { spawn } from "node:child_process"; import { test, expect } from "bun:test";
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.LLV_CHECK_ADMISSION_FILE);
    function sample() {
      try { return db.transaction(() => {
        const active = ["parent", "first", "second"].filter(id => {
          try {
            const pid = Number(fs.readFileSync(${JSON.stringify(f.root)} + "/" + id + ".start", "utf8"));
            const state = /^State:\\s+(\\S)/m.exec(fs.readFileSync("/proc/" + pid + "/status", "utf8"))?.[1];
            return state && !["T", "Z", "X"].includes(state);
          } catch { return false; }
        }).length;
        const peakFile = ${JSON.stringify(f.root)} + "/peak";
        const peak = fs.existsSync(peakFile) ? Number(fs.readFileSync(peakFile, "utf8")) : 0;
        fs.writeFileSync(peakFile, String(Math.max(peak, active)));
        expect(active).toBeLessThanOrEqual(${capacity});
        return true;
      }).immediate(); } catch (error) {
        if (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED") return false;
        throw error;
      }
    }
    test("nested worker", async () => {
      fs.writeFileSync(process.env.START, String(process.pid));
      while (!sample()) await Bun.sleep(1);
      if (process.env.ROLE === "parent") {
        const children = ["first", "second"].map(id => spawn(process.execPath,
          [${JSON.stringify(runner)}, ...${JSON.stringify(service ? [] : ["--portable"])}, process.execPath, "test", "./nested.test.ts"],
          { env: {...process.env, ROLE: id, START: ${JSON.stringify(f.root)} + "/" + id + ".start"}, stdio: "inherit" }));
        const exits = children.map(child => new Promise(resolve => child.once("exit", resolve)));
        while (!["first", "second"].every(id => fs.existsSync(${JSON.stringify(f.root)} + "/" + id + ".start"))) { sample(); await Bun.sleep(10); }
        sample();
        if (process.env.HANG === "1") await new Promise(() => {});
        fs.writeFileSync(process.env.RELEASE, "release");
        for (const code of await Promise.all(exits)) expect(code).toBe(0);
      } else while (!fs.existsSync(process.env.RELEASE)) { sample(); await Bun.sleep(10); }
      db.close();
    }, 30_000);`);
  const child = spawn(process.execPath, [runner, ...(service ? [] : ["--portable"]), process.execPath, "test", "./nested.test.ts"], {
    cwd: f.root, env: { ...f.env, ROLE: "parent", START: path.join(f.root, "parent.start"), RELEASE: path.join(f.root, "nested.release"),
      DELEGATUS_GATE_CPU_HEADROOM: String(onlineCpuCount() - capacity), HANG: hang ? "1" : "0",
      LLV_OWNED_RUN_TIMEOUT_MS: hang ? "1500" : "30000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr!.on("data", data => { stderr += String(data); }); child.stdout!.resume();
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    expect(await exited, stderr).toBe(hang ? 124 : 0);
    for (const id of ["parent", "first", "second"]) expect(f.started(id)).toBe(true);
    const peak = Number(fs.readFileSync(path.join(f.root, "peak"), "utf8"));
    expect(peak).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(capacity);
    console.log(JSON.stringify({ capacity, peakExecutingWorkers: peak, hang, service, terminalExit: child.exitCode }));
    await until(() => f.rows().length === 0);
  } finally { await stopFixtureProcess(child); await f.close(); }
}, 60_000);

test.skipIf(process.platform !== "linux")("a nested real watch compiler lends a turn back to its test parent", async () => {
  const f = processFixture();
  const runner = path.join(import.meta.dir, "owned-runner.ts");
  const compiler = path.resolve(import.meta.dir, "../node_modules/typescript/bin/tsc");
  fs.writeFileSync(path.join(f.root, "source.ts"), "export const answer: number = 42;\n");
  fs.writeFileSync(path.join(f.root, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], skipLibCheck: true, outDir: "out" }, files: ["source.ts"] }));
  fs.writeFileSync(path.join(f.root, "parent.test.ts"), `import fs from "node:fs";
    import { spawn } from "node:child_process"; import { test, expect } from "bun:test";
    import { Database } from "bun:sqlite";
    import { stopFixtureProcess } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/lib/testing/fixtureProcess.ts"))};
    test("parent controls its watch compiler", async () => {
      const child = spawn(process.execPath, [${JSON.stringify(runner)}, "--portable", process.execPath,
        ${JSON.stringify(compiler)}, "--project", "tsconfig.json", "--watch", "--preserveWatchOutput"], {env:process.env,stdio:"inherit"});
      try {
        while (!fs.existsSync("out/source.js")) await Bun.sleep(10);
        const db = new Database(process.env.LLV_CHECK_ADMISSION_FILE);
        try {
          const rows = db.query("SELECT owner FROM checks").all();
          const executing = rows.filter(row => {
            try { return !/^State:\\s+[TZX]/m.test(fs.readFileSync("/proc/" + JSON.parse(row.owner).pid + "/status", "utf8")); }
            catch { return false; }
          });
          expect(executing).toHaveLength(1);
          expect(child.exitCode).toBeNull();
        } finally { db.close(); }
      } finally { await stopFixtureProcess(child); }
    }, 20_000);`);
  const child = spawn(process.execPath, [runner, "--portable", process.execPath, "test", "./parent.test.ts"], {
    cwd: f.root, env: { ...f.env, DELEGATUS_GATE_CPU_HEADROOM: String(onlineCpuCount() - 1) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr!.on("data", data => { stderr += String(data); }); child.stdout!.resume();
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    expect(await exited, stderr).toBe(0);
    expect(fs.existsSync(path.join(f.root, "out/source.js"))).toBe(true);
    await until(() => f.rows().length === 0);
  } finally { await stopFixtureProcess(child); await f.close(); }
}, 60_000);

test("concurrent ancestor probes retry admission database initialization", async () => {
  const f = fixture();
  const env = withoutInheritedGate<NodeJS.ProcessEnv>({ ...process.env, LLV_CHECK_ADMISSION_FILE: f.file });
  const source = `import { admittedCheckAncestor } from ${JSON.stringify(path.join(import.meta.dir, "check-admission.ts"))};
    if (await admittedCheckAncestor(process.pid)) process.exit(2); console.log("probe-ready");`;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["-e", source], { env, stdio: ["ignore", "pipe", "pipe"] }));
  try {
    const results = await Promise.all(children.map(child => new Promise<{ code: number | null; output: string; error: string }>(resolve => {
      let output = "", error = "";
      child.stdout!.on("data", chunk => { output += String(chunk); });
      child.stderr!.on("data", chunk => { error += String(chunk); });
      child.once("close", code => resolve({ code, output, error }));
      child.once("error", cause => resolve({ code: -1, output, error: String(cause) }));
    })));
    for (const result of results) expect(result, result.error).toMatchObject({ code: 0, output: "probe-ready\n" });
  } finally { await Promise.all(children.map(child => stopFixtureProcess(child))); f.close(); }
});

async function until(check: () => boolean) {
  const deadline = performance.now() + 15_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("check fixture did not reach its barrier");
    await Bun.sleep(10);
  }
}

function processFixture() {
  const f = fixture();
  const env = withoutInheritedGate<NodeJS.ProcessEnv>({ ...process.env, LLV_CHECK_ADMISSION_FILE: f.file, LLV_GATE_CPU_HEADROOM: String(Math.max(0, onlineCpuCount() - 2)) });
  delete env.DELEGATUS_GATE_CPU_HEADROOM;
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
    env[key] = path.join(f.root, key.toLowerCase()); fs.mkdirSync(env[key]!, { recursive: true });
  }
  env.LLV_OWNED_RUN_TIMEOUT_MS = "30000";
  env.LLV_TEST_STARTUP_HOME = env.HOME;
  env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  // A baseline-style checkout with no admission preload of its own.
  fs.writeFileSync(path.join(f.root, "bunfig.toml"), "[test]\n");
  const source = `fs.writeFileSync(process.env.START, String(process.pid));
    while (!fs.existsSync(process.env.RELEASE)) await Bun.sleep(10);`;
  fs.writeFileSync(path.join(f.root, "tsc"), `import fs from "node:fs"; ${source}`);
  fs.writeFileSync(path.join(f.root, "worker.test.ts"), `import fs from "node:fs"; import { test } from "bun:test"; test("held worker", async () => { ${source} }, 30_000);`);
  new CheckAdmission(f.file).close();
  const db = new Database(f.file);
  const children: ReturnType<typeof spawn>[] = [];
  const records: { id: string; child: ReturnType<typeof spawn>; code: Promise<number | null>; stderr: () => string }[] = [];
  const rows = () => db.query<{ seq: number; owner: string; held: number }, []>("SELECT seq, owner, held FROM checks ORDER BY seq").all();
  const start = (id: string, compiler = false) => {
    const child = spawn(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), "--portable", process.execPath,
      ...(compiler ? [path.join(f.root, "tsc")] : [...(id === "base" ? ["--smol"] : []), "test", "./worker.test.ts"])], {
      cwd: f.root, env: { ...env, START: path.join(f.root, `${id}.start`), RELEASE: path.join(f.root, `${id}.release`) }, stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let stderr = ""; child.stderr!.on("data", data => { stderr += String(data); });
    const code = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    records.push({ id, child, code, stderr: () => stderr });
    return child;
  };
  const started = (id: string) => fs.existsSync(path.join(f.root, `${id}.start`));
  const release = (id: string) => fs.writeFileSync(path.join(f.root, `${id}.release`), "release");
  return { ...f, env, db, records, rows, start, started, release,
    waitStarted: async (id: string) => {
      const record = records.find(record => record.id === id)!;
      await until(() => started(id) || record.child.exitCode !== null || record.child.signalCode !== null);
      expect(started(id), record.stderr()).toBe(true);
    },
    close: async () => {
      for (const record of records) release(record.id);
      await Promise.all(children.map(child => stopFixtureProcess(child)));
      db.close(); f.close();
    } };
}

test.skipIf(process.platform === "win32")("separate gates count branch, baseline and compiler workers together in FIFO order", async () => {
  const f = processFixture();
  try {
    f.start("branch"); await f.waitStarted("branch");
    f.start("base"); await f.waitStarted("base");
    f.start("types", true); await until(() => f.rows().length === 3 || f.started("types"));
    // Original runners start this third workload while both tests are held.
    expect(f.started("types")).toBe(false);
    expect(f.rows().filter(row => row.held)).toHaveLength(2);
    f.start("peer"); await until(() => f.rows().length === 4);
    expect(f.rows().map(row => row.held)).toEqual([1, 1, 0, 0]);
    expect(f.started("types")).toBe(false); expect(f.started("peer")).toBe(false);
    const queued = f.rows().slice(2).map(row => row.seq);
    f.release("base"); await until(() => f.started("types"));
    // Check the exact mutation seam: the first waiter owns the freed permit,
    // bound to the compiler PID; the second waiter still has no effects.
    await until(() => f.rows().some(row => row.seq === queued[0] && row.held === 1
      && JSON.parse(row.owner).pid === Number(fs.readFileSync(path.join(f.root, "types.start"), "utf8"))));
    expect(f.rows().filter(row => row.held)).toHaveLength(2);
    expect(f.started("peer")).toBe(false);
    f.release("branch"); await until(() => f.started("peer"));
    expect(f.rows().find(row => row.seq === queued[1])?.held).toBe(1);
    expect(f.rows().filter(row => row.held)).toHaveLength(2);
    f.release("types"); f.release("peer");
    for (const record of f.records) expect(await record.code, record.stderr()).toBe(0);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(process.platform === "win32")("a compiler failure preserves its exit and its permit is reusable", async () => {
  const f = processFixture();
  try {
    fs.writeFileSync(path.join(f.root, "tsc"), "process.exit(7);");
    f.start("failure", true);
    expect(await f.records[0]!.code, f.records[0]!.stderr()).toBe(7);
    f.start("successor"); await f.waitStarted("successor");
    expect(f.rows().filter(row => row.held)).toHaveLength(1);
    f.release("successor");
    expect(await f.records[1]!.code, f.records[1]!.stderr()).toBe(0);
  } finally { await f.close(); }
}, 60_000);

for (const interpreter of ["bun", "node"]) test(`a real compiler through a ${interpreter} package script waits without output`, async () => {
  const f = processFixture();
  const runner = path.join(import.meta.dir, "owned-runner.ts");
  const compiler = path.resolve(import.meta.dir, "../node_modules/typescript/bin/tsc");
  const binary = interpreter === "bun" ? process.execPath : Bun.which("node")!;
  const env = { ...f.env, DELEGATUS_GATE_CPU_HEADROOM: String(onlineCpuCount() - 1) };
  for (const name of ["held", "second"]) {
    fs.mkdirSync(path.join(f.root, name));
    fs.writeFileSync(path.join(f.root, name, "source.ts"), "export const answer: number = 42;\n");
    fs.writeFileSync(path.join(f.root, name, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], skipLibCheck: true, outDir: "out" }, files: ["source.ts"] }));
  }
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ scripts: {
    typecheck: `${interpreter === "node" && process.platform !== "win32" ? `sh -c 'exec "$@"' compiler-probe ` : ""}${JSON.stringify(binary)} ${JSON.stringify(compiler)} --project second/tsconfig.json --listEmittedFiles`,
  } }));
  const start = (args: string[]) => {
    const child = spawn(process.execPath, [runner, "--portable", ...args], { cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", data => { stdout += String(data); });
    child.stderr!.on("data", data => { stderr += String(data); });
    const exited = new Promise(resolve => child.once("exit", resolve));
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  };
  const first = start([process.execPath, compiler, "--project", "held/tsconfig.json", "--watch", "--preserveWatchOutput"]);
  let second: ReturnType<typeof start> | undefined;
  try {
    await until(() => fs.existsSync(path.join(f.root, "held/out/source.js")) || first.child.exitCode !== null);
    expect(first.child.exitCode, first.stderr()).toBeNull();
    second = start([process.execPath, "run", "typecheck"]);
    await until(() => f.rows().length === 2 || second!.child.exitCode !== null);
    expect(f.rows().map(row => row.held), second.stderr()).toEqual([1, 0]);
    expect(second.stdout()).toBe("");
    expect(fs.existsSync(path.join(f.root, "second/out/source.js"))).toBe(false);
    expect(second.child.exitCode).toBeNull();
    await stopFixtureProcess(first.child);
    expect(await second.exited, second.stderr()).toBe(0);
    expect(second.stdout()).toContain("TSFILE:");
    expect(fs.existsSync(path.join(f.root, "second/out/source.js"))).toBe(true);
    await until(() => f.rows().length === 0);
  } finally {
    if (second) await stopFixtureProcess(second.child);
    await stopFixtureProcess(first.child); await f.close();
  }
}, 60_000);

test("real process restart reclaims an abandoned holder and waiter", async () => {
  const f = processFixture();
  const children: ReturnType<typeof spawn>[] = [];
  const source = path.join(f.root, "owner.ts");
  fs.writeFileSync(source, `import { acquireCheckSlot } from ${JSON.stringify(path.join(import.meta.dir, "check-admission.ts"))};
    import fs from "node:fs";
    const slot = await acquireCheckSlot(); slot.queue.close();
    fs.writeFileSync(process.env.START, "admitted"); setInterval(() => {}, 1000);`);
  const start = (id: string) => {
    const child = spawn(process.execPath, [source], { cwd: f.root, env: { ...f.env, LLV_GATE_CPU_HEADROOM: String(Math.max(0, onlineCpuCount() - 1)), START: path.join(f.root, `${id}.start`) }, stdio: "ignore" });
    children.push(child); return child;
  };
  try {
    const holder = start("holder"); await until(() => f.started("holder"));
    const waiter = start("waiter"); await until(() => f.rows().length === 2);
    expect(f.rows().map(row => JSON.parse(row.owner).pid)).toEqual([holder.pid, waiter.pid]);
    waiter.kill("SIGKILL"); await until(() => waiter.signalCode !== null);
    holder.kill("SIGKILL"); await until(() => holder.signalCode !== null);
    // Neither process performed a graceful release. A new interpreter must
    // recover the persisted records and admit its own, distinct identity.
    expect(f.rows()).toHaveLength(2);
    const successor = start("successor"); await until(() => f.started("successor"));
    expect(f.rows().map(row => [JSON.parse(row.owner).pid, row.held])).toEqual([[successor.pid, 1]]);
  } finally { await Promise.all(children.map(child => stopFixtureProcess(child))); await f.close(); }
}, 60_000);

test("cancellation after a durable enqueue removes its FIFO ticket", async () => {
  const f = fixture();
  const queue = new CheckAdmission(f.file);
  const controller = new AbortController();
  const env: NodeJS.ProcessEnv = { ...process.env, LLV_CHECK_ADMISSION_FILE: f.file, LLV_GATE_CPU_HEADROOM: String(onlineCpuCount()) };
  delete env.DELEGATUS_GATE_CPU_HEADROOM;
  // The current runner already has a live identity but this pool is private.
  const { cpuOwnerIdentity } = await import("../src/lib/runtime/signalSandboxContext");
  const owner = cpuOwnerIdentity(process.ppid);
  try {
    expect(queue.claim(owner, 1)).toBe(true);
    const pending = acquireCheckSlot(env, controller.signal);
    const observed = pending.then(() => ({ admitted: true }), error => ({ error }));
    await until(() => (queue.db.query("SELECT * FROM checks").all().length === 2));
    controller.abort(); expect(await observed).toHaveProperty("error");
    expect(queue.db.query("SELECT owner FROM checks").all()).toEqual([{ owner: JSON.stringify(owner) }]);
  } finally { queue.close(); f.close(); }
});

test("cancellation at the grant await removes the just-admitted holder", async () => {
  const f = fixture(), controller = new AbortController();
  const original = CheckAdmission.prototype.claim;
  CheckAdmission.prototype.claim = function (owner, capacity) {
    const admitted = original.call(this, owner, capacity);
    if (admitted) controller.abort();
    return admitted;
  };
  try {
    await expect(acquireCheckSlot({ ...process.env, LLV_CHECK_ADMISSION_FILE: f.file }, controller.signal)).rejects.toThrow();
    const queue = new CheckAdmission(f.file);
    try { expect(queue.db.query("SELECT * FROM checks").all()).toEqual([]); }
    finally { queue.close(); }
  } finally { CheckAdmission.prototype.claim = original; f.close(); }
});
