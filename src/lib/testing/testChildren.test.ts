import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureProcess } from "./fixtureProcess";

for (const form of ["array", "array-options", "object", "empty-env"] as const) test(`Bun ${form} spawn records ownership and supplies its runner binding before readiness`, async () => {
  const command = [process.execPath, "-e", "console.log(process.env.LLV_FIXTURE_PARENT_IDENTITY)"];
  const child = form === "array" ? Bun.spawn(command)
    : form === "array-options" ? Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
    : Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe", ...(form === "empty-env" ? { env: {} } : {}) });
  const identity = captureProcessIdentity(child.pid);
  try {
    // This read precedes every await, so late report-time registration fails.
    const ledger = fs.readFileSync(path.join(os.tmpdir(), "owned-test-children.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as ProcessIdentity);
    expect(ledger).toContainEqual(identity);
    const binding = JSON.parse(await new Response(child.stdout).text());
    expect(binding).toEqual(captureProcessIdentity(process.pid));
    expect(await child.exited).toBe(0);
  } finally {
    if (processIdentityStatus(identity) === "alive") child.kill("SIGKILL");
    await child.exited;
    expect(processIdentityStatus(identity)).toBe("dead");
  }
}, 5_000);

test.skipIf(process.platform !== "linux").each(["shutdown tail", "persistent orphan"])("kernel-owned %s finishes teardown with no survivors and preserves a bystander", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-test-teardown-"));
  const repo = path.resolve(import.meta.dir, "../../..");
  fs.writeFileSync(path.join(root, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(path.join(repo, "test-preload.ts"))}]\n`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": [path.join(repo, "src/*")] } } }));
  const report = path.join(root, "child.json");
  fs.writeFileSync(path.join(root, "example.test.ts"), `import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { captureProcessIdentity } from ${JSON.stringify(path.join(repo, "src/lib/processIdentity.ts"))};
const result = spawnSync("/bin/sh", ["-c", "/bin/sleep ${mode === "shutdown tail" ? "0.3" : "300"} >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(captureProcessIdentity(Number(result.stdout.trim()))));
test("native helper", () => {});`);
  const bystander = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  const other = captureProcessIdentity(bystander.pid!);
  const child = Bun.spawn([process.execPath, path.join(repo, "scripts/owned-runner.ts"), process.execPath, "test", "./example.test.ts"], {
    cwd: root, env: { ...process.env, LLV_OWNED_RUN_TIMEOUT_MS: "8000" }, stdout: "pipe", stderr: "pipe",
  });
  const identity = captureProcessIdentity(child.pid);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try {
    const output = new Response(child.stderr).text();
    const code = await child.exited;
    const diagnostic = await output;
    if (!fs.existsSync(report)) throw new Error(diagnostic);
    const helper = JSON.parse(fs.readFileSync(report, "utf8")) as ProcessIdentity;
    expect(code).toBe(mode === "shutdown tail" ? 0 : 1);
    if (mode === "persistent orphan") expect(diagnostic).toContain("owned test scope children survived teardown");
    expect(processIdentityStatus(helper)).toBe("dead");
    expect(processIdentityStatus(other)).toBe("alive");
  } finally {
    clearTimeout(deadline);
    if (processIdentityStatus(identity) === "alive") child.kill("SIGKILL");
    await child.exited;
    await stopFixtureProcess(bystander);
    expect(processIdentityStatus(identity)).toBe("dead");
    expect(processIdentityStatus(other)).toBe("dead");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
