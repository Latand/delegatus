import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { GATE_TASKS_MAX, GATE_TASK_LIMIT_EXIT } from "./gate-tasks";

const manager = process.platform === "linux" && Bun.which("python3") && Bun.which("systemd-run")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status === 0;
const controller = process.platform === "linux" && fs.readFileSync("/proc/self/cgroup", "utf8").split("\n")
  .some(line => line.startsWith("0::") && fs.existsSync(path.join("/sys/fs/cgroup", line.slice(3), "pids.max")));
const roots: string[] = [], children: ChildProcess[] = [];
const peakLine = (denied: boolean) => new RegExp(
  `pids\\.peak=(\\d+)(?: \\(sampled lower bound\\))? pids\\.max=${GATE_TASKS_MAX} pids\\.events:max=${denied ? "[1-9]\\d*" : "0"}`,
);
function expectPeak(output: string, denied: boolean) {
  const match = output.match(peakLine(denied));
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThan(0);
  expect(Number(match![1])).toBeLessThanOrEqual(GATE_TASKS_MAX);
}
afterEach(async () => {
  for (const child of children.splice(0).reverse()) await stopFixtureProcess(child);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-task-control-")); roots.push(root);
  const env = withoutInheritedGate({ ...process.env }, { keepSandbox: true });
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { LLV_GATE_RUNNER: "off", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", DELEGATUS_AGENT_CPU: "off", LLV_OWNED_RUN_TIMEOUT_MS: "10000" });
  const start = (command: string[]) => {
    const child = spawn(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), ...command], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { output += String(chunk); });
    const done = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    return { child, done, output: () => output };
  };
  return { root, env, start };
}
async function until(check: () => boolean) {
  const until = performance.now() + 5_000;
  while (!check()) { if (performance.now() > until) throw new Error("bounded readiness wait expired"); await Bun.sleep(20); }
}

test.skipIf(!manager || !controller)("real gate reads back TasksMax and reports the kernel peak on success", async () => {
  const f = fixture();
  const run = f.start([process.execPath, "-e", 'console.log("ready");']);
  expect(await run.done, run.output()).toBe(0);
  expectPeak(run.output(), false);
});

for (const mode of ["live saturation", "immediate successful exit", "stopped supervisor"] as const) test.skipIf(!manager || !controller)(`bounded fork fixture gets a named failure on ${mode}, preserving another gate`, async () => {
  const f = fixture();
  const tick = path.join(f.root, "tick");
  const neighbour = f.start([process.execPath, "-e", 'const file = process.argv[1]; let n=0; setInterval(()=>require("fs").writeFileSync(file,String(++n)),20);', tick]);
  await until(() => fs.existsSync(tick));
  const before = Number(fs.readFileSync(tick, "utf8"));
  const started = performance.now();
  const run = f.start(["python3", path.join(import.meta.dir, "fixtures/gateForkStorm.py"),
    ...(mode === "immediate successful exit" ? ["--exit-on-denial"] : mode === "stopped supervisor" ? ["--stop-supervisor"] : [])]);
  expect(await run.done, run.output()).toBe(GATE_TASK_LIMIT_EXIT);
  expect(performance.now() - started).toBeLessThan(8_000);
  expect(run.output()).toMatch(/GATE_TASK_LIMIT_REACHED: task limit reached in delegatus-gate-[a-f0-9-]+\.service/);
  expect(run.output()).toMatch(new RegExp(`GATE_TASK_LIMIT_REACHED: task limit reached in delegatus-gate-[a-f0-9-]+\\.service \\(pids\\.max=${GATE_TASKS_MAX}, pids\\.events:max=[1-9]\\d*\\)`));
  expectPeak(run.output(), true);
  expect(neighbour.child.exitCode).toBeNull();
  await until(() => Number(fs.readFileSync(tick, "utf8")) > before);
}, 20_000);

test.skipIf(!Bun.which("python3"))("fork fixture refuses without verified limited-unit admission", () => {
  const result = spawnSync("python3", [path.join(import.meta.dir, "fixtures/gateForkStorm.py")], {
    env: { ...process.env, LLV_OWNED_TEST_RUN_CGROUP: "invalid" }, encoding: "utf8", timeout: 2_000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/refuses to fork outside|no verified gate admission/);
  expect(result.stdout).toBe("");
});

test.skipIf(!manager)("a refused transient-unit launch names the unit and retains its exit status", async () => {
  const f = fixture(), bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemd-run"), "#!/bin/sh\nexit 73\n", { mode: 0o700 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const run = f.start(["/bin/true"]);
  expect(await run.done, run.output()).toBe(73);
  expect(run.output()).toMatch(/GATE_UNIT_START_FAILED: delegatus-gate-[a-f0-9-]+\.service/);
  expect(run.output()).toContain("systemd-run exited 73");
});

test.skipIf(!manager || !controller)("a unit with the wrong kernel limit refuses before starting its command", async () => {
  const f = fixture(), bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  const runner = "'" + Bun.which("systemd-run")!.replaceAll("'", "'\"'\"'") + "'";
  fs.writeFileSync(path.join(bin, "systemd-run"), `#!/bin/bash\nargs=()\nfor arg in "$@"; do\n  [[ $arg == -- ]] && args+=(-p TasksMax=${GATE_TASKS_MAX + 1})\n  args+=("$arg")\ndone\nexec ${runner} "\${args[@]}"\n`, { mode: 0o700 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const marker = path.join(f.root, "command-started");
  const run = f.start([process.execPath, "-e", 'require("fs").writeFileSync(process.argv[1],"ran")', marker]);
  expect(await run.done, run.output()).toBe(69);
  expect(run.output()).toContain("GATE_TASK_LIMIT_UNAVAILABLE:");
  expect(run.output()).toContain(`kernel pids.max=${GATE_TASKS_MAX + 1}`);
  expect(fs.existsSync(marker)).toBe(false);
});
