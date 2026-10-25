import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cpuAdmissionFile, CPU_QUEUE_MAX_WAIT_MS, CpuAdmissionQueue, inheritedCpuSlot } from "../src/lib/runtime/cpuAdmission";
import { cpuOwnerIdentity } from "../src/lib/runtime/signalSandboxContext";
import { realExec } from "../src/lib/workflows/provision";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { runSteps } from "./local-gate";

async function until(check: () => boolean) {
  const ends = Date.now() + 5_000;
  while (!check()) { if (Date.now() > ends) throw new Error("queue fixture did not reach its barrier"); await Bun.sleep(10); }
}
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
    count: () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tickets").get()!.n,
    age: () => db.query("UPDATE tickets SET since = ?").run(Date.now() - CPU_QUEUE_MAX_WAIT_MS),
    close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

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
  --wait) exit 0 ;;
  --claim) echo 'gate-slot: CPU admission queue lock deadline exceeded; checks did not start' >&2; exit 1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  try {
    const result = await realExec("/bin/bash", ["scripts/gate-slot.sh", "/bin/bash", "-c", 'echo started > "$CPU_QUEUE_OUTPUT"'], process.cwd(), {
      ...f.env, LLV_GATE_BUN: helper, LLV_GATE_RUNNER: "off", LLV_CPU_WAIT_ROOTS: "[]", LLV_GATE_SLOTS: "1",
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

test("gate-slot keeps pressure mandatory beyond ten minutes and preserves FIFO through slot acquisition", async () => {
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
    await Bun.sleep(100);
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const results = await Promise.all([one, two]);
    expect(results.map(r => r.code), JSON.stringify(results)).toEqual([0, 0]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("one\ntwo\n");
    expect(results[1]!.stderr).toContain("2nd");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n"); f.age(); await Promise.allSettled(pending); f.close(); }
}, 20_000);

test("a restarted claim helper refuses high pressure after the queue bound, then accepts a low sample", async () => {
  const f = fixture();
  const claim = async () => {
    const child = Bun.spawn([process.execPath, "scripts/cpu-admission.ts", "--claim", "command:claim-restart", String(process.pid)], { env: f.env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stderr).text();
    return { code: await child.exited, output };
  };
  try {
    expect((await claim()).code).toBe(75);
    f.age();
    const refused = await claim();
    expect(refused.code).toBe(75);
    expect(refused.output).toContain("Waiting for measured CPU pressure");
    expect(f.count()).toBe(1);
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    expect((await claim()).code).toBe(0);
    expect(f.count()).toBe(0);
  } finally { f.close(); }
});

test("a lost slot claim keeps the shell retry pause outside the caller's execution budget", async () => {
  const f = fixture(), controller = new AbortController();
  const bin = path.join(f.dir, "bin"), ready = path.join(f.dir, "claim-ready"), lost = path.join(f.dir, "claim-lost");
  fs.mkdirSync(bin);
  // Readiness observes a free slot; the shell loses its first lock race.
  fs.writeFileSync(path.join(bin, "flock"), '#!/bin/bash\nif [[ "$#" -eq 2 && "$1" == -n && "$2" == 9 && ! -f "$CPU_CLAIM_READY" ]]; then echo lost > "$CPU_CLAIM_LOST"; exit 1; fi\nexit 0\n', { mode: 0o755 });
  const guard = setTimeout(() => controller.abort(), 7000);
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    pending = realExec("bash", f.command("claimed").slice(1), process.cwd(), {
      ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, CPU_CLAIM_READY: ready, CPU_CLAIM_LOST: lost,
      DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_SLOTS: "1", LLV_GATE_POLL_SECONDS: "2",
    }, { timeoutMs: 1000, signal: controller.signal });
    await until(() => fs.existsSync(lost));
    await Bun.sleep(1300);
    fs.writeFileSync(ready, "ready");
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("claimed\n");
  } finally { clearTimeout(guard); controller.abort(); await Promise.resolve(pending).catch(() => {}); f.close(); }
}, 20_000);

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
    expect(f.db.query("SELECT key FROM tickets").all()).toEqual([{ key: "command:foreign-head" }]);
  } finally { await Promise.allSettled(pending); f.close(); }
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
      root: process.cwd(), deadline: { startedAt: Date.now(), at: Date.now() + 1200 }, logDir: f.dir, say: () => {},
      prepare: (step) => ({ command: step.command, env: f.env }),
    });
    await until(() => f.count() === 1);
    await Bun.sleep(1300); f.age();
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT));
    await until(() => f.count() === 1); f.age();
    expect(await waiting).toEqual([]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("one\ntwo\n");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n"); f.age(); await waiting?.catch(() => {}); f.close(); }
}, 20_000);

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
  const ledgers = fs.readdirSync(root).filter(name => name.startsWith("budget-")).map(name => path.join(root, name));
  expect(ledgers.length).toBeGreaterThan(0);
  const interval = JSON.stringify({ start: Date.now() - durationMs, end: Date.now() });
  for (const ledger of ledgers) fs.writeFileSync(path.join(ledger, "simulated-queue.json"), interval);
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
    await until(() => f.count() === 1);
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
}, 25_000);
