import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-logins-"));
const savedEnv = { ...process.env };
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");

const { listCodexAccounts } = await import("../codex");
const { accountsCollectionRevision } = await import("../accountsStore");
const { trackAccountLeases } = await import("../accountMutation.contention.fixture");
const { ManagedCodexRuntime, setManagedCodexRuntimeForTests } = await import("../codexRuntime");
const { reconcileAccountLogins } = await import("./controller");

afterAll(() => {
  setManagedCodexRuntimeForTests(null);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("the controller settles a device login once and then leaves the finished one alone", async () => {
  let reads = 0;
  let starts = 0;
  const client = {
    onLifecycle: () => undefined,
    onNotification: () => undefined,
    startDeviceLogin: async () => ({ loginId: "login-1", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-1234" }),
    readAccount: async () => { reads += 1; return { account: { type: "chatgpt" }, requiresOpenaiAuth: false }; },
    cancelLogin: async () => undefined,
    close: () => undefined,
  };
  const runtime = new ManagedCodexRuntime({ startClient: async () => { starts += 1; return client as never; } });
  setManagedCodexRuntimeForTests(runtime);
  const main = listCodexAccounts()[0]!;
  await runtime.retryLogin(main);

  // The cycle that meets the signed-in account settles the attempt.
  await reconcileAccountLogins();
  expect(runtime.peekLogin(main)).toMatchObject({ attemptState: "completed" });
  expect({ starts, reads }).toEqual({ starts: 1, reads: 1 });

  const settled = accountsCollectionRevision();
  const leases = trackAccountLeases();
  try {
    for (let cycle = 0; cycle < 3; cycle += 1) await reconcileAccountLogins();
  } finally {
    leases.stop();
  }
  expect({ starts, reads }).toEqual({ starts: 1, reads: 1 });
  expect(accountsCollectionRevision()).toBe(settled);
  // No "Codex login commit" for a spawn on another engine to meet.
  expect(leases.holds).toEqual([]);
});
