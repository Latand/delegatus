import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("wait owner passes only the caller's environment to the engine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-owner-env-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  fs.writeFileSync(path.join(root, ".env"), ["ANTHROPIC_API_KEY", "fixture-key"].join("=") + "\nUNDECLARED_PROJECT_VALUE=fixture-value\n");
  const { spawnNativeWaitOwner } = await import("./nativeWaitOwner");
  const flags = process.versions.bun ? ["--no-env-file"] : [];
  const child = spawnNativeWaitOwner(process.execPath, [...flags, "-e", `process.stdout.write(JSON.stringify({
    declared: process.env.DECLARED_VALUE,
    apiKeyPresent: "ANTHROPIC_API_KEY" in process.env,
    projectValuePresent: "UNDECLARED_PROJECT_VALUE" in process.env,
  }))`], {
    cwd: root,
    env: { NODE_ENV: "test", PATH: process.env.PATH, DECLARED_VALUE: "fixture-explicit" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`engine exited ${code}`)));
  });
  try {
    await child.spawnReady;
    child.retainExit(false);
    await closed;
    expect(JSON.parse(output)).toEqual({ declared: "fixture-explicit", apiKeyPresent: false, projectValuePresent: false });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("native exec waits until its independent waiter has durable setup custody", async () => {
  const { spawnNativeWaitOwner } = await import("./nativeWaitOwner");
  const { withStructuredSetupCustody } = await import("./structuredSetupCustody");
  const { processIdentityStatus } = await import("@/lib/processIdentity");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-owner-custody-"));
  const marker = path.join(root, "engine-started");
  let recorded = false, guards = 0;
  const child = withStructuredSetupCustody({ beforeExec: () => { guards++; }, record: identity => {
    expect(processIdentityStatus(identity)).toBe("alive");
    expect(fs.existsSync(marker)).toBe(false);
    recorded = true;
  } }, () => spawnNativeWaitOwner(process.execPath, ["--no-env-file", "-e", "require('node:fs').writeFileSync(process.argv.at(-1),'started')", "--", marker], {
    cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH },
  }));
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(Error(`exit ${code}`))); });
  try {
    await child.spawnReady;
    child.retainExit(false);
    await closed;
    expect(recorded).toBe(true);
    expect(guards).toBe(1);
    expect(fs.readFileSync(marker, "utf8")).toBe("started");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("a refused setup permit starts no engine and leaves the recorded waiter stoppable", async () => {
  const { spawnNativeWaitOwner } = await import("./nativeWaitOwner");
  const { withStructuredSetupCustody } = await import("./structuredSetupCustody");
  const { terminateStructuredHostTree } = await import("./structuredHostControl");
  const { processIdentityStatus } = await import("@/lib/processIdentity");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-owner-refusal-"));
  const marker = path.join(root, "engine-started");
  let retained: import("@/lib/processIdentity").ProcessIdentity | undefined;
  try {
    expect(() => withStructuredSetupCustody({
      beforeExec: () => { throw Error("setup authority changed"); },
      record: identity => { retained = identity; },
    }, () => spawnNativeWaitOwner(process.execPath, ["--no-env-file", "-e", "require('node:fs').writeFileSync(process.argv.at(-1),'started')", "--", marker], {
      cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH },
    }))).toThrow("setup authority changed");
    expect(retained).toBeDefined();
    const identity = retained!;
    const result = await terminateStructuredHostTree({ kind: "structured", ...identity,
      startIdentity: identity.startIdentity!, bootEpoch: identity.bootEpoch ?? null, engine: "claude", sessionId: null,
      conversationId: null, owned: false, seat: false, turnBusy: null, lastActiveAt: null });
    expect(result.ok).toBe(true);
    expect(processIdentityStatus(identity)).toBe("dead");
    expect(fs.existsSync(marker)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
