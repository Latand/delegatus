import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { ownFixtureTree, stopFixtureIdentity, stopFixtureTree } from "@/lib/testing/fixtureProcess";
import { reviewSetupRecipe } from "@/lib/projects/setupRecipe";
import { executeSetupRecipe } from "./setupExecution";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-execution-"));
const checkout = path.join(root, "checkout"); fs.mkdirSync(checkout);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const isolationRefusal = /bwrap: (?:not found|No such file or directory|setting up uid map: Permission denied|loopback: Failed RTM_NEWADDR: Operation not permitted|Creating new namespace failed: Operation not permitted)|FileNotFoundError: .*'bwrap'|setup isolation could not start; no command was run/;

test("the real process runs immutable reviewed bytes with isolated state, home, credentials and filesystem", async () => {
  const sentinel = path.join(root, "operator-state"); fs.writeFileSync(sentinel, "preserved");
  // The parent-death helper runs before filesystem isolation. Python must not
  // import a checkout's modules while establishing that boundary.
  fs.writeFileSync(path.join(checkout, "ctypes.py"), `open(${JSON.stringify(sentinel)}, "w").write("unreviewed import")\n`);
  fs.writeFileSync(path.join(checkout, "setup.sh"), `test -z "$SETUP_TEST_SECRET" || exit 11
test "$HOME" != ${JSON.stringify(process.env.HOME)} || exit 12
test -n "$LLV_STATE_DIR" || exit 13
printf private > "$HOME/created"
printf changed > ${JSON.stringify(sentinel)} 2>/dev/null || true
printf ready > setup-created
printf reviewed
`);
  const recipe = await reviewSetupRecipe(checkout, { command: ["sh", "setup.sh"], cwd: "." });
  // Replacing the live file between review and actual exec cannot change execution.
  fs.writeFileSync(path.join(checkout, "setup.sh"), "echo unreviewed; exit 19\n");
  const previous = process.env.SETUP_TEST_SECRET;
  process.env.SETUP_TEST_SECRET = String(7);
  try {
    if (process.platform !== "linux") {
      await expect(executeSetupRecipe(checkout, recipe, "restricted")).rejects.toThrow("requires Linux");
      expect(fs.existsSync(path.join(checkout, "setup-created"))).toBe(false);
      return;
    }
    const result = await executeSetupRecipe(checkout, recipe, "restricted");
    if (process.env.SETUP_REQUIRE_ISOLATION === "1") expect(result.code).toBe(0);
    if (result.code === 0) {
      expect(result.stdout).toBe("reviewed");
      expect(fs.readFileSync(path.join(checkout, "setup-created"), "utf8")).toBe("ready");
    } else {
      expect(result.stderr).toMatch(isolationRefusal);
      expect(fs.existsSync(path.join(checkout, "setup-created"))).toBe(false);
    }
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserved");
  } finally {
    if (previous === undefined) delete process.env.SETUP_TEST_SECRET; else process.env.SETUP_TEST_SECRET = previous;
  }
});

test("an aborted real launch cannot produce setup effects", async () => {
  fs.writeFileSync(path.join(checkout, "cancel.sh"), "printf wrong > cancelled-effect\n");
  const recipe = await reviewSetupRecipe(checkout, { command: ["sh", "cancel.sh"], cwd: "." });
  const abort = new AbortController(); abort.abort();
  const result = await executeSetupRecipe(checkout, recipe, "full", abort.signal);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("cancelled");
  expect(fs.existsSync(path.join(checkout, "cancelled-effect"))).toBe(false);
});

test.skipIf(process.platform !== "linux")("losing the real setup owner ends its detached descendants", async () => {
  const marker = path.join(checkout, "owner-ready");
  fs.writeFileSync(path.join(checkout, "owner.sh"), "setsid sleep 30 &\nprintf ready > owner-ready\nwait\n");
  const source = `import { reviewSetupRecipe } from ${JSON.stringify(path.resolve("src/lib/projects/setupRecipe.ts"))};
    import { executeSetupRecipe } from ${JSON.stringify(path.resolve("src/lib/pipelines/setupExecution.ts"))};
    const root=process.env.SETUP_CHECKOUT;
    const recipe=await reviewSetupRecipe(root,{command:['sh','owner.sh'],cwd:'.'});
    console.log(JSON.stringify(await executeSetupRecipe(root,recipe,'restricted')));`;
  const child = ownFixtureTree(spawn(process.execPath, ["-e", source], { env: { ...process.env, SETUP_CHECKOUT: checkout,
    LLV_AGENT_CPU: "off", DELEGATUS_AGENT_CPU: "off", LLV_AGENT_MEMORY: "watchdog", DELEGATUS_AGENT_MEMORY: "watchdog" }, stdio: ["ignore", "pipe", "pipe"] }));
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const ended = new Promise<void>(resolve => child.once("close", () => resolve()));
  let owned: ProcessIdentity[] = [];
  try {
    const readyBy = Date.now() + 10_000;
    while (!fs.existsSync(marker) && child.exitCode === null && child.signalCode === null && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 10));
    if (!fs.existsSync(marker)) {
      expect(process.env.SETUP_REQUIRE_ISOLATION).not.toBe("1");
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await ended;
      expect(output).toMatch(isolationRefusal);
      return;
    }
    owned = descendantPids(child.pid!, procBackend.ppidMap()).filter(pid => pid !== child.pid).map(pid => captureProcessIdentity(pid));
    expect(owned.length).toBeGreaterThan(0);
    child.kill("SIGKILL"); await ended;
    const alive = () => owned.filter(identity => processIdentityStatus(identity) !== "dead" && !procBackend.processExited(identity.pid));
    const reapedBy = Date.now() + 5_000;
    while (alive().length && Date.now() < reapedBy) await new Promise(resolve => setTimeout(resolve, 10));
    expect(alive()).toEqual([]);
  } finally {
    await stopFixtureTree(child);
    for (const identity of owned) await stopFixtureIdentity(identity);
  }
});
