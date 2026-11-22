import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactBounded } from "../src/lib/monitor/redact";
import { cpuAdmissionFile, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS, CpuAdmissionQueue, inheritedCpuSlot } from "../src/lib/runtime/cpuAdmission";
import { cpuOwnerIdentity, cpuOwnerStatus } from "../src/lib/runtime/signalSandboxContext";
import { installedGateAdmissionEnv } from "../src/lib/runtime/agentSignalSandbox";
import { realExec } from "../src/lib/workflows/provision";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { runSteps } from "./local-gate";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { createHookFixture, fixtureGitEnv } from "./local-gate.fixture";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";

// This release predates bounded gate waits and cap locks. Use its actual
// shell, helper and queue, including the legacy SQL used on final claim.
const legacyRevision = "2c7e437a553f56d81afa39e71878f60a1e6d73a3";

function legacyGateTree(directory: string, revision = legacyRevision) {
  const tree = path.join(directory, "legacy");
  fs.mkdirSync(tree);
  let source = process.cwd();
  if (Bun.spawnSync(["git", "cat-file", "-e", revision], { stderr: "ignore" }).exitCode !== 0) {
    // A shallow checkout may omit the historical producer. Fetch only its
    // pinned object into a private fixture repository.
    source = path.join(directory, "history.git");
    const origin = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--bare", source]);
    execFileSync("git", ["-C", source, "fetch", "--no-tags", "--depth=1", origin, revision], { timeout: 30_000 });
  }
  execFileSync("bash", ["-o", "pipefail", "-c", 'git archive "$1" | tar -xf - -C "$2"', "archive-legacy-gate", revision, tree], { cwd: source });
  fs.symlinkSync(path.resolve("node_modules"), path.join(tree, "node_modules"), "dir");
  return tree;
}

async function until(check: () => boolean, timeoutMs = 5_000, failure = () => new Error("queue fixture did not reach its barrier")) {
  const ends = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > ends) throw failure(); await Bun.sleep(10); }
}
const queuedTickets = "FROM tickets WHERE key NOT GLOB 'command:gate-active:*'";
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-queue-"));
  const env = { ...process.env, LLV_GATE_LOCK_DIR: dir, LLV_GATE_PSI_FILE: path.join(dir, "pressure"), LLV_GATE_POLL_SECONDS: "0.02", DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "on", LLV_GATE_PSI_RELEASE_SECONDS: "0" };
  // The fixture's gates queue for slots of their own, never the run's gate. A
  // signal-sandboxed stage keeps its marker: these gates use the real user
  // manager and really start in the stage's namespaces.
  withoutInheritedGate(env, { keepSandbox: true });
  fs.writeFileSync(env.LLV_GATE_PSI_FILE, "some avg10=90.00 avg60=90.00 avg300=90.00 total=1\n");
  const file = path.join(dir, path.basename(cpuAdmissionFile()));
  new CpuAdmissionQueue(file).close();
  const db = new Database(file);
  db.exec("PRAGMA busy_timeout=5000");
  const command = (word: string) => ["bash", "scripts/gate-slot.sh", "bash", "-c", `echo ${word} >> "$CPU_QUEUE_OUTPUT"`];
  return { dir, env: { ...env, CPU_QUEUE_OUTPUT: path.join(dir, "output") }, db, command,
    count: () => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n ${queuedTickets}`).get()!.n,
    age: () => db.query("UPDATE tickets SET since = ? WHERE key NOT GLOB 'command:gate-active:*'").run(Date.now() - CPU_QUEUE_MAX_WAIT_MS),
    close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

for (const exitCode of [0, 23]) test.skipIf(process.platform === "win32")(`macOS identity workflow admits a loaded runner and preserves command exit ${exitCode}`, async () => {
  const workflow = Bun.YAML.parse(fs.readFileSync(path.join(import.meta.dir, "../.github/workflows/macos-identity.yml"), "utf8")) as {
    jobs: { "darwin-identity": { steps: { env?: Record<string, string> }[] } };
  };
  const step = workflow.jobs["darwin-identity"].steps.find(step => step.env?.PORTABLE_BUN_VERSION);
  expect(step).toBeDefined();
  const f = fixture();
  try {
    const result = await realExec("bash", ["scripts/gate-slot.sh", "bash", "-c", `echo started > "$CPU_QUEUE_OUTPUT"; exit ${exitCode}`], process.cwd(), {
      ...f.env, ...step!.env, LLV_GATE_RUNNER: "off", LLV_GATE_SLOTS: "1",
    }, { signal: AbortSignal.timeout(15_000) });
    expect(result.code, result.stderr).toBe(exitCode);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("started\n");
    expect(result.stderr).not.toContain("Waiting for measured CPU");
    expect(f.count()).toBe(0);
  } finally { f.close(); }
}, 30_000);

for (const hasFlock of [false, true]) test.skipIf(process.platform === "win32")(`a claim failure stops the gate before checks start (flock: ${hasFlock})`, async () => {
  const f = fixture(), bin = path.join(f.dir, "bin"), helper = path.join(f.dir, "helper");
  fs.mkdirSync(bin);
  for (const command of ["date", "mkdir", "dirname", "mktemp", "touch", "rm", "sleep"]) {
    fs.symlinkSync(execFileSync("which", [command], { encoding: "utf8" }).trim(), path.join(bin, command));
  }
  fs.writeFileSync(helper, `#!/bin/bash
case "$2" in
  --reuse-slot) exit 75 ;;
  --watch-wait) echo ready > "$3/ready"; while [[ ! -f "$3/done" ]]; do /bin/sleep 0.01; done; exit 0 ;;
  --lock-fd) exec "$CPU_SLOT_REAL_BUN" "$@" ;;
  --wait) exit 0 ;;
  --claim) echo 'gate-slot: CPU admission queue lock deadline exceeded; checks did not start' >&2; exit 1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  try {
    const result = await realExec("/bin/bash", ["scripts/gate-slot.sh", "/bin/bash", "-c", 'echo started > "$CPU_QUEUE_OUTPUT"'], process.cwd(), {
      ...f.env, LLV_GATE_BUN: helper, LLV_GATE_RUNNER: "off", LLV_CPU_WAIT_ROOTS: "[]", LLV_GATE_SLOTS: "1", CPU_SLOT_REAL_BUN: process.execPath,
      PATH: hasFlock ? process.env.PATH : bin,
    }, { timeoutMs: 5000 });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("lock deadline exceeded");
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
  } finally { f.close(); }
});

test.each([1, 6])("%i real slot locks stay exclusive while an independent stage starts", async slots => {
  const f = fixture(), controls: AbortController[] = [], pending: Promise<Awaited<ReturnType<typeof realExec>>>[] = [];
  const release = path.join(f.dir, "release");
  const env = { ...f.env, LLV_GATE_SLOTS: String(slots), CPU_SLOT_RELEASE: release };
  const lines = () => fs.existsSync(f.env.CPU_QUEUE_OUTPUT) ? fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8").trim().split("\n") : [];
  const stderr = path.join(f.dir, "last-stderr");
  const q = new CpuAdmissionQueue(path.join(f.dir, "admission.sqlite"));
  const script = 'echo start >> "$CPU_QUEUE_OUTPUT"; while [[ ! -f "$CPU_SLOT_RELEASE" ]]; do sleep 0.02; done; echo end >> "$CPU_QUEUE_OUTPUT"';
  try {
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    for (let index = 0; index <= slots; index++) {
      const control = new AbortController(); controls.push(control);
      const command = ["bash", "scripts/gate-slot.sh", "bash", "-c", script];
      pending.push(Promise.resolve(index === slots
        ? realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "slot-fixture", ...command], process.cwd(), { ...env, CPU_SLOT_STDERR: stderr }, { timeoutMs: 60_000, signal: control.signal })
        : realExec(command[0]!, command.slice(1), process.cwd(), env, { timeoutMs: 60_000, signal: control.signal })));
      if (index < slots) await until(() => lines().length === index + 1);
    }
    await until(() => fs.existsSync(stderr) && fs.readFileSync(stderr, "utf8").includes(`Waiting for a heavy command slot · all ${slots} busy · waited 0 min`));
    expect(lines()).toEqual(Array.from({ length: slots }, () => "start"));
    for (let slot = 1; slot <= slots; slot++) {
      const probe = Bun.spawnSync(["flock", "-n", path.join(f.dir, `llv-heavy-gate.slot${slot}.lock`), "true"]);
      expect(probe.exitCode).toBe(1);
    }
    // Poll only until the shared spacing permits the stage's real check.
    await until(() => q.check("stage:independent", true) === null);
    expect(lines()).toHaveLength(slots);
    expect(f.db.query("SELECT key FROM stage_admissions").all()).toEqual([{ key: "stage:independent" }]);
    fs.writeFileSync(release, "release");
    const results = await Promise.all(pending);
    expect(results.map(result => result.code), JSON.stringify(results)).toEqual(Array.from({ length: slots + 1 }, () => 0));
    let active = 0, maximum = 0;
    for (const line of lines()) { active += line === "start" ? 1 : -1; maximum = Math.max(maximum, active); expect(active).toBeLessThanOrEqual(slots); expect(active).toBeGreaterThanOrEqual(0); }
    expect(maximum).toBe(slots); expect(active).toBe(0); expect(lines()).toHaveLength(2 * (slots + 1));
  } finally {
    fs.writeFileSync(release, "release"); controls.forEach(control => control.abort());
    await Promise.allSettled(pending); q.close(); f.close();
  }
}, 90_000);

test("gate-slot lifts the pressure hold at ten minutes and preserves FIFO through slot acquisition", async () => {
  const f = fixture();
  const pending: Promise<unknown>[] = [];
  try {
    const one = realExec(f.command("one")[0]!, f.command("one").slice(1), process.cwd(), f.env, { timeoutMs: 1000 }); pending.push(Promise.resolve(one));
    await until(() => f.count() === 1);
    const two = realExec(f.command("two")[0]!, f.command("two").slice(1), process.cwd(), f.env, { timeoutMs: 1000 }); pending.push(Promise.resolve(two));
    await until(() => f.count() === 2);
    await Bun.sleep(1200); // longer than either caller's execution budget
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    f.age();
    const results = await Promise.all([one, two]);
    expect(results.map(r => r.code), JSON.stringify(results)).toEqual([0, 0]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("one\ntwo\n");
    expect(results[1]!.stderr).toContain("2nd");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n"); f.age(); await Promise.allSettled(pending); f.close(); }
}, 20_000);

for (const [holderHasFlock, entrantHasFlock] of [[false, false], [false, true], [true, false]]) {
  test.skipIf(process.platform !== "linux")(`wrappers share a lifetime cap under pressure (flock: ${holderHasFlock}/${entrantHasFlock})`, async () => {
    const f = fixture(), control = new AbortController();
    const pending: ReturnType<typeof realExec>[] = [];
    const release = path.join(f.dir, "release"), stderr = path.join(f.dir, "entrant-stderr"), holderStderr = path.join(f.dir, "holder-stderr");
    const bin = path.join(f.dir, "bin");
    fs.mkdirSync(bin);
    for (const command of ["bash", "mkdir", "dirname", "sleep", "touch", "rm", "realpath", "mktemp", "systemctl", "systemd-run", "getconf", "uname"]) {
      const executable = Bun.which(command);
      if (executable) fs.symlinkSync(executable, path.join(bin, command));
    }
    const env = (hasFlock: boolean, slots: string) => ({
      ...f.env, PATH: hasFlock ? process.env.PATH : bin, LLV_GATE_BUN: process.execPath, LLV_GATE_RUNNER: "off", LLV_GATE_SLOTS: slots,
      CPU_SLOT_RELEASE: release, CPU_SLOT_STDERR: stderr,
    });
    const output = () => fs.existsSync(f.env.CPU_QUEUE_OUTPUT) ? fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8") : "";
    const log = () => fs.existsSync(stderr) ? fs.readFileSync(stderr, "utf8") : "";
    const last = () => f.db.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last;
    const holderEnv = { ...env(holderHasFlock, "1"), CPU_SLOT_STDERR: holderStderr, CPU_SLOT_REAL_BUN: process.execPath };
    if (!holderHasFlock && !entrantHasFlock) {
      // Leave the compatibility row behind after the runner closes. The next
      // real gate must prove the cap lock is free and reclaim the exact row.
      const helper = path.join(bin, "skip-release");
      fs.writeFileSync(helper, '#!/bin/bash\nif [[ "$2" == --release-slot ]]; then exit 70; fi\nexec "$CPU_SLOT_REAL_BUN" "$@"\n', { mode: 0o755 });
      holderEnv.LLV_GATE_BUN = helper;
    }
    try {
      pending.push(realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "portable-gate", "bash", "scripts/gate-slot.sh", "bash", "-c",
        'echo holder >> "$CPU_QUEUE_OUTPUT"; while [[ ! -f "$CPU_SLOT_RELEASE" ]]; do sleep 0.02; done; echo released >> "$CPU_QUEUE_OUTPUT"; exit 23'],
      process.cwd(), holderEnv, { timeoutMs: 20_000, signal: control.signal }));
      await until(() => f.count() === 1);
      pending.push(realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "portable-gate", ...f.command("entrant")],
        process.cwd(), env(entrantHasFlock, "2"), { timeoutMs: 20_000, signal: control.signal }));
      await until(() => f.count() === 2);
      expect(output()).toBe("");
      f.age();
      await until(() => output().includes("holder\n")).catch(() => {
        throw new Error(`holder did not start: ${fs.readFileSync(holderStderr, "utf8")}`);
      });
      const admitted = last();
      await until(() => last() !== admitted || log().includes("Waiting for a heavy command slot · all 1 busy"));
      expect(last(), log()).toBe(admitted);
      expect(output()).toBe("holder\n");
      expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, "llv-heavy-gate.slot1.lock"), "true"]).exitCode).toBe(1);
      fs.writeFileSync(release, "release");
      const results = await Promise.all(pending);
      expect(results.map(result => result.code), log()).toEqual([23, 0]);
      expect(output()).toBe("holder\nreleased\nentrant\n");
      expect(f.count()).toBe(0);
      expect(f.db.query("SELECT key FROM gate_slots").all()).toEqual([]);
    } finally {
      fs.writeFileSync(release, "release");
      control.abort();
      await Promise.allSettled(pending);
      f.close();
    }
  }, 45_000);
}

test.skipIf(process.platform !== "linux")("an older pressure-only head yields to bounded gates in FIFO order under sustained pressure", async () => {
  const f = fixture(), control = new AbortController();
  const pending: ReturnType<typeof realExec>[] = [];
  const output = () => fs.existsSync(f.env.CPU_QUEUE_OUTPUT) ? fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8") : "";
  try {
    const legacy = legacyGateTree(f.dir);
    for (const [index, word] of ["legacy", "first", "second"].entries()) {
      pending.push(realExec("bash", f.command(word).slice(1), index === 0 ? legacy : process.cwd(),
        { ...f.env, LLV_GATE_SLOTS: "2" }, { signal: control.signal, timeoutMs: 15_000 }));
      await until(() => f.count() === index + 1);
    }
    const initial = f.db.query<{ key: string }, []>(`SELECT key ${queuedTickets} ORDER BY fifo_seq`).all();
    expect(output()).toBe("");
    f.age();
    await until(() => output().includes("second\n"), 15_000);
    const current = await Promise.all(pending.slice(1));
    expect(current.map(result => result.code), JSON.stringify(current)).toEqual([0, 0]);
    expect(output()).toBe("first\nsecond\n");
    expect(f.db.query(`SELECT key ${queuedTickets}`).all()).toEqual([initial[0]]);
    expect(fs.readFileSync(f.env.LLV_GATE_PSI_FILE, "utf8")).toContain("avg10=90.00");
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    await until(() => output().includes("legacy\n"), 15_000);
    expect((await pending[0]!).code).toBe(0);
    expect(output()).toBe("first\nsecond\nlegacy\n");
    expect(f.count()).toBe(0);
  } finally { control.abort(); await Promise.allSettled(pending); f.close(); }
}, 45_000);

for (const legacyHolds of [true, false]) test.skipIf(process.platform !== "linux")(`mixed wrappers wait for a cap-one holder (legacy holds: ${legacyHolds})`, async () => {
  const f = fixture(), control = new AbortController();
  const pending: ReturnType<typeof realExec>[] = [];
  const release = path.join(f.dir, "release"), stderr = path.join(f.dir, "entrant-stderr");
  const log = () => fs.existsSync(stderr) ? fs.readFileSync(stderr, "utf8") : "";
  const last = () => f.db.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last;
  try {
    const legacy = legacyGateTree(f.dir);
    if (legacyHolds) fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const launchEntrant = () => pending.push(realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "mixed-gate", ...f.command("entrant")],
      legacyHolds ? process.cwd() : legacy, { ...f.env, LLV_GATE_SLOTS: "2", CPU_SLOT_STDERR: stderr }, { timeoutMs: 15_000, signal: control.signal }));
    pending.push(realExec("bash", ["scripts/gate-slot.sh", "bash", "-c", 'echo holder >> "$CPU_QUEUE_OUTPUT"; while [[ ! -f "$CPU_SLOT_RELEASE" ]]; do sleep 0.02; done'],
      legacyHolds ? legacy : process.cwd(), { ...f.env, LLV_GATE_SLOTS: "1", CPU_SLOT_RELEASE: release }, { timeoutMs: 15_000, signal: control.signal }));
    // Queue the legacy entrant before the current holder records its fence.
    // It will be in the highest effective class when its pressure hold lifts.
    if (!legacyHolds) {
      await until(() => f.count() === 1);
      launchEntrant(); await until(() => f.count() === 2);
      f.age();
    }
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT));
    const holderAdmission = last();
    expect(holderAdmission).not.toBeNull();
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, `some avg10=${legacyHolds ? "90.00" : "0.00"} total=1\n`);
    if (legacyHolds) { launchEntrant(); await until(() => f.count() === 1); f.age(); }
    // Move past shared spacing so that the active protocol fence is the only
    // reason an otherwise-ready entrant cannot take the second slot.
    await until(() => last() !== holderAdmission ||
      (log().includes(legacyHolds ? "all 1 busy" : "2nd") && f.db.query<{ polled: number }, []>(`SELECT polled ${queuedTickets}`).get()!.polled > holderAdmission! + CPU_QUEUE_SPACING_MS + 250));
    expect(last(), log()).toBe(holderAdmission);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("holder\n");
    expect(f.count()).toBe(1);
    if (!legacyHolds) {
      // Give the real legacy subprocess a recorded owner from another PID
      // namespace. The current wrapper retains its actual kernel slot.
      const fence = f.db.query<{ key: string; owner: string }, []>("SELECT key, owner FROM tickets WHERE key GLOB 'command:gate-active:*'").get()!;
      const owner = JSON.parse(fence.owner);
      owner.bootEpoch = owner.bootEpoch.replace(/:pidns:pid:\[\d+\]$/, ":pidns:pid:[1]");
      expect(cpuOwnerStatus(owner)).toBe("unverified");
      const entrantPoll = () => f.db.query<{ polled: number }, []>(`SELECT polled ${queuedTickets}`).get()?.polled;
      try {
        for (const age of [61_000, 24 * 60 * 60_000 + 1_000]) {
          const changedAt = Date.now();
          f.db.query("UPDATE tickets SET owner = ?, polled = ? WHERE key = ?").run(JSON.stringify(owner), changedAt - age, fence.key);
          await until(() => last() !== holderAdmission || (entrantPoll() ?? 0) > changedAt + 250);
          expect(last(), log()).toBe(holderAdmission);
          expect(f.db.query("SELECT key FROM suspended WHERE key = ?").get(fence.key)).toBeNull();
          expect(f.db.query("SELECT key FROM tickets WHERE key = ?").get(fence.key)).toEqual({ key: fence.key });
          expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("holder\n");
        }
      } finally { f.db.query("UPDATE tickets SET owner = ?, polled = ? WHERE key = ?").run(fence.owner, Date.now(), fence.key); }
    }
    fs.writeFileSync(release, "release");
    await until(() => fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8").includes("entrant\n"), 15_000);
    const results = await Promise.all(pending);
    expect(results.map(result => result.code), log()).toEqual([0, 0]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("holder\nentrant\n");
    expect(f.count()).toBe(0);
    if (!legacyHolds) expect(f.db.query("SELECT key FROM gate_slots").all()).toEqual([]);
  } finally {
    fs.writeFileSync(release, "release"); control.abort(); await Promise.allSettled(pending); f.close();
  }
}, 45_000);

function pathWithoutFlock(directory: string) {
  const bin = path.join(directory, "portable-bin");
  fs.mkdirSync(bin);
  for (const command of ["bash", "date", "dirname", "getconf", "mkdir", "mktemp", "realpath", "rm", "sleep", "systemctl", "systemd-notify", "systemd-run", "touch", "uname", "which"]) {
    const executable = Bun.which(command);
    if (executable) fs.symlinkSync(executable, path.join(bin, command));
  }
  fs.symlinkSync(process.execPath, path.join(bin, "bun"));
  return bin;
}

for (const [kind, title] of [
  ["shell", "a portable legacy holder drains before a current cap-two entrant starts"],
  ["other", "a non-checkout publication lookalike still counts as a legacy holder"],
  ["scripts", "a legacy wrapper running preparation argv without a preparer parent still holds admission"],
  ["admitted", "a legacy wrapper running the admitted pre-push command still holds admission"],
] as const) test.skipIf(process.platform !== "linux")(title, async () => {
  const f = fixture(), control = new AbortController();
  const pending: ReturnType<typeof realExec>[] = [];
  const release = path.join(f.dir, "release"), holderPid = path.join(f.dir, "holder-pid"), stderr = path.join(f.dir, "entrant-stderr");
  const holderStderr = path.join(f.dir, "holder-stderr");
  const bin = pathWithoutFlock(f.dir);
  const env = { ...f.env, PATH: bin, LLV_GATE_BUN: process.execPath, LLV_GATE_RUNNER: "off", DELEGATUS_CPU_PRESSURE: "off",
    CPU_SLOT_RELEASE: release, CPU_SLOT_HOLDER_PID: holderPid };
  if (kind === "shell") {
    withoutInheritedGate(env);
    fs.rmSync(path.join(bin, "systemctl"), { force: true });
  }
  const output = () => fs.existsSync(f.env.CPU_QUEUE_OUTPUT) ? fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8") : "";
  const log = () => fs.existsSync(stderr) ? fs.readFileSync(stderr, "utf8") : "";
  const last = () => f.db.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last;
  try {
    const legacy = legacyGateTree(f.dir);
    const hold = 'echo holder >> "$CPU_QUEUE_OUTPUT"; while [[ ! -f "$CPU_SLOT_RELEASE" ]]; do sleep 0.02; done; echo released >> "$CPU_QUEUE_OUTPUT"';
    const directory = kind === "other" ? "other" : "scripts";
    const command = kind === "shell" ? ["bash", "-c", hold] : ["bun", `${directory}/local-gate.ts`, "pre-push",
      kind === "admitted" ? "--admitted" : "--publication-prepare"];
    if (kind !== "shell") {
      execFileSync("git", ["init", "--quiet", legacy], { env: fixtureGitEnv() });
      fs.mkdirSync(path.join(legacy, directory), { recursive: true });
      fs.writeFileSync(path.join(legacy, command[1]!), `const child = Bun.spawn(["bash", "-c", ${JSON.stringify(hold)}]); process.exit(await child.exited);`);
    }
    pending.push(realExec("/bin/bash", ["-c", 'printf "%s\n" "$$" > "$CPU_SLOT_HOLDER_PID"; exec /bin/bash "$@" 2>"$CPU_SLOT_STDERR"',
      "legacy-portable", "scripts/gate-slot.sh", ...command],
      legacy, { ...env, LLV_GATE_SLOTS: "1", CPU_SLOT_STDERR: holderStderr }, { timeoutMs: 25_000, signal: control.signal }));
    await until(() => output() === "holder\n", 10_000).catch(() => {
      throw new Error("legacy holder did not start: " + fs.readFileSync(holderStderr, "utf8"));
    });
    expect(f.count()).toBe(0);
    expect(fs.existsSync(path.join(f.dir, "llv-heavy-gate.slot1.lock"))).toBe(false);
    if (kind === "shell") {
      const pid = fs.readFileSync(holderPid, "utf8").trim();
      expect(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")).toContain("--portable");
    }
    const holderAdmission = last()!;
    expect(holderAdmission).not.toBeNull();
    pending.push(realExec("/bin/bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "mixed-portable", "bash", "scripts/gate-slot.sh", "bash", "-c",
      'read -r pid < "$CPU_SLOT_HOLDER_PID"; if [[ -r /proc/$pid/stat ]] && read -r stat < "/proc/$pid/stat"; then [[ ${stat##*) } == Z\\ * ]] || exit 23; fi; echo entrant >> "$CPU_QUEUE_OUTPUT"'],
      process.cwd(), { ...env, LLV_GATE_SLOTS: "2", CPU_SLOT_STDERR: stderr }, { timeoutMs: 25_000, signal: control.signal }));
    await until(() => last() !== holderAdmission || (
      log().includes("Waiting for legacy heavy commands to drain")
      && (f.db.query<{ polled: number }, []>(`SELECT polled ${queuedTickets}`).get()?.polled ?? 0) > holderAdmission + CPU_QUEUE_SPACING_MS + 250
    ), 10_000);
    expect(last(), log()).toBe(holderAdmission);
    expect(output()).toBe("holder\n");
    fs.writeFileSync(release, "release");
    await until(() => output().includes("entrant\n"), 12_000).catch(() => {
      throw new Error("entrant did not start after release: " + log() + "\nlegacy holder: " + fs.readFileSync(holderStderr, "utf8"));
    });
    const results = await Promise.all(pending);
    expect(results.map(result => result.code), JSON.stringify(results)).toEqual([0, 0]);
    expect(output()).toBe("holder\nreleased\nentrant\n");
    expect(f.count()).toBe(0);
  } finally {
    fs.writeFileSync(release, "release");
    control.abort();
    await Promise.allSettled(pending);
    f.close();
  }
}, 40_000);

const systemctl = process.platform === "linux" ? Bun.which("systemctl") : null;
const hasUserManager = systemctl !== null && Bun.spawnSync([systemctl, "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test.skipIf(!hasUserManager)("a pre-commit service and its client cannot fence their own queued ESLint", async () => {
  const f = fixture(), roots: string[] = [], control = new AbortController();
  const log = path.join(f.dir, "pre-commit.stderr");
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    const hook = createHookFixture(process.cwd(), roots);
    const hookEnv: NodeJS.ProcessEnv = hook.env;
    fs.mkdirSync(path.join(hook.dir, "scripts/gate-runner"));
    for (let i = 0; i < 41; i++) fs.writeFileSync(path.join(hook.dir, `input-${i}.ts`), "export {};\n");
    hook.git("add", ".");
    const env = { ...hookEnv, ...f.env, PATH: hookEnv.PATH, LLV_GATE_RUNNER: "off", LLV_GATE_SLOTS: "6",
      LLV_GATE_SANDBOX_RECORD: undefined, CPU_SLOT_STDERR: log, FIXTURE_HOOK_PID: path.join(f.dir, "hook.pid") };
    withoutInheritedGate(env);
    const previous = Date.now() - CPU_QUEUE_SPACING_MS;
    f.db.query("UPDATE admission SET last = ?").run(previous);
    pending = realExec("bash", ["-c", 'echo $$ > "$FIXTURE_HOOK_PID"; exec "$@" 2>"$CPU_SLOT_STDERR"', "pre-commit-fixture", "bun", "scripts/local-gate.ts", "pre-commit"],
      hook.dir, env, { timeoutMs: 18_000, signal: control.signal });
    const diagnostics = () => new Error(redactBounded(fs.readFileSync(log, "utf8"), 2_000));
    await until(() => f.count() === 1, 8_000, diagnostics);
    const ticket = f.db.query<{ key: string; owner: string }, []>(`SELECT key, owner ${queuedTickets}`).get()!;
    const waiter = JSON.parse(ticket.owner).pid;
    const group = fs.readFileSync(`/proc/${waiter}/cgroup`, "utf8");
    const unit = /\/(delegatus-gate-[\da-f-]+\.service)(?:\/|\n)/.exec(group)?.[1];
    expect(unit).toBeDefined();
    const service = execFileSync(systemctl!, ["--user", "show", "-p", "MainPID", "--value", unit!], { encoding: "utf8" }).trim();
    const argv = fs.readFileSync(`/proc/${service}/cmdline`, "utf8").split("\0");
    expect(argv[2]).toBe("--service");
    expect(fs.existsSync(argv[3]!)).toBe(false);
    const children = (pid: string) => fs.readdirSync(`/proc/${pid}/task`).flatMap(thread =>
      fs.readFileSync(`/proc/${pid}/task/${thread}/children`, "utf8").trim().split(/\s+/).filter(Boolean));
    const original = fs.readFileSync(env.FIXTURE_HOOK_PID, "utf8").trim();
    const clients = children(original).filter(pid => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("owned-runner.ts"));
    expect(clients).toHaveLength(1);
    expect(children(clients[0]!).map(pid => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"))
      .some(command => command.includes("systemd-run\0") && command.includes(`--unit=${unit}\0`) && command.includes(argv[3]!))).toBe(true);
    expect(fs.readFileSync(`/proc/${waiter}/cmdline`, "utf8")).toContain("scripts/eslint-changes.ts");
    expect(f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'gate_slots'").get()).toBeNull();
    expect(f.db.query("SELECT last FROM admission").get()).toEqual({ last: previous });
    for (let i = 1; i <= 6; i++) {
      expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, `llv-heavy-gate.slot${i}.lock`), "true"]).exitCode).toBe(0);
    }
    f.age();
    await until(() => fs.existsSync(hookEnv.HOOK_LOG!), 5_000, diagnostics);
    const result = await pending;
    expect(result.code, redactBounded(result.stderr, 2_000)).toBe(0);
    expect(hook.calls().filter(call => call.args[0] === "scripts/eslint-changes.ts")).toHaveLength(1);
    expect(f.count()).toBe(0);
  } finally {
    control.abort();
    await pending;
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    f.close();
  }
}, 22_000);

for (const portable of [false, true]) test.skipIf(process.platform !== "linux" || !portable && !hasUserManager)(
  `a pre-exemption ${portable ? "portable runner" : "service"} holds its cap-one grant until the ordinary hook exits`, async () => {
  const f = fixture(), control = new AbortController(), pending: ReturnType<typeof realExec>[] = [];
  const release = path.join(f.dir, "release"), entered = path.join(f.dir, "entered");
  const finish = path.join(f.dir, "finish");
  const env = { ...f.env, LLV_GATE_SLOTS: "1", DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_RUNNER: "off",
    LLV_GATE_PUSH_DEADLINE: undefined, LLV_GATE_BUN: process.execPath };
  const last = () => f.db.query<{ last: number }, []>("SELECT last FROM admission").get()!.last;
  try {
    const legacy = legacyGateTree(f.dir, portable ? "3e570adfba80059eaba26a978402a2e73a02978e" : "bf1c00247d496184b51c598a92e7cf4501185ae5");
    if (portable) withoutInheritedGate(env);
    execFileSync("git", ["init", "--quiet", legacy], { env: fixtureGitEnv() });
    const bin = pathWithoutFlock(f.dir);
    if (portable) fs.rmSync(path.join(bin, "systemctl"), { force: true });
    // Hold the real legacy hook in its fetch after it has consumed its ticket.
    // The empty repository then ends the hook at merge-base.
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash
if [[ $1 != fetch ]]; then command -p git "$@"; exit $?; fi
echo "$PPID" > "$FIXTURE_ENTERED"
while [[ ! -f "$FIXTURE_RELEASE" ]]; do sleep 0.02; done
`, { mode: 0o755 });
    const holderRun = realExec("bash", ["scripts/gate-slot.sh", "bun", "scripts/local-gate.ts", "pre-push"], legacy,
      { ...env, PATH: bin, FIXTURE_ENTERED: entered, FIXTURE_RELEASE: release },
      { timeoutMs: 25_000, signal: control.signal });
    pending.push(holderRun);
    await Promise.race([until(() => fs.existsSync(entered), 10_000), Promise.resolve(holderRun).then(result => {
      throw new Error(`historical hook exited before fetch (${result.code}): ${redactBounded(result.stderr, 2000)}`);
    })]);
    const hook = fs.readFileSync(entered, "utf8").trim();
    const parent = fs.readFileSync(`/proc/${hook}/stat`, "utf8").split(") ").at(-1)!.split(" ")[1];
    const service = fs.readFileSync(`/proc/${parent}/cmdline`, "utf8").split("\0");
    expect(service[2]).toBe(portable ? "--portable" : "--service");
    if (!portable) expect(fs.existsSync(service[3]!)).toBe(false);
    expect(f.count()).toBe(0);
    const held = last();
    expect(held).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(f.dir, "llv-heavy-gate.slot1.lock"))).toBe(false);

    // Count every subsequent grant, including one that exits between polls.
    f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
    pending.push(realExec("bash", ["scripts/gate-slot.sh", "bash", "-c",
      'if read -r stat < "/proc/$FIXTURE_HOOK/stat" 2>/dev/null; then [[ ${stat##*) } == Z\\ * ]] || exit 23; fi; echo entrant >> "$CPU_QUEUE_OUTPUT"; while [[ ! -f "$FIXTURE_FINISH" ]]; do sleep 0.02; done'],
      process.cwd(), { ...env, FIXTURE_HOOK: hook, FIXTURE_FINISH: finish }, { timeoutMs: 25_000, signal: control.signal }));
    const polled = () => f.db.query<{ polled: number }, []>(`SELECT polled ${queuedTickets}`).get()?.polled ?? 0;
    await until(() => last() !== held || polled() > held + CPU_QUEUE_SPACING_MS + 1000, 10_000);
    expect(f.db.query("SELECT * FROM grants").all()).toEqual([]);
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    fs.writeFileSync(release, "release");
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT), 10_000);
    expect(f.db.query("SELECT slot, cap FROM gate_slots").all()).toEqual([{ slot: 1, cap: 1 }]);
    fs.writeFileSync(finish, "finish");
    const [holder, entrant] = await Promise.all(pending);
    expect(holder!.code).toBe(1);
    expect(holder!.stderr).toContain("git merge-base failed");
    expect(entrant!.code, entrant!.stderr).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("entrant\n");
    expect(f.db.query("SELECT at FROM grants").all()).toEqual([{ at: last() }]);
    expect(f.count()).toBe(0);
  } finally {
    fs.writeFileSync(release, "release"); fs.writeFileSync(finish, "finish"); control.abort();
    await Promise.allSettled(pending);
    f.close();
  }
}, 45_000);

for (const upgraded of [false, true]) test.skipIf(!hasUserManager)(
  `a native hook that consumed admission keeps it after queuing its nested gate (upgrade during fetch: ${upgraded})`, async () => {
  const f = fixture(), roots: string[] = [], holder = new AbortController(), entrant = new AbortController();
  const pending: ReturnType<typeof realExec>[] = [];
  const entered = path.join(f.dir, "fetch"), resume = path.join(f.dir, "resume");
  const grants = () => f.db.query("SELECT at FROM grants ORDER BY rowid").all();
  try {
    const legacy = legacyGateTree(f.dir, "c0ceb7ff5eb064b1d9d29a9aef2540edd15d5dd1");
    const publication = createPublicationFixtures(legacy, roots).fixture();
    fs.mkdirSync(path.join(publication.dir, "scripts/gate-runner"));
    const bin = pathWithoutFlock(f.dir);
    for (const name of ["sh", "cat", "cut", "id", "ps", "awk", "sed", "chmod", "python3", "basename", "nproc", "env", "readlink"]) {
      const executable = Bun.which(name);
      if (executable) fs.symlinkSync(executable, path.join(bin, name));
    }
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash
if [[ $1 == fetch ]]; then
  echo "$PPID" > "$FIXTURE_FETCH"
  while [[ ! -f "$FIXTURE_RESUME" ]]; do sleep 0.02; done
fi
command -p git "$@"
`, { mode: 0o755 });
    const env = { ...publication.env, ...f.env, PATH: path.join(publication.dir, "shims") + path.delimiter + bin,
      LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off", LLV_GATE_PUSH_DEADLINE: undefined, LLV_GATE_PUBLICATION_RECEIPT: undefined,
      LLV_GATE_BUN: process.execPath, FIXTURE_FETCH: entered, FIXTURE_RESUME: resume, GIT_DIR: ".git", DELEGATUS_CPU_PRESSURE: "off" };
    withoutInheritedGate(env);
    f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
    if (upgraded) f.db.exec("DROP TRIGGER IF EXISTS legacy_gate_retired; DROP TABLE IF EXISTS legacy_gate_cutover; DROP TABLE IF EXISTS legacy_gate_retirements");
    pending.push(realExec("bash", ["scripts/gate-slot.sh", ".githooks/pre-push"], publication.dir, env, { timeoutMs: 30_000, signal: holder.signal }));
    await until(() => fs.existsSync(entered), 10_000);
    const hook = fs.readFileSync(entered, "utf8").trim();
    const supervisor = fs.readFileSync(`/proc/${hook}/stat`, "utf8").split(") ").at(-1)!.split(" ")[1];
    const args = fs.readFileSync(`/proc/${supervisor}/cmdline`, "utf8").split("\0");
    expect(args[2]).toBe("--service");
    expect(fs.existsSync(args[3]!)).toBe(false);
    expect(fs.existsSync(path.join(f.dir, "llv-heavy-gate.slot1.lock"))).toBe(false);
    expect(grants()).toHaveLength(1);
    expect(f.count()).toBe(0);
    const entrantEnv = { ...f.env, LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off" };
    withoutInheritedGate(entrantEnv);
    pending.push(realExec("bash", f.command("entrant").slice(1), process.cwd(), entrantEnv, { timeoutMs: 30_000, signal: entrant.signal }));
    await until(() => f.count() === 1);
    const head = f.db.query<{ owner: string }, []>(`SELECT owner ${queuedTickets}`).get()!.owner;
    fs.writeFileSync(resume, "continue");
    await until(() => f.count() === 2);
    const nested = f.db.query<{ owner: string }, [string]>(`SELECT owner ${queuedTickets} AND owner != ?`).get(head)!;
    expect(fs.readFileSync(`/proc/${JSON.parse(nested.owner).pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[1]).toBe(hook);
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const held = f.db.query<{ last: number }, []>("SELECT last FROM admission").get()!.last;
    const polls = new Set<number>();
    await until(() => {
      const polled = f.db.query<{ polled: number }, [string]>("SELECT polled FROM tickets WHERE owner = ?").get(head)?.polled;
      if (polled && polled > held + CPU_QUEUE_SPACING_MS) polls.add(polled);
      return polls.size >= 6 || grants().length !== 1;
    }, 10_000);
    expect(grants()).toEqual([{ at: held }]);
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    holder.abort();
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT), 10_000);
    expect((await pending[1]!).code).toBe(0);
    expect(grants()).toHaveLength(2);
  } finally {
    fs.writeFileSync(resume, "continue"); holder.abort(); entrant.abort();
    await Promise.allSettled(pending);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    f.close();
  }
}, 50_000);

for (const mode of ["portable hooks first-open", "service hooks first-open", "portable prepare", "portable hooks", "service prepare", "service hooks", "historical service hook", "older helper head"] as const) test.skipIf(
  process.platform !== "linux" || !mode.startsWith("portable") && !hasUserManager
)(`FIFO publication admits the first check while the peer waits (${mode})`, async () => {
    const useService = !mode.startsWith("portable");
    const historical = mode === "historical service hook", olderHead = mode === "older helper head";
    const ordinary = mode.includes("hooks") || historical || olderHead;
    const firstOpen = mode.endsWith("first-open");
    const f = fixture(), control = new AbortController(), roots: string[] = [];
    const pending: ReturnType<typeof realExec>[] = [];
    const { fixture: publicationFixture, commitFixtureInputs } = createPublicationFixtures(process.cwd(), roots);
    const release = path.join(f.dir, "release"), started = path.join(f.dir, "started");
    const last = () => f.db.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last;
    const log = (name: string) => path.join(f.dir, `${name}.stderr`);
    const stderr = (name: string) => fs.existsSync(log(name)) ? fs.readFileSync(log(name), "utf8") : "";
    const launch = (publication: ReturnType<typeof publicationFixture>, name: string) => {
      // realExec merges process.env back in. Explicitly mask the enclosing
      // publication deadline so this private publication gets its own budget.
      const env: NodeJS.ProcessEnv = { ...publication.env, LLV_GATE_LOCK_DIR: f.dir, LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off",
        LLV_GATE_PSI_FILE: f.env.LLV_GATE_PSI_FILE, LLV_GATE_POLL_SECONDS: f.env.LLV_GATE_POLL_SECONDS,
        LLV_GATE_PSI_RELEASE_SECONDS: "0", DELEGATUS_CPU_PRESSURE: "on", DELEGATUS_AGENT_CPU: "off", CPU_SLOT_STDERR: log(name),
        LLV_GATE_PUBLICATION_ID: name, LLV_OWNED_RUN_TIMEOUT_MS: "25000", LLV_GATE_SANDBOX_RECORD: undefined, LLV_GATE_PUSH_DEADLINE: undefined };
      if (olderHead) {
        // Route through the same host-only PATH binding supplied by the
        // launcher. The fixture's Bun shim still stands in for the check.
        const bun = path.join(publication.dir, "shims", "bun");
        fs.writeFileSync(bun, fs.readFileSync(bun, "utf8").replace("#!/bin/bash\n", `#!/bin/bash
case "$1" in */cpu-admission.ts|*/owned-runner.ts) exec "$HOOK_BUN" "$@" ;; esac
`));
        env.LLV_GATE_BUN = undefined;
        Object.assign(env, installedGateAdmissionEnv(env));
      }
      withoutInheritedGate(env, { keepSandbox: useService });
      let command = ["bun", "scripts/local-gate.ts", "pre-push", "--publication-prepare"];
      if (ordinary) {
        env.LLV_GATE_PUBLICATION_RECEIPT = undefined;
        command = ["bun", "scripts/local-gate.ts", "pre-push"];
        if (name === "peer" && historical) {
          command = ["bash", "scripts/gate-slot.sh", ".githooks/pre-push"];
        } else if (name === "peer" && !useService) {
          command = ["bash", "scripts/gate-slot.sh", ".githooks/pre-push"];
        } else if (name === "peer") {
          // Enter the service exactly as gate-slot's placed native hook does.
          // Supply its quota readback privately, without configuring a host slice.
          const group = "/fixture.slice/gate.service";
          fs.mkdirSync(path.join(f.dir, group), { recursive: true });
          for (const node of [group, path.dirname(group)]) fs.writeFileSync(path.join(f.dir, node, "cpu.max"), "100000 100000");
          const membership = path.join(f.dir, "placement");
          fs.writeFileSync(membership, `0::${group}\n`);
          Object.assign(env, { LLV_GATE_CGROUP_FILE: membership, LLV_GATE_CGROUP_ROOT: f.dir, LLV_GATE_SLICE: "fixture.slice" });
          command = [process.execPath, "scripts/owned-runner.ts", "/bin/bash", "scripts/gate-slot.sh", "--in-cpu-scope", ".githooks/pre-push"];
        }
      }
      let outcome: Awaited<ReturnType<typeof realExec>> | undefined;
      // Reproduce an exhausted comparator's enclosing deadline on every run.
      // realExec snapshots the environment synchronously when spawning.
      const enclosingDeadline = process.env.LLV_GATE_PUSH_DEADLINE;
      process.env.LLV_GATE_PUSH_DEADLINE = "1";
      try {
        pending.push(Promise.resolve(realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "publication-fixture", ...command], publication.dir, env, { timeoutMs: 30_000, signal: control.signal }))
          .then(result => { outcome = result; return result; }));
      } finally {
        if (enclosingDeadline === undefined) delete process.env.LLV_GATE_PUSH_DEADLINE;
        else process.env.LLV_GATE_PUSH_DEADLINE = enclosingDeadline;
      }
      const waitFor = (barrier: string, reached: () => boolean) => {
        const failure = () => {
          const status = outcome ? `exited (code=${outcome.code}, signal=${outcome.signal ?? "none"})` : "still running";
          return new Error(`${name} ${status} at ${barrier}\n${redactBounded([stderr(name), outcome?.stderr].filter(Boolean).join("\n"), 2_000)}`);
        };
        return until(() => {
          if (outcome) throw failure();
          return reached();
        }, 10_000, failure);
      };
      return { env, waitFor };
    };
    try {
      const first = publicationFixture();
      const peer = historical
        ? createPublicationFixtures(legacyGateTree(f.dir, "c0ceb7ff5eb064b1d9d29a9aef2540edd15d5dd1"), roots).fixture()
        : publicationFixture();
      if (olderHead) {
        // The exact older admission implementation observed at the FIFO head.
        const historicalTree = legacyGateTree(f.dir, "36b68a986862c5391cadf0c8c162aeea73012447");
        for (const entry of ["cpu-admission.ts", "gate-slot.sh"]) {
          const target = path.join(first.dir, "scripts", entry);
          fs.unlinkSync(target);
          fs.symlinkSync(path.join(historicalTree, "scripts", entry), target);
        }
      }
      for (const publication of [first, peer]) {
        if (!useService) fs.writeFileSync(path.join(publication.dir, "shims/systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        fs.mkdirSync(path.join(publication.dir, "scripts/gate-runner"));
      }
      fs.appendFileSync(path.join(first.dir, "record.ts"), `\nif (process.argv[2] === "tsc") {
        const fs = require("node:fs");
        fs.writeFileSync(${JSON.stringify(started)}, "started");
        while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
      }\n`);
      commitFixtureInputs(first);
      if (!useService) commitFixtureInputs(peer);
      // The first-open supervisor must have a clear post-grant birth time;
      // leave more than the procfs clock's conservative uncertainty window.
      const previous = Date.now() - (firstOpen ? 5_000 : CPU_QUEUE_SPACING_MS);
      f.db.query("UPDATE admission SET last = ?").run(previous);
      f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
      if (firstOpen) {
        // Keep the old queue's prior-grant boundary while removing the new
        // observer metadata. The first nested gate installs it with both
        // ordinary hook supervisors already alive.
        f.db.exec("DROP TRIGGER IF EXISTS legacy_gate_retired; DROP TABLE IF EXISTS legacy_gate_cutover; DROP TABLE IF EXISTS legacy_gate_retirements");
      }
      const grants = () => f.db.query("SELECT at FROM grants ORDER BY rowid").all();
      const firstRun = launch(first, "first");
      await firstRun.waitFor("its first private ticket", () => f.count() === 1);
      const firstTicket = f.db.query<{ owner: string }, []>(`SELECT owner ${queuedTickets}`).get()!;
      const peerRun = launch(peer, "peer");
      await peerRun.waitFor("the second private ticket", () => f.count() === 2);
      expect(last()).toBe(previous);
      fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
      await firstRun.waitFor("the admitted check starting", () => fs.existsSync(started));
      const admitted = last()!;
      expect(admitted).toBeGreaterThan(previous);
      expect(grants()).toEqual([{ at: admitted }]);
      expect(f.count()).toBe(1);
      expect(f.db.query(`SELECT owner ${queuedTickets}`).get()).not.toEqual(firstTicket);
      expect(f.db.query("SELECT slot, cap, owner FROM gate_slots JOIN tickets USING (key)").all()).toEqual([{ slot: 1, cap: 1, ...firstTicket }]);
      expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, "llv-heavy-gate.slot1.lock"), "true"]).exitCode).toBe(1);
      expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, "llv-heavy-gate.slot1.cap1.lock"), "true"]).exitCode).toBe(1);
      expect(fs.existsSync(peer.receipt)).toBe(false);
      fs.writeFileSync(release, "release");
      const results = await Promise.all(pending);
      expect(results.map(result => result.code), redactBounded(stderr("first") + stderr("peer"), 4_000)).toEqual([0, 0]);
      if (useService) expect(stderr("first")).toMatch(/gate-slot: delegatus-gate-[\da-f-]+\.service:/);
      else expect(stderr("first")).toContain("using the documented portable cleanup fallback");
      expect(last()).toBeGreaterThan(admitted);
      expect(grants()).toEqual([{ at: admitted }, { at: last() }]);
      for (const [publication, { env }] of [[first, firstRun], [peer, peerRun]] as const) {
        if (ordinary) expect(publication.calls().filter(call => call.args[0] === "tsc")).toHaveLength(1);
        else expect(readPublicationCheckReceipt(publication.receipt, publicationCheckBinding(env)).completedAt).toBeGreaterThanOrEqual(admitted);
      }
      expect(f.count()).toBe(0);
    } finally {
      fs.writeFileSync(release, "release"); control.abort();
      await Promise.allSettled(pending);
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
      f.close();
    }
  }, 60_000);

test.skipIf(process.platform !== "linux")("an aged gate respects the strictest active cap under sustained pressure", async () => {
  const f = fixture(), control = new AbortController();
  const pending: ReturnType<typeof realExec>[] = [];
  const release = path.join(f.dir, "release"), stderr = path.join(f.dir, "stderr");
  const bin = path.join(f.dir, "bin"), bun = path.join(bin, "gate-bun");
  const stale = path.join(f.dir, "stale-readiness"), refused = path.join(f.dir, "claim-refused");
  fs.mkdirSync(bin);
  // Model a readiness observation that missed the strict cap. Only the wait
  // helper's probe lies. The shell and the fresh claim helper use real locks.
  fs.writeFileSync(path.join(bin, "flock"), `#!/bin/bash
if [[ \${CPU_SLOT_WAIT_PROBE:-} == yes && -f "$CPU_SLOT_STALE" && "$2" == *.slot1.lock ]]; then exit 0; fi
exec "$CPU_SLOT_REAL_FLOCK" "$@"
`, { mode: 0o755 });
  fs.writeFileSync(bun, `#!/bin/bash
if [[ "$2" == --wait ]]; then export CPU_SLOT_WAIT_PROBE=yes; fi
"$CPU_SLOT_REAL_BUN" "$@"
code=$?
if [[ "$2" == --claim && $code == 75 && -f "$CPU_SLOT_STALE" ]]; then
  rm -- "$CPU_SLOT_STALE"
  : > "$CPU_SLOT_REFUSED"
fi
exit "$code"
`, { mode: 0o755 });
  const log = () => fs.existsSync(stderr) ? fs.readFileSync(stderr, "utf8") : "";
  const last = () => f.db.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last;
  try {
    pending.push(realExec("bash", ["scripts/gate-slot.sh", "bash", "-c", 'echo one >> "$CPU_QUEUE_OUTPUT"; while [[ ! -f "$CPU_SLOT_RELEASE" ]]; do sleep 0.02; done'],
      process.cwd(), { ...f.env, LLV_GATE_SLOTS: "1", CPU_SLOT_RELEASE: release }, { timeoutMs: 20_000, signal: control.signal }));
    await until(() => f.count() === 1);
    f.age();
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT));
    const firstAdmission = last();
    expect(firstAdmission).not.toBeNull();
    pending.push(realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "slot-fixture", ...f.command("two")],
      process.cwd(), {
        ...f.env, LLV_GATE_SLOTS: "2", CPU_SLOT_STDERR: stderr, LLV_GATE_BUN: bun,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, CPU_SLOT_REAL_BUN: process.execPath,
        CPU_SLOT_REAL_FLOCK: Bun.which("flock")!, CPU_SLOT_STALE: stale, CPU_SLOT_REFUSED: refused,
      }, { timeoutMs: 20_000, signal: control.signal }));
    await until(() => f.count() === 1);
    f.age();
    // Wait for the post-spacing decision, whichever result the gate reaches.
    await until(() => log().includes("Waiting for a heavy command slot · all 1 busy") || last() !== firstAdmission);
    expect(last()).toBe(firstAdmission);
    fs.writeFileSync(stale, "");
    await until(() => fs.existsSync(refused) || last() !== firstAdmission);
    expect(last()).toBe(firstAdmission);
    expect(fs.existsSync(refused)).toBe(true);
    await until(() => Bun.spawnSync(["flock", "-n", path.join(f.dir, "llv-heavy-gate.slot2.lock"), "/bin/true"]).exitCode === 0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("one\n");
    expect(f.count()).toBe(1);
    fs.writeFileSync(release, "release");
    const results = await Promise.all(pending);
    expect(results.map(result => result.code), log()).toEqual([0, 0]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("one\ntwo\n");
    expect(last()! - firstAdmission!).toBeGreaterThanOrEqual(CPU_QUEUE_SPACING_MS);
    expect(f.count()).toBe(0);
  } finally {
    fs.writeFileSync(release, "release");
    control.abort();
    await Promise.allSettled(pending);
    f.close();
  }
}, 30_000);

test("a restarted claim helper refuses high pressure before the queue bound and accepts it after", async () => {
  const f = fixture();
  const claim = async () => {
    const child = Bun.spawn([process.execPath, "scripts/cpu-admission.ts", "--claim", "command:claim-restart", String(process.pid)], { env: f.env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stderr).text();
    return { code: await child.exited, output };
  };
  try {
    const refused = await claim();
    expect(refused.code).toBe(75);
    expect(refused.output).toContain("Waiting for measured CPU pressure");
    expect(f.count()).toBe(1);
    f.age();
    expect(await claim()).toEqual({ code: 0, output: "" });
    expect(f.count()).toBe(0);
  } finally { f.close(); }
});

test("a lost slot claim keeps the shell retry pause outside the caller's execution budget", async () => {
  const f = fixture(), controller = new AbortController();
  const bin = path.join(f.dir, "bin"), ready = path.join(f.dir, "claim-ready"), lost = path.join(f.dir, "claim-lost");
  fs.mkdirSync(bin);
  // Readiness observes a free slot; the shell loses its first lock race.
  fs.writeFileSync(path.join(bin, "flock"), '#!/bin/bash\nif [[ "$#" -eq 2 && "$1" == -n && "$2" == 9 && ! -f "$CPU_CLAIM_READY" ]]; then echo lost > "$CPU_CLAIM_LOST"; exit 1; fi\nexit 0\n', { mode: 0o755 });
  const guard = setTimeout(() => controller.abort(), 20_000);
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    pending = realExec("bash", f.command("claimed").slice(1), process.cwd(), {
      ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, CPU_CLAIM_READY: ready, CPU_CLAIM_LOST: lost,
      DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_SLOTS: "1", LLV_GATE_POLL_SECONDS: "4",
    }, { timeoutMs: 3000, signal: controller.signal });
    await until(() => fs.existsSync(lost), 15_000);
    await Bun.sleep(3300);
    fs.writeFileSync(ready, "ready");
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("claimed\n");
  } finally { clearTimeout(guard); controller.abort(); await Promise.resolve(pending).catch(() => {}); f.close(); }
}, 60_000);

test("a shell's native owner mapping binds the queue ticket to the kernel PID", async () => {
  const f = fixture();
  // This emulates MSYS native PIDs in the test's namespace. A host service
  // cannot use those PIDs: exercise the portable runner with a private stub.
  const bin = path.join(f.dir, "portable-bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    // MSYS exposes /proc/<shell PID>/winpid. Emulate that file with a distinct
    // live kernel owner; the helper must not record the shell's POSIX PID.
    pending = realExec("bash", ["-c", 'mkdir -p "$LLV_GATE_PROC_ROOT/$$"; printf "%s" "$CPU_NATIVE_OWNER" > "$LLV_GATE_PROC_ROOT/$$/winpid"; exec bash scripts/gate-slot.sh true'], process.cwd(), withoutInheritedGate({
      ...f.env, LLV_GATE_PROC_ROOT: path.join(f.dir, "proc"), CPU_NATIVE_OWNER: String(process.pid), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    }), { timeoutMs: 6000 });
    await until(() => f.count() === 1);
    const row = f.db.query<{ owner: string }, []>("SELECT owner FROM tickets").get()!;
    expect(JSON.parse(row.owner).pid).toBe(process.pid);
    f.age();
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n"); f.age(); await Promise.resolve(pending).catch(() => {}); f.close(); }
}, 20_000);

/* Queue heads as the incident left them: queued six hours ago and never
   checked since, by an owner the helpers prove dead, one recorded in a PID
   namespace they cannot read, or this live test process. */
function seedHead(f: ReturnType<typeof fixture>, key: string, owner: object) {
  f.db.query("INSERT INTO tickets (key, since, owner) VALUES (?, ?, ?)").run(key, Date.now() - 6 * 3_600_000, JSON.stringify(owner));
}
const interleaved = (word: string) => ["bash", "scripts/gate-slot.sh", "bash", "-c", `echo start-${word} >> "$CPU_QUEUE_OUTPUT"; sleep 0.3; echo end-${word} >> "$CPU_QUEUE_OUTPUT"`];

test("dead and unverifiable owners at the head stop blocking real gates, each with one reason line, one slot holder at a time", async () => {
  const f = fixture(), live = cpuOwnerIdentity(process.pid);
  const pending: ReturnType<typeof realExec>[] = [];
  try {
    seedHead(f, "command:dead-head", { ...live, startIdentity: `${live.pid}:1` });
    seedHead(f, "command:foreign-head", { pid: 4242, startIdentity: "4242:1", bootEpoch: live.bootEpoch!.replace(/pid:\[\d+\]$/, "pid:[1]") });
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const env = { ...f.env, LLV_GATE_SLOTS: "1" };
    for (const word of ["one", "two"]) pending.push(realExec("bash", interleaved(word).slice(1), process.cwd(), env, { timeoutMs: 15_000 }));
    const results = await Promise.all(pending);
    expect(results.map(r => r.code), JSON.stringify(results)).toEqual([0, 0]);
    const lines = fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8").trim().split("\n");
    expect([[lines[0], lines[1]], [lines[2], lines[3]]].map(pair => pair.map(line => line!.replace(/^(start|end)-/, "")))).toEqual(lines[0] === "start-one" ? [["one", "one"], ["two", "two"]] : [["two", "two"], ["one", "one"]]);
    const stderr = results.map(r => r.stderr).join("\n");
    expect(stderr.match(/removed command:dead-head: its owner process \d+ has exited/g)).toHaveLength(1);
    expect(stderr.match(/passed over command:foreign-head: its owner process 4242 cannot be verified from here and has not checked in for \d+ s/g)).toHaveLength(1);
    expect(f.db.query(`SELECT key ${queuedTickets}`).all()).toEqual([{ key: "command:foreign-head" }]);
  } finally { await Promise.allSettled(pending); f.close(); }
}, 30_000);

for (const lockedSlot of [1, 2]) test.skipIf(process.platform !== "linux")(`an aged gate under sustained pressure still waits for a locked slot (slot ${lockedSlot}, cap 1)`, async () => {
  const f = fixture(), control = new AbortController();
  const stderr = path.join(f.dir, "stderr");
  const env = { ...f.env, LLV_GATE_SLOTS: "1", CPU_SLOT_STDERR: stderr };
  const lock = path.join(f.dir, `llv-heavy-gate.slot${lockedSlot}.lock`);
  const holder = Bun.spawn(["flock", lock, "bash", "-c", 'printf "ready\n"; read -r line'], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit", env,
  });
  const reader = holder.stdout.getReader();
  let pending: ReturnType<typeof realExec> | undefined;
  const log = () => fs.existsSync(stderr) ? fs.readFileSync(stderr, "utf8") : "";
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    pending = realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "slot-fixture", ...f.command("aged")],
      process.cwd(), env, { timeoutMs: 20_000, signal: control.signal });
    await until(() => log().includes("Waiting for measured CPU pressure"));
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    f.age();
    try {
      await until(() => log().includes("Waiting for a heavy command slot · all 1 busy"));
    } catch {
      throw new Error(`The aged gate never became ready to take a slot. ${log()}`);
    }
    expect(log()).not.toContain("stalled for");
    expect(f.db.query("SELECT last FROM admission").get()).toEqual({ last: null });
    // The lone ticket is still the ready head. Age its persisted timestamp
    // past the grace while its shell and the held slot stay the same.
    f.db.query("UPDATE tickets SET since = ?").run(Date.now() - CPU_QUEUE_MAX_WAIT_MS - 2 * 60_000);
    await until(() => log().includes("Waiting for a heavy command slot · all 1 busy · stalled for 2 min") || log().includes("waited 12 min"));
    expect(log()).toContain("Waiting for a heavy command slot · all 1 busy · stalled for 2 min");
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    expect(f.count()).toBe(1);
    holder.stdin.write("release\n");
    expect(await holder.exited).toBe(0);
    const result = await pending;
    expect(result.code, log()).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("aged\n");
    expect(f.count()).toBe(0);
  } finally {
    control.abort();
    holder.stdin.end();
    await Promise.allSettled([pending, holder.exited]);
    reader.releaseLock();
    f.close();
  }
}, 30_000);

test("a live owner the helpers can verify keeps the head of a real gate's queue", async () => {
  const f = fixture();
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    seedHead(f, "command:live-head", cpuOwnerIdentity(process.pid));
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    pending = realExec("bash", interleaved("waiting").slice(1), process.cwd(), f.env, { timeoutMs: 15_000 });
    await until(() => f.count() === 2);
    await Bun.sleep(1500); // many polls past every bound the head has outlived
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    expect(f.db.query("SELECT key FROM suspended").all()).toEqual([]);
    f.db.query("DELETE FROM tickets WHERE key = ?").run("command:live-head"); // its owner leaves the queue
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("stalled");
    expect(result.stderr).not.toContain("live-head");
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("start-waiting\nend-waiting\n");
  } finally { await Promise.resolve(pending).catch(() => {}); f.close(); }
}, 30_000);

test.skipIf(process.platform !== "linux")("an admitted parent can finish nested work while a fresh job waits for its only slot", async () => {
  const f = fixture(), controls = [new AbortController(), new AbortController()];
  const pending: Promise<Awaited<ReturnType<typeof realExec>>>[] = [];
  const env = { ...f.env, LLV_GATE_SLOTS: "1", LLV_OWNED_RUN_TIMEOUT_MS: "20000" };
  const ready = path.join(f.dir, "ready"), go = path.join(f.dir, "go");
  const script = `import fs from "node:fs"; import { inheritedCpuSlot } from ${JSON.stringify(path.join(process.cwd(), "src/lib/runtime/cpuAdmission.ts"))}; if (!inheritedCpuSlot()) throw new Error("parent slot was not retained"); fs.writeFileSync(${JSON.stringify(ready)}, process.env.LLV_GATE_SLOT_LEASE!); while (!fs.existsSync(${JSON.stringify(go)})) await Bun.sleep(10); const child = Bun.spawn(${JSON.stringify(f.command("nested"))}, { stdio: ["ignore", "inherit", "inherit"] }); process.exit(await child.exited);`;
  const deadline = setTimeout(() => controls.forEach(c => c.abort()), 6_000);
  try {
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    pending.push(Promise.resolve(realExec("bash", ["scripts/gate-slot.sh", process.execPath, "-e", script], process.cwd(), env, { timeoutMs: 10_000, signal: controls[0]!.signal })));
    await until(() => fs.existsSync(ready));
    pending.push(Promise.resolve(realExec("bash", f.command("fresh").slice(1), process.cwd(), { ...env, LLV_GATE_SLOT_LEASE: "" }, { timeoutMs: 10_000, signal: controls[1]!.signal })));
    await until(() => f.count() === 1);
    fs.writeFileSync(go, "go");
    const results = await Promise.all(pending);
    expect(results.map(r => r.code), JSON.stringify(results)).toEqual([0, 0]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("nested\nfresh\n");
    expect(inheritedCpuSlot({ ...env, LLV_GATE_SLOT_LEASE: fs.readFileSync(ready, "utf8") })).toBeNull();
  } finally { clearTimeout(deadline); controls.forEach(c => c.abort()); await Promise.allSettled(pending); f.close(); }
}, 20_000);

test("pre-push keeps completed admission waits outside its budget across later steps", async () => {
  const f = fixture();
  let waiting: Promise<unknown> | undefined;
  try {
    waiting = runSteps("pre-push", [{ name: "one", command: f.command("one") }, { name: "two", command: f.command("two") }], {
      root: process.cwd(), deadline: { startedAt: Date.now(), at: Date.now() + 5000 }, logDir: f.dir, say: () => {},
      prepare: (step) => ({ command: step.command, env: f.env }),
    });
    // Native helper startup can be slow on a loaded host. Keep fixture
    // readiness separate from the short execution budget exercised below.
    await until(() => f.count() === 1, 15_000);
    await Bun.sleep(5200); f.age();
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT), 15_000);
    await until(() => f.count() === 1, 15_000); f.age();
    expect(await waiting).toEqual([]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("one\ntwo\n");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n"); f.age(); await waiting?.catch(() => {}); f.close(); }
}, 60_000);

test("pre-push carries fetch admission time into the check deadline", async () => {
  const f = fixture();
  let pending: ReturnType<typeof realExec> | undefined;
  const env: NodeJS.ProcessEnv = { ...f.env, LLV_GATE_SLOT_LEASE: "", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.test" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_CONFIG") || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(key)) delete env[key];
  }
  const remote = path.join(f.dir, "remote.git"), work = path.join(f.dir, "work"), upload = path.join(f.dir, "upload.sh");
  const git = (...args: string[]) => execFileSync("git", args, { env, stdio: "pipe" });
  try {
    git("init", "-q", "-b", "main", work);
    fs.writeFileSync(path.join(work, "note.txt"), "fixture\n");
    git("-C", work, "add", "note.txt");
    git("-C", work, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
    git("clone", "-q", "--bare", work, remote);
    git("-C", work, "remote", "add", "origin", remote);
    fs.writeFileSync(upload, '#!/bin/bash\nexec bash "$CPU_FETCH_GATE" git upload-pack "$@"\n', { mode: 0o755 });
    git("-C", work, "config", "remote.origin.uploadpack", upload);
    const script = `import { fetchMain, runSteps } from ${JSON.stringify(path.join(process.cwd(), "scripts/local-gate.ts"))}; const deadline = { startedAt: Date.now(), at: Date.now() + 2000 }; if (await fetchMain(${JSON.stringify(work)}, deadline.at, deadline) !== "fetched") throw new Error("fetch failed"); await runSteps("pre-push", [{ name: "after fetch", command: ["bash", "-c", 'echo checked > "$CPU_QUEUE_OUTPUT"'] }], { root: ${JSON.stringify(work)}, deadline, logDir: ${JSON.stringify(f.dir)}, say: () => {}, prepare: step => ({ command: step.command, env: process.env }) });`;
    pending = realExec(process.execPath, ["-e", script], process.cwd(), { ...env, CPU_FETCH_GATE: path.join(process.cwd(), "scripts/gate-slot.sh") }, { timeoutMs: 10_000 });
    await until(() => f.count() === 1);
    await Bun.sleep(2500); f.age();
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("checked\n");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n"); f.age(); await Promise.resolve(pending).catch(() => {}); f.close(); }
}, 20_000);

test("the owned runner keeps a nested queue wait outside its execution deadline", async () => {
  const f = fixture();
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    // A different pool is a fresh admission; same-pool work retains its
    // parent's existing reservation instead of waiting behind its own slot.
    const script = `import fs from "node:fs"; fs.writeFileSync(process.env.LLV_GATE_PSI_FILE!, "some avg10=90.00 total=1\\n"); const child = Bun.spawn(["bash", "scripts/gate-slot.sh", "bash", "-c", "echo nested > \\\"$CPU_QUEUE_OUTPUT\\\""], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, LLV_GATE_SLOT_LEASE: "", LLV_GATE_LOCK_DIR: ${JSON.stringify(f.dir)} } }); process.exit(await child.exited);`;
    pending = realExec("bash", ["scripts/gate-slot.sh", process.execPath, "-e", script], process.cwd(), { ...f.env, LLV_GATE_LOCK_DIR: path.join(f.dir, "parent-locks"), LLV_OWNED_RUN_TIMEOUT_MS: "1200" }, { timeoutMs: 4000 });
    await until(() => f.count() === 1);
    await Bun.sleep(1600); f.age();
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("nested\n");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n"); f.age(); await Promise.resolve(pending).catch(() => {}); f.close(); }
}, 20_000);

function simulateActiveAdmissionWait(f: ReturnType<typeof fixture>, durationMs: number) {
  const root = f.env.LLV_GATE_LOCK_DIR!;
  const ledgers = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith("budget-"));
  expect(ledgers.length).toBeGreaterThan(0);
  const interval = JSON.stringify({ start: Date.now() - durationMs, end: Date.now() });
  for (const ledger of ledgers) fs.writeFileSync(path.join(root, ledger.name, "simulated-queue.json"), interval);
}

for (const fails of [false, true]) test(`pre-push credits admission across a supervisor and keeps a real touched test verdict (fails: ${fails})`, async () => {
  const f = fixture();
  let pending: ReturnType<typeof realExec> | undefined;
  const file = path.join(f.dir, "publication.test.ts");
  fs.writeFileSync(file, `import { test, expect } from "bun:test"; test("publication assertion", () => expect(true).toBe(${!fails}));`);
  const gate = path.join(process.cwd(), "scripts/local-gate.ts");
  // Both invocations are real processes. The owned slot supervisor inserts a
  // fresh wait ledger between the caller's ledger and the admitted plan.
  const admitted = `const actualNow = Date.now;
    Date.now = () => actualNow() + 5000;
    const { pushDeadline, runSteps, endHook } = await import(${JSON.stringify(gate)});
    try { await runSteps("pre-push", [{ name: "touched tests", command: [process.execPath, "test", ${JSON.stringify(file)}], group: "push checks" }], {
      root: process.cwd(), deadline: pushDeadline(process.env, Date.now(), true), logDir: ${JSON.stringify(f.dir)},
      prepare: step => ({ command: step.command, env: process.env }) }); } catch (error) { endHook("pre-push", error); }`;
  const caller = `import { runAdmittedChecks, endHook } from ${JSON.stringify(gate)};
    const deadline = { at: Date.now() + 4000, startedAt: Date.now() };
    try { await runAdmittedChecks(["bash", "scripts/gate-slot.sh", process.execPath, "-e", ${JSON.stringify(admitted)}], process.cwd(), process.env, deadline); }
    catch (error) { endHook("pre-push", error); }`;
  try {
    pending = realExec(process.execPath, ["-e", caller], process.cwd(), { ...f.env, LLV_GATE_SLOT_LEASE: "", LLV_CPU_WAIT_ROOTS: "[]" }, { timeoutMs: 20_000 });
    await until(() => f.count() === 1, 15_000);
    simulateActiveAdmissionWait(f, 5000);
    // The queue remains blocked until released. A durable test ledger supplies
    // five seconds of simulated admission wait, and the admitted child clock
    // starts five seconds later. The four-second execution budget therefore
    // expires without the real ledger handoff, with no wall-time delay.
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const result = await pending;
    expect(result.code, result.stderr).toBe(fails ? 1 : 0);
    expect(result.stderr).not.toContain("no verdict within");
    expect(result.stderr).toContain(fails ? "publication assertion" : "touched tests: passed");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n"); f.age(); await Promise.resolve(pending).catch(() => {}); f.close(); }
}, 60_000);
