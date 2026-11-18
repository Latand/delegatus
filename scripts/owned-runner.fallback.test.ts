import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { captureProcessIdentity, processIdentityStatus } from "../src/lib/processIdentity";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { portableFixture } from "./owned-runner.integration.fixture";

for (const manager of ["missing", "unreachable"] as const) for (const entry of ["direct", "runner", "gate"] as const) {
  test.skipIf(process.platform !== "linux")(`Linux portable ${entry} admits a private test with ${manager} systemd`, async () => {
    const { root, env, repo } = portableFixture(manager);
    const report = path.join(root, "report.json");
    fs.writeFileSync(path.join(root, "example.test.ts"), `import { expect, test } from "bun:test";
import fs from "node:fs"; import os from "node:os";
test("portable admission", () => {
  expect(Number(process.env.LLV_PORTABLE_TEST_RUNNER_PID)).toBe(process.pid);
  expect(process.env.LLV_OWNED_TEST_RUN_CGROUP).toBeUndefined();
  expect(process.env.HOME).not.toBe(${JSON.stringify(env.HOME)});
  expect(process.env.LLV_STATE_DIR).not.toBe(${JSON.stringify(env.LLV_STATE_DIR)});
  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ root: os.tmpdir(), home: process.env.HOME, state: process.env.LLV_STATE_DIR }));
});`);
    // A portable child must drop the native parent's admission even when the
    // launch environment carries it. Direct tests still validate native tokens.
    if (entry !== "direct") Object.assign(env, { LLV_OWNED_TEST_RUNNER_PID: process.env.LLV_OWNED_TEST_RUNNER_PID, LLV_OWNED_TEST_RUN_CGROUP: process.env.LLV_OWNED_TEST_RUN_CGROUP });
    const command = [process.execPath, "test", "./example.test.ts"];
    const argv = entry === "direct" ? command : entry === "runner"
      ? [process.execPath, path.join(repo, "scripts/owned-runner.ts"), ...command]
      : ["/bin/bash", path.join(repo, "scripts/gate-slot.sh"), ...command];
    const child = spawn(argv[0]!, argv.slice(1), { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = ""; child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
    try {
      const code = await new Promise(resolve => { child.once("exit", resolve); child.once("error", () => resolve(-1)); });
      expect(code, diagnostic).toBe(0);
      expect(diagnostic.match(/portable cleanup on linux is best effort/g)).toHaveLength(1);
      const recorded = JSON.parse(fs.readFileSync(report, "utf8"));
      for (const directory of Object.values(recorded)) expect(fs.existsSync(directory as string)).toBe(false);
    } finally { await stopFixtureProcess(child); fs.rmSync(root, { recursive: true, force: true }); }
  }, 20000);
}

test.skipIf(process.platform !== "linux")("Linux portable admission refuses an unverifiable supervisor before launch", async () => {
  const { root, env, repo } = portableFixture("unreachable");
  const bystander = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  const identity = captureProcessIdentity(bystander.pid!);
  const marker = path.join(root, "ran");
  env.LLV_OWNED_RUN_PARENT_IDENTITY = JSON.stringify({ ...identity, startIdentity: "unmatched-start" });
  const runner = spawn(process.execPath, [path.join(repo, "scripts/owned-runner.ts"), process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], { cwd: root, env, stdio: "ignore" });
  try {
    const code = await new Promise(resolve => { runner.once("exit", resolve); runner.once("error", () => resolve(-1)); });
    expect(code).toBe(137);
    expect(fs.existsSync(marker)).toBe(false);
    expect(processIdentityStatus(identity)).toBe("alive");
  } finally { await stopFixtureProcess(runner); await stopFixtureProcess(bystander); fs.rmSync(root, { recursive: true, force: true }); }
}, 15000);
