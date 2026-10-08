import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitPortableTestRunner } from "../src/lib/testing/portableTestAdmission";

for (const platform of ["darwin", "win32"] as const) test(`portable ${platform} admission warns once and permits best-effort execution`, () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  const warnings: string[] = [];
  admitPortableTestRunner(platform, env, warning => warnings.push(warning));
  admitPortableTestRunner(platform, { ...env }, warning => warnings.push(warning));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("best effort");
  expect(warnings[0]).toContain("a detached descendant can escape between guardian polls");
  expect(env.LLV_PORTABLE_TEST_WARNING_SHOWN).toBe("1");
});

test("Linux portable admission refuses even an inherited warning marker", () => {
  const warnings: string[] = [];
  expect(() => admitPortableTestRunner("linux", { NODE_ENV: "test", LLV_PORTABLE_TEST_WARNING_SHOWN: "1" }, warning => warnings.push(warning)))
    .toThrow("require a reachable user systemd manager");
  expect(warnings).toEqual([]);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(systemd: boolean) {
  const root = mkdtempSync(join(tmpdir(), "slot-test-")); roots.push(root);
  for (const name of ["mkdir", "flock", "sleep", "dirname"]) symlinkSync(`/usr/bin/${name}`, join(root, name));
  if (systemd) {
    writeFileSync(join(root, "systemctl"), "#!/bin/bash\nexit 0\n"); chmodSync(join(root, "systemctl"), 0o755);
    writeFileSync(join(root, "systemd-run"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$SLOT_LOG"\nwhile [[ "$1" != -- ]]; do shift; done\nshift\nexec "$SLOT_BUN" "$SLOT_SERVICE_STUB" "$4"\n'); chmodSync(join(root, "systemd-run"), 0o755);
    writeFileSync(join(root, "service-stub.ts"), 'import fs from "node:fs"; const cfg = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")); const result = Bun.spawnSync(cfg.command, { cwd: cfg.cwd, env: cfg.env, stdio: ["inherit", "inherit", "inherit"] }); process.exit(result.exitCode);');
  }
  const env = { ...process.env, PATH: root, LLV_GATE_BUN: process.execPath, SLOT_BUN: process.execPath, SLOT_SERVICE_STUB: join(root, "service-stub.ts"), LLV_GATE_LOCK_DIR: root, LLV_GATE_SLOTS: "1", SLOT_LOG: join(root, "log") };
  const run = (script: string) => spawnSync("/bin/bash", [join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", script], { env, encoding: "utf8", timeout: 10_000 });
  return { root, run, env };
}
test.skipIf(process.platform !== "linux")("a Linux gate without systemd refuses to launch an uncontained command", () => {
  const f = fixture(false); const run = f.run('echo "$NODE_OPTIONS"; exit 37');
  expect(run.status).not.toBe(0); expect(run.stderr).toContain("require a reachable user systemd manager");
});
test("memory service forwards args, status and bounded tree termination", () => {
  const f = fixture(true); expect(f.run("exit 23").status).toBe(23);
  const args = readFileSync(join(f.root, "log"), "utf8");
  expect(args).toContain("MemoryMax=8G"); expect(args).toContain("KillMode=control-group"); expect(args).toContain("TimeoutStopSec=2s");
  expect(f.run('echo "$NODE_OPTIONS"').stdout).toContain("--max-old-space-size=6144");
});
test("another command waits for the same legacy-compatible slot", async () => {
  const f = fixture(true);
  const env = f.env;
  const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", `echo held > "$LLV_GATE_LOCK_DIR/held"; /bin/sleep 0.3`], { env, stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 100 && !Bun.file(join(f.root, "held")).size; i++) await Bun.sleep(10);
  const result = spawnSync("/usr/bin/flock", ["-n", join(f.root, "llv-heavy-gate.slot1.lock"), "/bin/true"]);
  expect(result.status).toBe(1);
  expect(await child.exited).toBe(0);
});

const WORK_GROUP = "/user.slice/user-1000.slice/user@1000.service/delegatus.slice/delegatus-agents.slice/delegatus-agents-work.slice";
/** A fake cgroup tree under `root`: the cgroup file names `group`, and each `cpu.max` the kernel would show. */
function fakeCgroup(root: string, group: string, controls: { scope?: string; slice?: string }) {
  const tree = join(root, "cgroup-root");
  mkdirSync(join(tree, group), { recursive: true });
  if (controls.scope) writeFileSync(join(tree, group, "cpu.max"), `${controls.scope}\n`);
  if (controls.slice) writeFileSync(join(tree, WORK_GROUP, "cpu.max"), `${controls.slice}\n`);
  writeFileSync(join(root, "cgroup"), `0::${group}\n`);
  return { LLV_GATE_CGROUP_FILE: join(root, "cgroup"), LLV_GATE_CGROUP_ROOT: tree };
}
/** A Linux fixture whose systemd records what the gate asked for. */
function cpuFixture(options: { manager: boolean; refuseQuota?: boolean; kernel?: { scope?: string; slice?: string } }) {
  const root = mkdtempSync(join(tmpdir(), "slot-cpu-test-")); roots.push(root);
  for (const name of ["mkdir", "flock", "sleep", "awk", "uname", "cat", "dirname"]) symlinkSync(`/usr/bin/${name}`, join(root, name));
  writeFileSync(join(root, "getconf"), "#!/bin/bash\necho 24\n"); chmodSync(join(root, "getconf"), 0o755);
  if (options.manager) {
    writeFileSync(join(root, "systemctl"), `#!/bin/bash\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n${options.refuseQuota ? '[[ "$2" == set-property ]] && exit 1\n' : ""}exit 0\n`);
    chmodSync(join(root, "systemctl"), 0o755);
    writeFileSync(join(root, "systemd-run"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$SLOT_LOG"\nwhile [[ "$1" != -- ]]; do shift; done\nshift\nexec "$SLOT_BUN" "$SLOT_SERVICE_STUB" "$4"\n'); chmodSync(join(root, "systemd-run"), 0o755);
    writeFileSync(join(root, "service-stub.ts"), 'import fs from "node:fs"; const cfg = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")); const result = Bun.spawnSync(cfg.command, { cwd: cfg.cwd, env: cfg.env, stdio: ["inherit", "inherit", "inherit"] }); process.exit(result.exitCode);');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: root, LLV_GATE_BUN: process.execPath, SLOT_BUN: process.execPath, SLOT_SERVICE_STUB: join(root, "service-stub.ts"), LLV_GATE_LOCK_DIR: root, LLV_GATE_SLOTS: "1", SLOT_LOG: join(root, "log"), SYSTEMCTL_LOG: join(root, "systemctl.log"),
    DELEGATUS_AGENT_CPU: "auto", DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_PSI_FILE: join(root, "pressure"), LLV_GATE_POLL_SECONDS: "0.1",
    // The test run itself may sit in a work scope (a hook's gate); judge a fixture cgroup instead.
    LLV_GATE_CGROUP_FILE: join(root, "no-cgroup") };
  // The fake systemd-run execs in place, so the scope's check reads the cgroup a real scope would get.
  if (options.manager) Object.assign(env, fakeCgroup(root, `${WORK_GROUP}/run-fixture.scope`, options.kernel ?? { scope: "60000 20000", slice: "360000 20000" }));
  // Inherited gate and CPU settings (a hook's own gate) must not steer the fixture.
  for (const key of Object.keys(env)) if (/^(?:LLV|DELEGATUS)_(?:GATE_SLICE|GATE_PSI_|WORK_|CPU_PRESSURE_)/.test(key)) delete env[key];
  env.LLV_GATE_PSI_FILE = join(root, "pressure"); env.LLV_GATE_POLL_SECONDS = "0.1";
  const marker = join(root, "ran");
  const script = `echo run >> "${marker}"`;
  return { root, env, marker, script, run: (extra: Record<string, string> = {}) => spawnSync("/bin/bash", [join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", script], { env: { ...env, ...extra }, encoding: "utf8" }) };
}
test.skipIf(process.platform !== "linux")("a gate runs in the work slice with the shared quotas and keeps its memory cap", () => {
  const f = cpuFixture({ manager: true });
  expect(f.run().status).toBe(0);
  const args = readFileSync(join(f.root, "log"), "utf8").trim().split("\n");
  expect(args).toContain("--slice=delegatus-agents-work.slice");
  for (const property of ["MemoryMax=8G", "CPUWeight=100", "CPUQuota=300%", "CPUQuotaPeriodSec=20ms"]) expect(args[args.indexOf(property) - 1]).toBe("-p");
  expect(readFileSync(join(f.root, "systemctl.log"), "utf8")).toContain("--user set-property --runtime delegatus-agents-work.slice CPUWeight=100 CPUQuota=1800% CPUQuotaPeriodSec=20ms");
  expect(readFileSync(f.marker, "utf8")).toBe("run\n");
});
test.skipIf(process.platform !== "linux")("a missing CPU mechanism is an explicit admission failure; off opts out", () => {
  const missing = cpuFixture({ manager: false });
  const refused = missing.run();
  expect(refused.status).toBe(69);
  expect(refused.stderr).toContain("gate-slot: CPU containment for gates is unavailable: no reachable systemd user manager. Set DELEGATUS_AGENT_CPU=off");
  expect(Bun.file(missing.marker).size).toBe(0);
  const quota = cpuFixture({ manager: true, refuseQuota: true });
  expect(quota.run().stderr).toContain("the user manager refused the quota for delegatus-agents-work.slice");
  expect(Bun.file(quota.marker).size).toBe(0);
  const optedOut = missing.run({ DELEGATUS_AGENT_CPU: "off" });
  expect(optedOut.status).not.toBe(0);
  expect(optedOut.stderr).toContain("require a reachable user systemd manager");
  expect(Bun.file(missing.marker).size).toBe(0);
});
test.skipIf(process.platform !== "linux")("CPU pressure holds a gate visibly, then starts it once after the release window", async () => {
  const f = cpuFixture({ manager: true });
  writeFileSync(join(f.root, "pressure"), "some avg10=55.00 avg60=40.00 avg300=20.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", f.script],
    { env: { ...f.env, DELEGATUS_CPU_PRESSURE: "on", LLV_GATE_PSI_RELEASE_SECONDS: "1", LLV_GATE_PSI_DEFER_SECONDS: "1" }, stdout: "ignore", stderr: "pipe" });
  await Bun.sleep(1_500);
  expect(Bun.file(f.marker).size).toBe(0);
  writeFileSync(join(f.root, "pressure"), "some avg10=12.00 avg60=40.00 avg300=20.00 total=1\n");
  await Bun.sleep(1_200);
  expect(Bun.file(f.marker).size).toBe(0); // between the thresholds the hold stays
  writeFileSync(join(f.root, "pressure"), "some avg10=2.00 avg60=30.00 avg300=20.00 total=1\n");
  expect(await child.exited).toBe(0);
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toContain("gate-slot: held for CPU pressure: avg10 55.00% >= 20%; starts once it stays below 10% for 1s");
  expect(stderr).toContain("gate-slot: deferred by CPU pressure for 1s");
  expect(stderr).toMatch(/gate-slot: admitted after \d+s of CPU pressure/);
  expect(readFileSync(f.marker, "utf8")).toBe("run\n");
}, 20_000);
test.skipIf(process.platform !== "linux")("a failed pressure sample admits; the quotas still bound the gate", () => {
  const f = cpuFixture({ manager: true });
  const result = f.run({ DELEGATUS_CPU_PRESSURE: "on" });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("held");
  expect(readFileSync(join(f.root, "log"), "utf8")).toContain("CPUQuota=300%");
});
test.skipIf(process.platform !== "linux")("a caller already in a CPU work scope still requires a child ownership manager", () => {
  const f = cpuFixture({ manager: false });
  const scope = `${WORK_GROUP}/delegatus-agent-codex-0123456789ab.scope`;
  const result = f.run(fakeCgroup(f.root, scope, { scope: "60000 20000", slice: "360000 20000" }));
  expect(result.status).toBe(69);
  expect(result.stderr).toContain("no reachable systemd user manager");
  expect(Bun.file(f.marker).size).toBe(0);
});
test.skipIf(process.platform !== "linux")("a scope the kernel gives no CPU controls refuses the gate before its command runs", () => {
  // systemd accepts the properties when an ancestor disables the cpu controller; the scope then has no cpu.max.
  for (const kernel of [{}, { scope: "max 20000", slice: "360000 20000" }, { scope: "60000 20000" }]) {
    const f = cpuFixture({ manager: true, kernel });
    const result = f.run();
    expect(result.status).toBe(69);
    expect(result.stderr).toContain("gate-slot: CPU containment for gates is unavailable: the kernel applied no CPU quota to");
    expect(result.stderr).toContain("the cpu controller is off on an ancestor");
    expect(Bun.file(f.marker).size).toBe(0);
  }
});
test.skipIf(process.platform !== "linux")("the gate reads the folded LLV_ spelling an entry point leaves behind", () => {
  const f = cpuFixture({ manager: false });
  const env: NodeJS.ProcessEnv = { ...f.env };
  delete env.DELEGATUS_AGENT_CPU;
  const result = spawnSync("/bin/bash", [join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", f.script], { env: { ...env, LLV_AGENT_CPU: "off" }, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("require a reachable user systemd manager");
  expect(spawnSync("/bin/bash", [join(import.meta.dir, "gate-slot.sh"), "/bin/true"], { env: { ...env, LLV_AGENT_CPU: "auto" }, encoding: "utf8" }).status).toBe(69);
});
test.skipIf(process.platform !== "linux")("pressure that rises while a gate waits for a slot holds it; it starts once after the release window", async () => {
  const f = cpuFixture({ manager: true });
  const pressure = join(f.root, "pressure");
  writeFileSync(pressure, "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n");
  // Another gate holds the only slot.
  const holder = Bun.spawn(["/bin/bash", "-c", 'exec 9>"$1"; /usr/bin/flock 9; exec /usr/bin/sleep 30', "_", join(f.root, "llv-heavy-gate.slot1.lock")], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100 && spawnSync("/usr/bin/flock", ["-n", join(f.root, "llv-heavy-gate.slot1.lock"), "/bin/true"]).status === 0; i++) await Bun.sleep(10);
  const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", f.script],
    { env: { ...f.env, DELEGATUS_CPU_PRESSURE: "on", LLV_GATE_PSI_RELEASE_SECONDS: "1" }, stdout: "ignore", stderr: "pipe" });
  await Bun.sleep(500);
  writeFileSync(pressure, "some avg10=80.00 avg60=40.00 avg300=20.00 total=1\n");
  await Bun.sleep(300);
  holder.kill(); await holder.exited;
  await Bun.sleep(1_000);
  expect(Bun.file(f.marker).size).toBe(0); // the slot is free and the pressure is high
  // A held gate occupies no slot.
  expect(spawnSync("/usr/bin/flock", ["-n", join(f.root, "llv-heavy-gate.slot1.lock"), "/bin/true"]).status).toBe(0);
  writeFileSync(pressure, "some avg10=2.00 avg60=30.00 avg300=20.00 total=1\n");
  expect(await child.exited).toBe(0);
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toContain("gate-slot: held for CPU pressure: avg10 80.00% >= 20%");
  expect(stderr).toMatch(/gate-slot: admitted after \d+s of CPU pressure/);
  expect(readFileSync(f.marker, "utf8")).toBe("run\n");
}, 20_000);
// The work slice's ceiling is one machine-wide value: a caller pinned to fewer
// CPUs (a service under AllowedCPUs=0-5) sets the same quota a gate does.
const onlineCpus = Number(spawnSync("getconf", ["_NPROCESSORS_ONLN"], { encoding: "utf8" }).stdout.trim());
// The first CPU this process may use: a cpuset (a work slice under AllowedCPUs=6-23) can leave CPU 0 out.
const allowedCpu = (() => { try { return /^Cpus_allowed_list:\s*(\d+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1]; } catch { return undefined; } })();
test.skipIf(process.platform !== "linux" || !Bun.which("taskset") || !allowedCpu || !(onlineCpus > 1))("runtime, installer and gate set one aggregate quota under a narrowed CPU affinity", () => {
  const pinned = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(Bun.which("taskset")!, ["-c", allowedCpu!, ...args], { env, encoding: "utf8" });
  const expected = `CPUQuota=${Math.floor(onlineCpus * 0.75) * 100}%`;
  const quietEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: tmpdir(), NODE_ENV: "test" };
  const affinity = pinned([process.execPath, "-e", `const os = require("node:os"); const fs = require("node:fs");
console.log(os.availableParallelism(), /^Cpus_allowed_list:\\s*(\\S+)/m.exec(fs.readFileSync("/proc/self/status", "utf8"))[1])`], quietEnv);
  expect([affinity.stderr, affinity.stdout.trim()]).toEqual(["", `1 ${allowedCpu}`]);
  const runtime = pinned([process.execPath, "-e", `const { cpuSettings, workSliceProperties } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/runtime/cpuPlacement.ts"))});
console.log(workSliceProperties(cpuSettings({}).aggregateQuotaPercent).join(" "))`], quietEnv);
  expect(runtime.stderr).toBe("");
  expect(runtime.stdout).toContain(expected);
  const f = cpuFixture({ manager: true });
  const dir = join(f.root, "units");
  expect(pinned([process.execPath, join(import.meta.dir, "../bin/install-cpu-placement.mjs"), "--dir", dir], quietEnv).status).toBe(0);
  expect(readFileSync(join(dir, "delegatus-agents-work.slice"), "utf8")).toContain(`${expected}\n`);
  rmSync(join(f.root, "getconf")); symlinkSync(Bun.which("getconf")!, join(f.root, "getconf"));
  expect(pinned(["/bin/bash", join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", f.script], f.env).status).toBe(0);
  expect(readFileSync(join(f.root, "systemctl.log"), "utf8")).toContain(` ${expected} `);
});
