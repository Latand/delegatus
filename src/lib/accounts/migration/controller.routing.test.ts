import os from "node:os";
import path from "node:path";
import { afterAll, expect, test, spyOn } from "bun:test";
import fs from "node:fs";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-contention-"));
const savedEnv = { ...process.env };
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { statePath } = await import("@/lib/configDir");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { createManagedClaudeAccount, activeClaudeAccountId } = await import("../claude");
const credentials = await import("../claudeCredentials");
const { trackAccountLeases } = await import("../accountMutation.contention.fixture");
const { withAccountMutationLockAsync } = await import("../accountMutation");
const { syncCompatibilityRouting } = await import("./controller");

test("routing sync never queries credentials while holding admission", async () => {
  const account = createManagedClaudeAccount("Routing target");
  const registry = new AgentRegistry(statePath("routing-registry.json"));
  registry.setEngineRouting("claude", account.id);
  const conversation = registry.ensureConversation("codex", "/fixture/routing.jsonl", "default");
  const lock = statePath("account-selection.lock");
  let heldMs = 0;
  const read = spyOn(credentials, "readClaudeCredentials").mockImplementation(() => {
    const held = fs.existsSync(lock);
    const start = performance.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    if (held) heldMs += performance.now() - start;
    return { state: "absent" };
  });
  const leases = trackAccountLeases();
  const started = performance.now();
  let timerDelay = 0;
  const timer = new Promise<void>((resolve) => setTimeout(() => { timerDelay = performance.now() - started; resolve(); }, 0));
  try {
    const admissions = Promise.resolve().then(() => Promise.all([
      registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", conversationId: conversation.id, purpose: "resume-successor", origin: { kind: "successor" }, launchProfile: { title: "Routing resume" } }),
      withAccountMutationLockAsync(() => registry.holdDelivery(conversation.id, "hello", "routing-send"), { caller: "send" }),
      registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Routing spawn" } }),
    ]));
    // Sync runs synchronously before the queued async admissions acquire.
    await syncCompatibilityRouting(registry);
    const [resume, send, spawn] = await admissions;
    await timer;
    expect(resume).toMatchObject({ kind: "created" });
    expect(send).toHaveProperty("id");
    expect(spawn).toMatchObject({ kind: "created" });
    expect(timerDelay).toBeLessThan(250);
    console.info(JSON.stringify({ measurement: "routing-credential-hold", heldMs }));
    expect(heldMs).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(Math.max(...leases.holds)).toBeLessThan(250);
    expect(activeClaudeAccountId()).toBe(account.id);
  } finally {
    await timer;
    leases.stop(); read.mockRestore();
    console.info(JSON.stringify({ measurement: "routing-sync", maxHoldMs: Math.max(...leases.holds), timerDelay }));
  }
});
