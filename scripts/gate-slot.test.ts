import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(systemd: boolean) {
  const root = mkdtempSync(join(tmpdir(), "slot-test-")); roots.push(root);
  for (const name of ["mkdir", "flock", "sleep"]) symlinkSync(`/usr/bin/${name}`, join(root, name));
  if (systemd) {
    writeFileSync(join(root, "systemctl"), "#!/bin/bash\nexit 0\n"); chmodSync(join(root, "systemctl"), 0o755);
    writeFileSync(join(root, "systemd-run"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$SLOT_LOG"\nwhile [[ "$1" != -- ]]; do shift; done\nshift\nexec "$@"\n'); chmodSync(join(root, "systemd-run"), 0o755);
  }
  const env = { ...process.env, PATH: root, LLV_GATE_LOCK_DIR: root, LLV_GATE_SLOTS: "1", SLOT_LOG: join(root, "log") };
  const run = (script: string) => spawnSync("/bin/bash", [join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", script], { env, encoding: "utf8" });
  return { root, run };
}
test("fallback without systemd preserves failure and the default heap", () => {
  const f = fixture(false); const run = f.run('echo "$NODE_OPTIONS"; exit 37');
  expect(run.status).toBe(37); expect(run.stdout).toContain("--max-old-space-size=6144");
});
test("memory scope forwards args and status", () => {
  const f = fixture(true); expect(f.run("exit 23").status).toBe(23);
  expect(readFileSync(join(f.root, "log"), "utf8")).toContain("MemoryMax=8G");
});
test("another command waits for the same legacy-compatible slot", async () => {
  const f = fixture(false);
  const env = { ...process.env, PATH: f.root, LLV_GATE_LOCK_DIR: f.root, LLV_GATE_SLOTS: "1" };
  const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", `echo held > "$LLV_GATE_LOCK_DIR/held"; /bin/sleep 0.3`], { env, stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 100 && !Bun.file(join(f.root, "held")).size; i++) await Bun.sleep(10);
  const result = spawnSync("/usr/bin/flock", ["-n", join(f.root, "llv-heavy-gate.slot1.lock"), "/bin/true"]);
  expect(result.status).toBe(1);
  expect(await child.exited).toBe(0);
});

/** A Linux fixture whose systemd records what the gate asked for. */
function cpuFixture(options: { manager: boolean; refuseQuota?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "slot-cpu-test-")); roots.push(root);
  for (const name of ["mkdir", "flock", "sleep", "awk", "uname", "cat"]) symlinkSync(`/usr/bin/${name}`, join(root, name));
  writeFileSync(join(root, "getconf"), "#!/bin/bash\necho 24\n"); chmodSync(join(root, "getconf"), 0o755);
  if (options.manager) {
    writeFileSync(join(root, "systemctl"), `#!/bin/bash\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n${options.refuseQuota ? '[[ "$2" == set-property ]] && exit 1\n' : ""}exit 0\n`);
    chmodSync(join(root, "systemctl"), 0o755);
    writeFileSync(join(root, "systemd-run"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$SLOT_LOG"\nwhile [[ "$1" != -- ]]; do shift; done\nshift\nexec "$@"\n'); chmodSync(join(root, "systemd-run"), 0o755);
  }
  const env = { ...process.env, PATH: root, LLV_GATE_LOCK_DIR: root, LLV_GATE_SLOTS: "1", SLOT_LOG: join(root, "log"), SYSTEMCTL_LOG: join(root, "systemctl.log"),
    DELEGATUS_AGENT_CPU: "auto", DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_PSI_FILE: join(root, "pressure"), LLV_GATE_POLL_SECONDS: "0.1" };
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
  expect(missing.run({ DELEGATUS_AGENT_CPU: "off" }).status).toBe(0);
  expect(readFileSync(missing.marker, "utf8")).toBe("run\n");
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
test.skipIf(process.platform !== "linux")("a caller already in a work scope runs its gate there when the user bus is out of reach", () => {
  const f = cpuFixture({ manager: false });
  const cgroup = join(f.root, "cgroup");
  writeFileSync(cgroup, "0::/user.slice/user-1000.slice/user@1000.service/delegatus.slice/delegatus-agents.slice/delegatus-agents-work.slice/delegatus-agent-codex-0123456789ab.scope\n");
  expect(f.run({ LLV_GATE_CGROUP_FILE: cgroup }).status).toBe(0);
  expect(readFileSync(f.marker, "utf8")).toBe("run\n");
  writeFileSync(cgroup, "0::/user.slice/user-1000.slice/user@1000.service/delegatus.slice/delegatus-agents.slice/delegatus-agent-codex-0123456789ab.scope\n");
  expect(f.run({ LLV_GATE_CGROUP_FILE: cgroup }).status).toBe(69);
});
test.skipIf(process.platform !== "linux")("the gate reads the folded LLV_ spelling an entry point leaves behind", () => {
  const f = cpuFixture({ manager: false });
  const env: NodeJS.ProcessEnv = { ...f.env };
  delete env.DELEGATUS_AGENT_CPU;
  const result = spawnSync("/bin/bash", [join(import.meta.dir, "gate-slot.sh"), "/bin/bash", "-c", f.script], { env: { ...env, LLV_AGENT_CPU: "off" }, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(spawnSync("/bin/bash", [join(import.meta.dir, "gate-slot.sh"), "/bin/true"], { env: { ...env, LLV_AGENT_CPU: "auto" }, encoding: "utf8" }).status).toBe(69);
});
