import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { redactBounded } from "../src/lib/monitor/redact";
import { captureProcessIdentity } from "../src/lib/processIdentity";
import { installedGateAdmissionEnv } from "../src/lib/runtime/agentSignalSandbox";
import { CPU_QUEUE_SPACING_MS } from "../src/lib/runtime/cpuAdmission";
import { hostProcessIdentity, signalSandboxContext } from "../src/lib/runtime/signalSandboxContext";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { realExec } from "../src/lib/workflows/provision";
import { fixture, legacyGateTree, pathWithoutFlock, queuedTickets, until } from "./gate-slot.queue.fixture";
import { createHookFixture, fixtureGitEnv } from "./local-gate.fixture";
import { createPublicationFixtures, stubOlderPublicationChecks } from "./publicationHook.fixture";

const systemctl = process.platform === "linux" ? Bun.which("systemctl") : null;
const hasUserManager = systemctl !== null && Bun.spawnSync([systemctl, "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
// #4376 (`b0de5fb1ef`) is the last main revision of local-gate.ts and gate-slot.sh before this protocol.
const MAIN_ERA_REVISION = "b0de5fb1ef6b500853e53b587e63a13a91b3e0dd";

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
    fs.symlinkSync(path.dirname(tracked), f.writablePath("linked-scripts"), "dir");
    expect(() => f.writablePath("linked-scripts/new.ts")).toThrow(/symbolic link/);
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

for (const mode of ["portable hooks first-open", "service hooks first-open", "portable prepare", "portable hooks", "service prepare", "mixed service prepare", "mixed service prepare first-open", "service hooks", "historical service hook", "older helper head", "main-era service prepare", "main-era service hook"] as const) test.skipIf(
  process.platform !== "linux" || !mode.startsWith("portable") && !hasUserManager
)(`FIFO publication admits the first check while the peer waits (${mode})`, async () => {
    const useService = !mode.startsWith("portable");
    const historical = mode === "historical service hook" || mode === "main-era service hook", olderHead = mode === "older helper head";
    const mixedPrepare = mode.startsWith("mixed service prepare") || mode === "main-era service prepare";
    // Main after #4376 is the release deployed when this queue protocol lands.
    // Its dispatcher and wrapper carry no launch marker of their own.
    const mainEra = mode.startsWith("main-era");
    const deployedRevision = mainEra ? MAIN_ERA_REVISION : "43fab846adb9a443384d30540cf7e318a12a6198";
    const historicalRevision = mainEra ? MAIN_ERA_REVISION : "c0ceb7ff5eb064b1d9d29a9aef2540edd15d5dd1";
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
        LLV_GATE_PUBLICATION_ID: name, CPU_SLOT_ROOT_PID: path.join(f.dir, name + ".pid"), LLV_OWNED_RUN_TIMEOUT_MS: "25000", LLV_GATE_SANDBOX_RECORD: undefined, LLV_GATE_PUSH_DEADLINE: undefined };
      if (olderHead) {
        // Route through the same host-only interpreter binding supplied by the
        // launcher. The fixture's Bun shim still stands in for the check.
        const bun = publication.writablePath("shims/bun");
        fs.writeFileSync(bun, fs.readFileSync(bun, "utf8").replace("#!/bin/bash\n", `#!/bin/bash
case "$1" in */cpu-admission.ts|*/owned-runner.ts) exec "$HOOK_BUN" "$@" ;; esac
`));
        env.LLV_GATE_BUN = process.execPath;
      }
      withoutInheritedGate(env, { keepSandbox: useService });
      // The reset unroutes an inherited launcher, so route afterwards.
      if (olderHead) Object.assign(env, installedGateAdmissionEnv(env));
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
          // Only the outer launcher exercises placement. The publication
          // checks themselves use the fixture's ordinary isolated environment.
          const hookFile = publication.writablePath(".githooks/pre-push");
          fs.writeFileSync(hookFile, fs.readFileSync(hookFile, "utf8").replace("\n", "\nexport DELEGATUS_AGENT_CPU=off\n"));
          const systemctlShim = publication.writablePath("shims/systemctl");
          fs.writeFileSync(systemctlShim, '#!/bin/bash\nif [[ $1 == --user && $2 == set-property ]]; then exit 0; fi\nexec "$FIXTURE_SYSTEMCTL" "$@"\n', { mode: 0o755 });
          Object.assign(env, { LLV_GATE_CGROUP_FILE: membership, LLV_GATE_CGROUP_ROOT: f.dir, LLV_GATE_SLICE: "fixture.slice",
            DELEGATUS_AGENT_CPU: "on", FIXTURE_SYSTEMCTL: systemctl, LLV_GATE_BUN: process.execPath });
          command = ["bash", "scripts/gate-slot.sh", ".githooks/pre-push"];
        }
      }
      let outcome: Awaited<ReturnType<typeof realExec>> | undefined;
      // Reproduce an exhausted comparator's enclosing deadline on every run.
      // realExec snapshots the environment synchronously when spawning.
      const enclosingDeadline = process.env.LLV_GATE_PUSH_DEADLINE;
      process.env.LLV_GATE_PUSH_DEADLINE = "1";
      try {
        pending.push(Promise.resolve(realExec("bash", ["-c", 'echo "$$" > "$CPU_SLOT_ROOT_PID"; exec "$@" 2>"$CPU_SLOT_STDERR"', "publication-fixture", ...command], publication.dir, env, { timeoutMs: 30_000, signal: control.signal }))
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
      const first = (() => {
        if (!mixedPrepare) return publicationFixture();
        const deployed = legacyGateTree(f.dir, deployedRevision);
        execFileSync("git", ["init", "--quiet", deployed], { env: fixtureGitEnv() });
        return createPublicationFixtures(deployed, roots).fixture();
      })();
      const peer = historical
        ? createPublicationFixtures(legacyGateTree(f.dir, historicalRevision), roots).fixture()
        : publicationFixture();
      if (mixedPrepare) {
        // The deployed hook supplies only the cleanup owner's parent identity.
        // Its own gate wrapper gets the admission helper from the new release.
        const helper = path.join(first.writablePath("scripts"), "cpu-admission.ts");
        fs.unlinkSync(helper);
        fs.symlinkSync(path.resolve("scripts/cpu-admission.ts"), helper);
      }
      if (olderHead) {
        // The exact older admission implementation observed at the FIFO head.
        const historicalTree = legacyGateTree(f.dir, "36b68a986862c5391cadf0c8c162aeea73012447");
        for (const entry of ["cpu-admission.ts", "gate-slot.sh"]) {
          const target = path.join(first.writablePath("scripts"), entry);
          fs.unlinkSync(target);
          fs.symlinkSync(path.join(historicalTree, "scripts", entry), target);
        }
      }
      for (const publication of [first, peer]) {
        if (!useService) fs.writeFileSync(publication.writablePath("shims/systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        fs.mkdirSync(publication.writablePath("scripts/gate-runner"));
        if (olderHead) stubOlderPublicationChecks(publication);
      }
      fs.appendFileSync(first.writablePath("record.ts"), `\nif (process.argv[2] === "tsc") {
        const fs = require("node:fs");
        fs.writeFileSync(${JSON.stringify(started)}, "started");
        while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
      }\n`);
      commitFixtureInputs(first);
      if (!useService) commitFixtureInputs(peer);
      // Start the first hook immediately after a prior grant. Its cleanup
      // runner and original hook are both live before the first queue open.
      const previous = Date.now() - (firstOpen ? 0 : CPU_QUEUE_SPACING_MS);
      f.db.query("UPDATE admission SET last = ?").run(previous);
      f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
      if (firstOpen) {
        // The nested gate installs the journal after the outer hook and its
        // cleanup client have already started.
        f.db.exec("DROP TRIGGER IF EXISTS legacy_gate_retired; DROP TABLE IF EXISTS legacy_gate_cutover; DROP TABLE IF EXISTS legacy_gate_retirements");
      }
      const grants = () => f.db.query("SELECT at FROM grants ORDER BY rowid").all();
      if (mixedPrepare) {
        const orphan = Bun.spawn(["bash", "-c", "read -r line"], { stdin: "pipe" });
        try {
          const owner = hostProcessIdentity(captureProcessIdentity(orphan.pid));
          f.db.query("INSERT INTO tickets (key, since, owner) VALUES (?, ?, ?)")
            .run("command:dead-head", previous, JSON.stringify(owner));
        } finally {
          orphan.stdin.end();
          await orphan.exited;
        }
      }
      const firstRun = launch(first, "first");
      await firstRun.waitFor("its first private ticket", () =>
        f.count() === 1 && (!mixedPrepare || stderr("first").includes("removed command:dead-head:")));
      const firstTicket = f.db.query<{ owner: string }, []>(`SELECT owner ${queuedTickets}`).get()!;
      if (mixedPrepare) {
        expect(stderr("first")).toContain("removed command:dead-head:");
        expect(fs.readlinkSync(path.join(signalSandboxContext()?.hostProc ?? "/proc", String(JSON.parse(firstTicket.owner).pid), "cwd"))).toBe(first.dir);
      }
      const peerRun = launch(peer, "peer");
      await peerRun.waitFor("the second private ticket", () => f.count() === 2);
      expect(last()).toBe(previous);
      expect(grants()).toEqual([]);
      expect(f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'gate_slots'").get()).toBeNull();
      expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, "llv-heavy-gate.slot1.lock"), "true"]).exitCode).toBe(0);
      if (mode === "service hooks first-open") {
        const pid = fs.readFileSync(peerRun.env.CPU_SLOT_ROOT_PID!, "utf8").trim();
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        expect(argv[1]).toContain("owned-runner.ts");
        if (!fs.existsSync("/.dockerenv") && peerRun.env.LLV_DOCKER_NSENTER_SHIMS !== "1") expect(argv).toContain("--in-cpu-scope");
        const born = Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19]);
        const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
        // Place the journal boundary on the peer's exact kernel birth tick.
        let uptime = born / ticks - 0.01;
        if ((uptime + 0.01) * ticks < born) uptime += Number.EPSILON * uptime;
        expect((uptime + 0.01) * ticks).toBeGreaterThanOrEqual(born);
        expect(Math.round((uptime + 0.01) * ticks)).toBe(born);
        f.db.query("UPDATE legacy_gate_cutover SET uptime = ?").run(uptime);
      }
      if (firstOpen) f.age();
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
