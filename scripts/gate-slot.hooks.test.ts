import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { redactBounded } from "../src/lib/monitor/redact";
import { installedGateAdmissionEnv } from "../src/lib/runtime/agentSignalSandbox";
import { CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS, CPU_QUEUE_STALE_GRACE_MS } from "../src/lib/runtime/cpuAdmission";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { realExec } from "../src/lib/workflows/provision";
import { fixture, legacyGateTree, pathWithoutFlock, queuedTickets, until } from "./gate-slot.queue.fixture";
import { createHookFixture, fixtureGitEnv } from "./local-gate.fixture";
import { createPublicationFixtures, stubOlderPublicationChecks } from "./publicationHook.fixture";

const systemctl = process.platform === "linux" ? Bun.which("systemctl") : null;
const hasUserManager = systemctl !== null && Bun.spawnSync([systemctl, "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test("older publication stubs preserve the tracked files of the checkout used as cwd", () => {
  const cwd = process.cwd(), roots: string[] = [];
  const scratch = fs.mkdtempSync(path.join(tmpdir(), "publication-write-"));
  const checkout = path.join(scratch, "checkout");
  const env = fixtureGitEnv();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, env, stdio: "pipe" });
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", cwd, checkout], { env, stdio: "pipe" });
    git("checkout", "--quiet", "--detach", "HEAD");
    process.chdir(checkout);
    const { fixture: publicationFixture } = createPublicationFixtures(process.cwd(), roots);
    const f = publicationFixture();
    const script = "scripts/local-gate-tests.ts";
    const tracked = path.join(checkout, script);
    const original = fs.readFileSync(tracked);
    stubOlderPublicationChecks(f);
    const stub = f.writablePath(script);
    expect(fs.readFileSync(stub, "utf8")).toContain("process.argv.slice(1)");
    fs.unlinkSync(stub);
    fs.symlinkSync(tracked, stub);
    expect(() => stubOlderPublicationChecks(f)).toThrow(/Fixture write refused.*symbolic link/);
    expect(fs.readFileSync(tracked).equals(original)).toBe(true);
    expect(git("status", "--porcelain=v1").toString()).toBe("");
    git("diff", "--no-ext-diff", "--exit-code", "HEAD");

    expect(() => f.writablePath(tracked)).toThrow("target must be inside the fixture's temporary root");
    expect(() => f.writablePath(path.relative(f.dir, tracked))).toThrow("target must be inside the fixture's temporary root");
    fs.symlinkSync(path.dirname(tracked), f.writablePath("linked-scripts"), "dir");
    expect(() => f.writablePath("linked-scripts/new.ts")).toThrow(/symbolic link/);
    fs.symlinkSync(path.join(checkout, "missing.ts"), f.writablePath("dangling.ts"));
    expect(() => f.writablePath("dangling.ts")).toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(checkout, "missing.ts"))).toBeFalse();
    fs.linkSync(tracked, f.writablePath("linked-file.ts"));
    expect(() => f.writablePath("linked-file.ts")).toThrow(/hard-linked file/);
  } finally {
    process.chdir(cwd);
    for (const root of [...roots, scratch]) fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux").each(["bun", "bun-1.4.0"])("installed admission routing keeps %s as its native interpreter", name => {
  const f = fixture(), bin = path.join(f.dir, name);
  try {
    fs.symlinkSync(process.execPath, bin);
    const routed = installedGateAdmissionEnv({ ...f.env, LLV_GATE_BUN: bin });
    expect(routed.LLV_GATE_BUN).not.toBe(bin);
    expect(routed).not.toHaveProperty("PATH");
    expect(installedGateAdmissionEnv({ ...f.env, ...routed })).toEqual(routed);
    const result = Bun.spawnSync([routed.LLV_GATE_BUN!, "-e", 'console.log(require("node:fs").readFileSync("/proc/self/cmdline", "utf8").split("\\0")[0])'],
      { env: { ...process.env, ...routed } });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe(bin);
  } finally { f.close(); }
});

test.skipIf(process.platform !== "linux")("installed admission routing without an interpreter runs gate-slot under the caller's PATH Bun", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    // The caller's only Bun is a copy; the routed launcher must not name the
    // interpreter that generated it (in the image, a container-only binary).
    const bin = path.join(f.dir, "caller-bin");
    fs.mkdirSync(bin);
    fs.copyFileSync(process.execPath, path.join(bin, "bun"), fs.constants.COPYFILE_FICLONE);
    const inherited: NodeJS.ProcessEnv = f.env;
    const PATH = [bin, ...(inherited.PATH ?? "").split(path.delimiter).filter((entry: string) => entry && !fs.existsSync(path.join(entry, "bun")))].join(path.delimiter);
    const env: NodeJS.ProcessEnv = { ...inherited, PATH, LLV_GATE_RUNNER: "off" };
    delete env.LLV_GATE_BUN;
    const routed = installedGateAdmissionEnv(env);
    expect(fs.readFileSync(routed.LLV_GATE_BUN!, "utf8")).not.toContain(process.execPath);
    const result = Bun.spawnSync(f.command("routed"), { env: { ...env, ...routed } });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("routed\n");
  } finally { f.close(); }
});

test.skipIf(!hasUserManager).each(["bun", "bun-1.4.0"])("a pre-commit service and its %s client cannot fence their own queued ESLint", async name => {
  const f = fixture(), roots: string[] = [], control = new AbortController();
  const log = path.join(f.dir, "pre-commit.stderr");
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    const hook = createHookFixture(process.cwd(), roots);
    const hookEnv: NodeJS.ProcessEnv = hook.env;
    const nativeBun = path.join(f.dir, name);
    // Bun resolves process.execPath through /proc/self/exe. A symlink would
    // make the cleanup client relaunch with the installed binary's basename.
    fs.copyFileSync(process.execPath, nativeBun, fs.constants.COPYFILE_FICLONE);
    hookEnv.HOOK_BUN = nativeBun;
    fs.mkdirSync(path.join(hook.dir, "scripts/gate-runner"));
    for (let i = 0; i < 41; i++) fs.writeFileSync(path.join(hook.dir, `input-${i}.ts`), "export {};\n");
    hook.git("add", ".");
    const env: NodeJS.ProcessEnv = { ...hookEnv, ...f.env, PATH: hookEnv.PATH, LLV_GATE_RUNNER: "off", LLV_GATE_SLOTS: "6",
      LLV_GATE_PUSH_DEADLINE: undefined, LLV_GATE_SANDBOX_RECORD: undefined,
      LLV_GATE_BUN: nativeBun,
      CPU_SLOT_STDERR: log, FIXTURE_HOOK_PID: path.join(f.dir, "hook.pid") };
    env.HOOK_BUN = nativeBun;
    withoutInheritedGate(env);
    const previous = Date.now() - CPU_QUEUE_SPACING_MS;
    f.db.query("UPDATE admission SET last = ?").run(previous);
    // The publication comparator can reach this test after the original push
    // deadline. realExec snapshots its environment before returning.
    const enclosingDeadline = process.env.LLV_GATE_PUSH_DEADLINE;
    process.env.LLV_GATE_PUSH_DEADLINE = "1";
    try {
      const invocation = ["bun", "scripts/local-gate.ts", "pre-commit"];
      pending = realExec("bash", ["-c", 'echo $$ > "$FIXTURE_HOOK_PID"; exec "$@" 2>"$CPU_SLOT_STDERR"', "pre-commit-fixture", ...invocation],
        hook.dir, env, { timeoutMs: 18_000, signal: control.signal });
    } finally {
      if (enclosingDeadline === undefined) delete process.env.LLV_GATE_PUSH_DEADLINE;
      else process.env.LLV_GATE_PUSH_DEADLINE = enclosingDeadline;
    }
    const diagnostics = () => new Error(redactBounded(fs.readFileSync(log, "utf8"), 2_000));
    await until(() => f.count() === 1, 8_000, diagnostics);
    const ticket = f.db.query<{ key: string; owner: string }, []>(`SELECT key, owner ${queuedTickets}`).get()!;
    const waiter = JSON.parse(ticket.owner).pid;
    const group = fs.readFileSync(`/proc/${waiter}/cgroup`, "utf8");
    const unit = /\/(delegatus-gate-[\da-f-]+\.service)(?:\/|\n)/.exec(group)?.[1];
    expect(unit).toBeDefined();
    const service = execFileSync(systemctl!, ["--user", "show", "-p", "MainPID", "--value", unit!], { encoding: "utf8" }).trim();
    const argv = fs.readFileSync(`/proc/${service}/cmdline`, "utf8").split("\0");
    expect(argv[0]).toBe(nativeBun);
    expect(argv[2]).toBe("--service");
    expect(fs.existsSync(argv[3]!)).toBe(false);
    const children = (pid: string) => fs.readdirSync(`/proc/${pid}/task`).flatMap(thread =>
      fs.readFileSync(`/proc/${pid}/task/${thread}/children`, "utf8").trim().split(/\s+/).filter(Boolean));
    const original = fs.readFileSync(env.FIXTURE_HOOK_PID!, "utf8").trim();
    const clients = children(original).filter(pid => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("owned-runner.ts"));
    expect(clients).toHaveLength(1);
    expect(fs.readFileSync(`/proc/${clients[0]}/cmdline`, "utf8").split("\0")[0]).toBe(nativeBun);
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
    const lint = hook.calls().filter(call => call.args[0] === "scripts/eslint-changes.ts");
    expect(lint).toHaveLength(1);
    expect(lint[0]!.deadline).toBeUndefined();
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

// The bootstrap record (#4376) agrees with this launch in the last case. It binds
// a launch to its parent and still cannot exempt a holder on its own.
for (const [beforeJournal, clockStep, nested, record] of [[false, 0, false, false], [true, 0, false, false], [true, 30_000, false, false], [true, 0, true, false], [true, 30_000, true, false], [true, 0, false, true]] as const) test.skipIf(!hasUserManager)(
  `a same-command pre-commit keeps its legacy grant until it drains (pre-journal: ${beforeJournal}, clock step: ${clockStep} ms, nested waiter: ${nested}, bootstrap record: ${record})`, async () => {
  const f = fixture(), control = new AbortController(), pending: ReturnType<typeof realExec>[] = [];
  const entered = path.join(f.dir, "entered"), release = path.join(f.dir, "release");
  const openNested = path.join(f.dir, "open-nested");
  const log = path.join(f.dir, "entrant.stderr"), slot = path.join(f.dir, "llv-heavy-gate.slot1.lock");
  const grants = () => f.db.query("SELECT at FROM grants ORDER BY rowid").all();
  const journalExists = () => f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'legacy_gate_retirements'").get() !== null;
  const stat = (pid: string) => fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
  try {
    const legacy = legacyGateTree(f.dir), bin = pathWithoutFlock(f.dir);
    for (const name of ["sh", "cat", "id", "ps", "awk", "sed", "chmod", "python3", "basename", "nproc", "env", "readlink", "cut"]) {
      const executable = Bun.which(name);
      if (executable) fs.symlinkSync(executable, path.join(bin, name));
    }
    const hook = nested ? legacy : path.join(f.dir, "hook"), entry = path.join(hook, "scripts/local-gate.ts");
    fs.mkdirSync(path.join(hook, ".git"), { recursive: true });
    fs.mkdirSync(path.join(hook, "scripts/gate-runner"), { recursive: true });
    // Drive the old gate with the same argv and launch proof as the cleanup
    // handoff. The inner hook holds the native service open at a file barrier.
    fs.writeFileSync(entry, `import fs from "node:fs";
import { captureProcessIdentity } from ${JSON.stringify(path.resolve("src/lib/processIdentity.ts"))};
if (process.env.FIXTURE_HOOK_CHILD === "1") {
  fs.writeFileSync(process.env.FIXTURE_ENTERED!, String(process.pid));
  while (!fs.existsSync(process.env.FIXTURE_RELEASE!) && !fs.existsSync(process.env.FIXTURE_OPEN_NESTED!)) await Bun.sleep(20);
  if (fs.existsSync(process.env.FIXTURE_OPEN_NESTED!) && !fs.existsSync(process.env.FIXTURE_RELEASE!)) {
    const child = Bun.spawn(["/bin/bash", "scripts/gate-slot.sh", "bash", "-c", "true"], {
      env: { ...process.env, PATH: process.env.FIXTURE_NORMAL_PATH!, LLV_GATE_BUN: process.env.FIXTURE_NESTED_BUN!,
        DELEGATUS_CPU_PRESSURE: "on", LLV_GATE_STEP: process.pid + "-nested" },
      stdout: "inherit", stderr: "inherit",
    });
    while (!fs.existsSync(process.env.FIXTURE_RELEASE!)) await Bun.sleep(20);
    await child.exited;
  }
} else {
  const parent = captureProcessIdentity(process.pid);
  const child = Bun.spawn(["/bin/bash", process.env.FIXTURE_LEGACY_GATE!, process.execPath, import.meta.path, "pre-commit"], {
    env: { ...process.env, FIXTURE_HOOK_CHILD: "1", LLV_OWNED_RUN_PARENT_IDENTITY: JSON.stringify(parent),
      ...(process.env.FIXTURE_BOOTSTRAP_RECORD === "1"
        ? { LLV_GATE_UNADMITTED_HOOK_BOOTSTRAP: JSON.stringify({ parent, mode: "pre-commit", entry: fs.realpathSync(import.meta.path) }) } : {}) },
    stdout: "inherit", stderr: "inherit",
  });
  fs.writeFileSync(process.env.FIXTURE_CLIENT!, String(child.pid));
  process.exit(await child.exited);
}
`);
    const clientFile = path.join(f.dir, "client.pid");
    const env = withoutInheritedGate({ ...f.env, LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off", LLV_GATE_BUN: process.execPath,
      DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_PUSH_DEADLINE: undefined, LLV_GATE_SANDBOX_RECORD: undefined });
    f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
    if (beforeJournal) f.db.exec("DROP TRIGGER legacy_gate_retired; DROP TABLE legacy_gate_cutover; DROP TABLE legacy_gate_retirements");
    const interpreter = path.join(f.dir, "legacy-bun"), clock = path.join(f.dir, "grant-clock.ts");
    const nestedBun = path.join(f.dir, "nested-bun"), nestedWait = path.join(f.dir, "nested-wait.ts");
    fs.writeFileSync(nestedWait, `import fs from "node:fs";
setInterval(() => {
  if (fs.existsSync(process.env.FIXTURE_RELEASE!)) process.kill(process.pid, "SIGTERM");
}, 20).unref();
`);
    fs.writeFileSync(nestedBun, `#!/bin/bash
if [[ "${"$"}{1##*/}" == cpu-admission.ts ]]; then
  shift
  if [[ "$1" == --wait ]]; then exec "$FIXTURE_BUN" --preload "$FIXTURE_NESTED_WAIT" "$FIXTURE_CURRENT_HELPER" "$@"; fi
  exec "$FIXTURE_BUN" "$FIXTURE_CURRENT_HELPER" "$@"
fi
exec "$FIXTURE_BUN" "$@"
`, { mode: 0o700 });
    // Record the legacy claim before a forward wall-clock step. All later
    // helpers still see the kernel's real wall/boot clock pair.
    fs.writeFileSync(clock, `const wall = Date.now; Date.now = () => wall() - ${clockStep};
`);
    fs.writeFileSync(interpreter, `#!/bin/bash
if [[ "${"$"}{1##*/}" == cpu-admission.ts && "$2" == --claim ]]; then
  exec "$FIXTURE_BUN" --preload "$FIXTURE_CLOCK" "$@"
fi
exec "$FIXTURE_BUN" "$@"
`, { mode: 0o700 });
    pending.push(realExec("/bin/bash", ["-c", '"$@"; exit $?', "hook-fixture", process.execPath, entry, "pre-commit"], hook,
      { ...env, PATH: bin, LLV_GATE_BUN: interpreter, FIXTURE_BUN: process.execPath, FIXTURE_CLOCK: clock,
        FIXTURE_ENTERED: entered, FIXTURE_RELEASE: release, FIXTURE_CLIENT: clientFile,
        FIXTURE_OPEN_NESTED: openNested, FIXTURE_NORMAL_PATH: process.env.PATH, FIXTURE_NESTED_BUN: nestedBun,
        FIXTURE_CURRENT_HELPER: path.resolve("scripts/cpu-admission.ts"), FIXTURE_NESTED_WAIT: nestedWait,
        FIXTURE_LEGACY_GATE: path.join(legacy, "scripts/gate-slot.sh"), FIXTURE_BOOTSTRAP_RECORD: record ? "1" : "0" }, { timeoutMs: 30_000, signal: control.signal }));
    await until(() => fs.existsSync(entered), 10_000);
    const hookPid = fs.readFileSync(entered, "utf8"), client = fs.readFileSync(clientFile, "utf8");
    const clientArgv = fs.readFileSync(`/proc/${client}/cmdline`, "utf8").split("\0");
    expect(clientArgv.slice(1, 5)).toEqual([path.join(legacy, "scripts/owned-runner.ts"), process.execPath, entry, "pre-commit"]);
    const original = stat(client)[1]!;
    expect(fs.readFileSync(`/proc/${original}/cmdline`, "utf8").split("\0").slice(1, 3)).toEqual([entry, "pre-commit"]);
    const unit = /\/(delegatus-gate-[\da-f-]+\.service)(?:\/|\n)/.exec(fs.readFileSync(`/proc/${hookPid}/cgroup`, "utf8"))?.[1];
    expect(unit).toBeDefined();
    const supervisor = execFileSync(systemctl!, ["--user", "show", "-p", "MainPID", "--value", unit!], { encoding: "utf8" }).trim();
    const service = fs.readFileSync(`/proc/${supervisor}/cmdline`, "utf8").split("\0");
    expect(service.slice(1, 3)).toEqual([clientArgv[1], "--service"]);
    expect(fs.existsSync(service[3]!)).toBe(false);
    expect(journalExists()).toBe(!beforeJournal);
    if (!beforeJournal) {
      expect(f.db.query<{ owner: string }, []>("SELECT owner FROM legacy_gate_retirements").all()
        .map(row => JSON.parse(row.owner).startIdentity)).toContain(`${client}:${stat(client)[19]}`);
    }
    const held = f.db.query<{ last: number }, []>("SELECT last FROM admission").get()!.last;
    expect(grants()).toEqual([{ at: held }]);
    expect(f.count()).toBe(0);
    expect(fs.existsSync(slot)).toBe(false);

    pending.push(realExec("bash", ["-c", 'exec "$@" 2>"$FIXTURE_ENTRANT_LOG"', "entrant", ...f.command("entrant")],
      process.cwd(), { ...env, FIXTURE_ENTRANT_LOG: log, ...(nested ? { DELEGATUS_CPU_PRESSURE: "on" } : {}) },
      { timeoutMs: 25_000, signal: control.signal }));
    await until(() => f.count() === 1);
    const head = f.db.query<{ key: string }, []>(`SELECT key ${queuedTickets}`).get()!.key;
    if (nested) {
      // Change the checkout after the old gate execs the runner in place. The
      // inner hook queues with the new wrapper and the same checkout identity.
      const wrapper = path.join(legacy, "scripts/gate-slot.sh");
      fs.copyFileSync("scripts/gate-slot.sh", wrapper + ".new");
      fs.renameSync(wrapper + ".new", wrapper);
      fs.writeFileSync(openNested, "go");
      await until(() => f.count() === 2);
      const ticket = f.db.query<{ owner: string }, [string]>(`SELECT owner ${queuedTickets} AND key != ?`).get(head)!;
      expect(stat(String(JSON.parse(ticket.owner).pid))[1]).toBe(hookPid);
      fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    }
    const stderr = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    const polls = new Set<number>();
    await until(() => {
      const polled = f.db.query<{ polled: number }, [string]>("SELECT polled FROM tickets WHERE key = ?").get(head)?.polled;
      if (polled && polled > held + CPU_QUEUE_SPACING_MS) polls.add(polled);
      return grants().length > 1 || polls.size >= 3 && stderr().includes("Waiting for legacy heavy commands to drain");
    }, 10_000, () => new Error(stderr()));
    expect(journalExists()).toBe(true);
    expect(grants()).toEqual([{ at: held }]);
    expect(stat(hookPid)[0]).not.toBe("Z");
    expect(f.count()).toBe(nested ? 2 : 1);
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);

    fs.writeFileSync(release, "release");
    await until(() => !fs.existsSync(`/proc/${hookPid}`), 10_000, () => new Error("legacy hook remained after its release marker"));
    const outcomes = await Promise.all(pending);
    expect(outcomes.map(result => result.code), redactBounded(outcomes[0]!.stderr + stderr(), 2_000)).toEqual([0, 0]);
    expect(grants()).toHaveLength(2);
    expect(fs.existsSync(`/proc/${hookPid}`)).toBe(false);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("entrant\n");
    expect(f.count()).toBe(0);
  } finally {
    fs.writeFileSync(release, "release");
    control.abort();
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

test.skipIf(process.platform !== "linux").each([
  { cap: 1, mode: "drain" }, { cap: 2, mode: "drain" }, { cap: 6, mode: "drain" }, { cap: 1, mode: "deadline" },
  { cap: 2, mode: "recorder identity changed" },
])("a recorded native pre-push and competing waiter at cap $cap ($mode)", async ({ cap, mode }) => {
  const f = fixture(), roots: string[] = [], control = new AbortController();
  const { fixture: publicationFixture } = createPublicationFixtures(process.cwd(), roots);
  const hook = publicationFixture();
  const log = path.join(f.dir, "reviewed-check.log");
  const phaseFile = `${log}.gate/wait-only.json`;
  const waiting = () => f.db.query<{ key: string; owner: string; since: number }, []>(`SELECT key, owner, since ${queuedTickets} ORDER BY seq`).all();
  const slots = () => f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'gate_slots'").get()
    ? f.db.query("SELECT slot FROM gate_slots").all().length : 0;
  const wrapper = path.resolve("scripts/gate-slot.sh");
  const pending: ReturnType<typeof realExec>[] = [];
  const limit = 42_000;
  const holderReady = path.join(f.dir, "holder-ready"), releaseHolder = path.join(f.dir, "holder-release");
  const diag = () => new Error(fs.existsSync(log) ? redactBounded(fs.readFileSync(log, "utf8"), 3_000) : "recorded log is missing");
  try {
    fs.mkdirSync(hook.writablePath("scripts/gate-runner"));
    const env: NodeJS.ProcessEnv = { ...hook.env, ...f.env, PATH: process.env.PATH, LLV_GATE_BUN: process.execPath,
      LLV_GATE_SLOTS: String(cap), LLV_GATE_RUNNER: "off", TMPDIR: f.dir,
      LLV_GATE_PUSH_DEADLINE: undefined, LLV_GATE_PUBLICATION_RECEIPT: undefined, LLV_GATE_SANDBOX_RECORD: undefined };
    withoutInheritedGate(env, { keepSandbox: true });
    const legacy = legacyGateTree(f.dir);
    const bin = pathWithoutFlock(f.dir);
    fs.rmSync(path.join(bin, "systemctl"), { force: true });
    const olderEnv = withoutInheritedGate({ ...f.env, PATH: bin, LLV_GATE_BUN: process.execPath,
      LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off", DELEGATUS_CPU_PRESSURE: "off", READY: holderReady, RELEASE: releaseHolder });
    pending.push(realExec("bash", ["scripts/gate-slot.sh", "bash", "-c",
      ': > "$READY"; while [[ ! -f "$RELEASE" ]]; do sleep 0.02; done'], legacy, olderEnv,
    { timeoutMs: limit, signal: control.signal }));
    await until(() => fs.existsSync(holderReady), 10_000);
    pending.push(realExec("bash", [wrapper, "--record", log, ".githooks/pre-push"], hook.dir, { ...env, PATH: hook.env.PATH },
      { timeoutMs: limit, signal: control.signal }));
    await until(() => waiting().length === 1, 10_000, diag);
    const first = waiting()[0]!;
    const child = JSON.parse(first.owner);
    await until(() => {
      try { return Boolean(JSON.parse(fs.readFileSync(phaseFile, "utf8")).child); }
      catch { return false; }
    }, 10_000, diag);
    const proof = JSON.parse(fs.readFileSync(phaseFile, "utf8"));
    expect(child.pid).not.toBe(proof.recorder.pid);
    expect(child.pid).not.toBe(proof.wrapper.pid);
    expect(proof.recorder.pid).not.toBe(proof.wrapper.pid);
    expect(proof.command).toEqual([".githooks/pre-push"]);
    expect(proof.child).toMatchObject({ ticket: first.key, identity: child });
    expect(proof.child.scope).toBe(fs.readFileSync("/proc/" + child.pid + "/cgroup", "utf8"));
    pending.push(realExec("bash", f.command("competing").slice(1), process.cwd(), env,
      { timeoutMs: limit, signal: control.signal }));
    await until(() => waiting().length === 2, 10_000, diag);
    const second = waiting()[1]!;
    expect(slots()).toBe(0);
    expect(fs.readdirSync(f.dir).filter(file => /slot\d+\.lock$/.test(file))).toEqual([]);
    // The observer starts with supervisors already live and within the last
    // grant's uncertainty window. Require the new proof after the holder exits.
    const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    f.db.query("UPDATE legacy_gate_cutover SET boot = ?, clock = ?, uptime = ?, admission = ?")
      .run(child.bootEpoch, fs.readlinkSync("/proc/self/ns/time"), uptime, Date.now());
    f.db.exec("CREATE TABLE recorded_grants (at INTEGER); CREATE TRIGGER recorded_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO recorded_grants VALUES (NEW.last); END");
    let peak = 0;
    const sample = setInterval(() => {
      peak = Math.max(peak, slots());
    }, 15);
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    try {
      await until(() => fs.readFileSync(log, "utf8").includes("legacy heavy commands to drain"), 8_000, diag);
      expect(slots()).toBe(0);
      expect(waiting().map(ticket => ticket.key)).toEqual([first.key, second.key]);
      if (mode === "deadline") {
        const receipt = path.join(`${log}.gate`, "completion.json");
        const original = fs.readFileSync(receipt, "utf8");
        f.db.query("UPDATE tickets SET since = ? WHERE key = ?")
          .run(Date.now() - CPU_QUEUE_MAX_WAIT_MS - CPU_QUEUE_STALE_GRACE_MS - 1_000, first.key);
        expect((await pending[1]!).code, diag().message).toBe(75);
        expect(fs.readFileSync(`${log}.gate/exit`, "utf8")).toBe("75\n");
        expect(fs.readFileSync(receipt, "utf8")).toBe(original);
        expect(diag().message).toContain("legacy heavy-command ownership is unverified");
        expect(waiting().map(ticket => ticket.key)).toEqual([second.key]);
        expect(slots()).toBe(0);
        fs.writeFileSync(releaseHolder, "release");
        expect((await pending[0]!).code).toBe(0);
        expect((await pending[2]!).code).toBe(0);
        return;
      }
      const phase = cap === 2 && fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, "utf8") : null;
      if (phase) {
        const stale = JSON.parse(phase);
        if (mode === "recorder identity changed") stale.recorder.startIdentity = `${stale.recorder.pid}:0`;
        else stale.child.ticket = second.key;
        fs.writeFileSync(phaseFile, JSON.stringify(stale));
        const poll = () => f.db.query<{ polled: number }, [string]>("SELECT polled FROM tickets WHERE key = ?").get(first.key)?.polled;
        const before = poll();
        await until(() => poll() !== before, 5_000, diag);
        expect(waiting().map(ticket => ticket.key)).toEqual([first.key, second.key]);
        fs.writeFileSync(phaseFile, phase);
      }
      fs.writeFileSync(releaseHolder, "release");
      expect((await pending[0]!).code).toBe(0);
      const opened = performance.now();
      await until(() => !waiting().some(ticket => ticket.key === first.key), 12_000, diag);
      const firstWait = Math.round(performance.now() - opened);
      const queuedMs = Date.now() - first.since;
      expect(waiting().some(ticket => ticket.key === second.key)).toBe(true);
      const results = await Promise.all(pending);
      expect(results.map(result => result.code), diag().message).toEqual([0, 0, 0]);
      expect(hook.calls().filter(call => call.args[0] === "tsc")).toHaveLength(1);
      expect(f.db.query("SELECT at FROM recorded_grants ORDER BY rowid").all()).toHaveLength(2);
      expect(waiting()).toEqual([]);
      expect(fs.existsSync(phaseFile)).toBe(false);
      expect(fs.readFileSync(`${log}.gate/exit`, "utf8")).toBe("0\n");
      expect(peak).toBeLessThanOrEqual(cap);
      console.log(`recorded hook cap=${cap}: tickets=2, queue wait=${queuedMs} ms, admission after drain=${firstWait} ms, peak sampled workers=${peak}`);
    } finally { clearInterval(sample); }
  } finally {
    fs.writeFileSync(releaseHolder, "release");
    control.abort();
    await Promise.allSettled(pending);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    f.close();
  }
}, 60_000);

test.skipIf(!hasUserManager).each([false, true])("the real publication preparer binds its bootstrap proof to the entry (mismatch: %s)", async mismatch => {
  const f = fixture(), roots: string[] = [], control = new AbortController();
  const { fixture: publicationFixture } = createPublicationFixtures(process.cwd(), roots);
  const hook = publicationFixture();
  const proofPath = hook.writablePath(".git/bootstrap-proof");
  const preload = hook.writablePath(".git/observe-bootstrap.ts");
  const stderr = path.join(f.dir, "bootstrap.stderr");
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    fs.mkdirSync(hook.writablePath("scripts/gate-runner"));
    fs.writeFileSync(preload, `
      import fs from "node:fs";
      import { captureProcessIdentity } from ${JSON.stringify(path.resolve("src/lib/processIdentity.ts"))};
      const spawn = Bun.spawn;
      Bun.spawn = function (command, options) {
        if (Array.isArray(command) && command[1]?.endsWith("/owned-runner.ts") && command.includes("--publication-prepare")) {
          const proof = options.env.LLV_GATE_UNADMITTED_HOOK_BOOTSTRAP;
          const entry = command.find(arg => arg.endsWith("/local-gate.ts"));
          const expected = JSON.stringify({ parent: captureProcessIdentity(process.pid), mode: "pre-push", entry: fs.realpathSync(entry) });
          fs.writeFileSync(${JSON.stringify(proofPath)}, JSON.stringify({ equal: proof === expected }));
          if (${JSON.stringify(mismatch)}) options.env.LLV_GATE_UNADMITTED_HOOK_BOOTSTRAP =
            JSON.stringify({ ...JSON.parse(proof), entry: entry + ".other" });
          // Observe the real launch, then remove the observer's own CLI
          // preload from the child that the native classifier will inspect.
          command = command.filter((arg, index) => arg !== "--preload" && !arg.startsWith("--preload=") && command[index - 1] !== "--preload");
          delete options.env.BUN_OPTIONS;
        }
        return spawn.call(Bun, command, options);
      };
    `);
    const env: NodeJS.ProcessEnv = { ...hook.env, ...f.env, PATH: hook.env.PATH,
      LLV_GATE_BUN: process.execPath, LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off", LLV_GATE_SANDBOX_RECORD: undefined,
      LLV_GATE_PUSH_DEADLINE: undefined, BUN_OPTIONS: `--preload=${preload}`, CPU_SLOT_STDERR: stderr };
    withoutInheritedGate(env, { keepSandbox: true });
    f.db.query("UPDATE admission SET last = ?").run(Date.now() - CPU_QUEUE_SPACING_MS);
    pending = realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "fixture", process.execPath,
      "scripts/local-gate.ts", "pre-push", "--publication-prepare"], hook.dir, env, { timeoutMs: 25_000, signal: control.signal });
    await until(() => f.count() === 1 && fs.existsSync(proofPath), 10_000);
    expect(JSON.parse(fs.readFileSync(proofPath, "utf8"))).toEqual({ equal: true });
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    if (mismatch) {
      await until(() => fs.readFileSync(stderr, "utf8").includes("legacy heavy commands to drain"), 8_000);
      expect(fs.existsSync(hook.receipt)).toBe(false);
    } else {
      const result = await pending;
      expect(result.code, redactBounded(fs.readFileSync(stderr, "utf8"), 3_000)).toBe(0);
      expect(readPublicationCheckReceipt(hook.receipt, publicationCheckBinding(env)).completedAt).toBeGreaterThan(0);
    }
  } finally {
    control.abort();
    if (pending) await Promise.allSettled([pending]);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    f.close();
  }
}, 55_000);
