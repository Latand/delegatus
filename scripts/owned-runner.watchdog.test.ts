import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { signalFixtureIdentity, stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";

async function watchdogUntil(check: () => boolean, failure: () => string, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await Bun.sleep(20);
  }
}

type WatchdogMode = "slow" | "transient" | "renew" | "refused" | "missing" | "hung" | "command-exit" | "command-124" | "TERM" | "INT" | "deadline" | "guard-deadline" | "guard-deadline-test";
async function probeWatchdog(mode: WatchdogMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-watchdog-"));
  const env = withoutInheritedGate({ ...process.env });
  for (const [key, directory] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", TMPDIR: "tmp", LLV_STATE_DIR: "state" })) {
    env[key] = path.join(root, directory); fs.mkdirSync(env[key]!);
  }
  env.LLV_OWNED_RUN_TIMEOUT_MS = mode === "deadline" ? "1000" : "45000";
  env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const attempts = path.join(root, "attempts.jsonl"), delivered = path.join(root, "delivered"), ready = path.join(root, "ready.json");
  const survivor = path.join(root, "child.json");
  const notifier = Bun.which("systemd-notify")!;
  // The real service and manager remain in use. Only this fixture's notifier
  // transport delays or refuses a delivery; successful attempts reach systemd.
  fs.writeFileSync(path.join(bin, "systemd-notify"), `#!${process.execPath}
import fs from "node:fs";
import { captureProcessIdentity } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/lib/processIdentity.ts"))};
const file = ${JSON.stringify(attempts)};
const count = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(file, JSON.stringify({ ...captureProcessIdentity(process.pid), service: captureProcessIdentity(process.ppid) }) + "\\n");
if (${JSON.stringify(mode)} === "refused" || (${JSON.stringify(mode)} === "transient" && count === 0)) process.exit(17);
if (["hung", "command-exit", "command-124", "TERM", "INT", "deadline", "guard-deadline", "guard-deadline-test"].includes(${JSON.stringify(mode)})) await new Promise(() => setInterval(() => {}, 1000));
if (${JSON.stringify(mode)} === "slow" && count === 0) await Bun.sleep(3000);
const child = Bun.spawn([${JSON.stringify(notifier)}, ...process.argv.slice(2)], { stdout: "ignore", stderr: "ignore" });
const code = await child.exited;
if (code === 0) fs.writeFileSync(${JSON.stringify(delivered)}, String(count + 1));
process.exit(code);
`, { mode: 0o700 });
  if (mode === "missing") {
    fs.unlinkSync(path.join(bin, "systemd-notify"));
    for (const name of ["systemctl", "systemd-run"]) fs.symlinkSync(Bun.which(name)!, path.join(bin, name));
    env.PATH = bin;
  } else env.PATH = `${bin}:${env.PATH}`;
  const admittedTest = mode === "guard-deadline-test";
  const command = `import fs from "node:fs";
import { captureProcessIdentity } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/lib/processIdentity.ts"))};
if (process.env.LLV_OWNED_RUN_DEADLINE_FILE) throw new Error("owned deadline control reached the command");
${admittedTest ? `import { test } from "bun:test";
test("a running test with an owned child", async () => {
  if (!process.env.LLV_CHECK_ENTRY_SUPERVISOR) throw new Error("test did not enter its admission supervisor");
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  fs.writeFileSync(${JSON.stringify(survivor)}, JSON.stringify(captureProcessIdentity(child.pid)));` : ""}
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify(captureProcessIdentity(process.pid)));
while (!fs.existsSync(${JSON.stringify(mode === "command-exit" || mode === "command-124" ? attempts : delivered)})
  || (${mode === "renew"} && Number(fs.readFileSync(${JSON.stringify(delivered)}, "utf8")) < 4)) await Bun.sleep(20);
${mode === "command-124" ? `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
fs.writeFileSync(${JSON.stringify(survivor)}, JSON.stringify(captureProcessIdentity(child.pid)));
process.exit(124);` : ""}
${admittedTest ? "}, 60_000);" : ""}
`;
  const guardDeadline = mode === "guard-deadline" || admittedTest;
  const budgetArgs = guardDeadline ? ["--owned-budget", "6000"] : [];
  const testFile = path.join(root, "deadline.test.ts");
  if (admittedTest) fs.writeFileSync(testFile, command);
  const commandArgs = admittedTest ? ["test", testFile] : ["-e", command];
  const runner = spawn(process.execPath, [path.join(import.meta.dir, "owned-runner.ts"), ...budgetArgs, process.execPath, ...commandArgs], { env, stdio: ["ignore", "ignore", "pipe"] });
  let output = "";
  runner.stderr!.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { runner.once("exit", resolve); runner.once("error", reject); });
  const identities = (): ProcessIdentity[] => [
    ...(fs.existsSync(ready) ? [JSON.parse(fs.readFileSync(ready, "utf8")) as ProcessIdentity] : []),
    ...(fs.existsSync(attempts) ? fs.readFileSync(attempts, "utf8").trim().split("\n").map(line => JSON.parse(line) as ProcessIdentity) : []),
    ...(fs.existsSync(survivor) ? [JSON.parse(fs.readFileSync(survivor, "utf8")) as ProcessIdentity] : []),
  ];
  try {
    await watchdogUntil(() => fs.existsSync(ready) && (mode === "missing" || fs.existsSync(attempts)) || runner.exitCode !== null, () => output);
    expect(fs.existsSync(ready), output).toBe(true);
    if (mode === "INT") {
      const first = JSON.parse(fs.readFileSync(attempts, "utf8").trim().split("\n")[0]!) as { service: ProcessIdentity };
      expect(signalFixtureIdentity(first.service, "SIGINT")).toBe(true);
    } else if (mode === "TERM") runner.kill("SIGTERM");
    const code = await exited;
    await watchdogUntil(() => identities().every(identity => processIdentityStatus(identity) === "dead"), () => `fixture identities still alive: ${output}`);
    if (["slow", "transient", "renew", "command-exit"].includes(mode)) {
      expect(code, output).toBe(0);
      expect(output).not.toContain("surviving owned processes");
      if (mode !== "command-exit") {
        expect(fs.existsSync(delivered), output).toBe(true);
        expect(fs.readFileSync(attempts, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(mode === "renew" ? 4 : 2);
      }
    } else if (mode === "deadline" || guardDeadline || mode === "command-124") {
      expect(code, output).toBe(124);
      if (guardDeadline) {
        expect(output).toContain("owned runner: execution guard expired");
        expect(output).not.toContain("admission broker closed");
        expect(output).not.toContain("budget cleanup failed");
      }
      expect(output.includes("owned runner: surviving owned processes:")).toBe(mode === "command-124");
    } else if (["TERM", "INT"].includes(mode)) expect(code, output).toBe(mode === "INT" ? 130 : 143);
    else {
      expect(code, output).toBe(1);
      expect(output).toContain("watchdog notification failed");
      expect(output).toContain(mode === "refused" ? "exit 17" : mode === "missing" ? "ENOENT" : "SIGKILL");
      expect(fs.existsSync(delivered)).toBe(false);
    }
  } finally {
    await stopFixtureProcess(runner);
    await watchdogUntil(() => identities().every(identity => processIdentityStatus(identity) === "dead"), () => "watchdog fixture cleanup failed");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of ["slow", "transient", "renew", "refused", "missing", "hung", "command-exit", "command-124", "TERM", "INT", "deadline", "guard-deadline", "guard-deadline-test"] as const) {
  test.skipIf(process.platform !== "linux" || !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`service watchdog ${mode} retains its delivery and cleanup bounds`, async () => {
    await probeWatchdog(mode);
    // A new service must own a fresh failure window, even after a refusal.
    if (mode === "refused") await probeWatchdog("transient");
  }, 60_000);
}
