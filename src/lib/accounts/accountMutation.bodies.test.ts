import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearAccountTestState, persistedAccountRegistry, seedAccountRegistry } from "./accountsStoreFixture";
import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import { agentRegistry, closeAgentRegistryForTests } from "@/lib/agent/registry";
import * as claude from "./claude";
import * as codex from "./codex";
import * as credentials from "./claudeCredentials";
import { accountManager, selectAccount } from "./manager";
import { statePath } from "@/lib/configDir";
import { trackAccountLeases } from "./accountMutation.contention.fixture";
import { retiredAccountArchive } from "./removal";

let root: string;
let prior: NodeJS.ProcessEnv;
beforeEach(() => {
  prior = { ...process.env };
  root = fs.mkdtempSync(path.join(os.tmpdir(), "account-body-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.LLV_CLAUDE_HOME = path.join(root, "legacy-claude");
  process.env.LLV_CODEX_HOME = path.join(root, "legacy-codex");
});
afterEach(() => {
  closeAgentRegistryForTests();
  resetLegacyDocumentStoresForTests();
  clearAccountTestState(process.env.LLV_STATE_DIR!);
  process.env = prior;
  fs.rmSync(root, { recursive: true, force: true });
});

function unlockedProbe() {
  const observations: boolean[] = [];
  let admission: { exitCode: number; stderr: string } | undefined;
  return {
    observations,
    visit() {
      observations.push(fs.existsSync(statePath("account-selection.lock")));
      if (!admission) {
        // A separate process uses the same account lease while this synchronous
        // preparation is paused. Reentrancy cannot make the assertion pass.
        const child = Bun.spawnSync([process.execPath, "-e", `
          import { AgentRegistry } from "./src/lib/agent/registry";
          import { statePath } from "./src/lib/configDir";
          import { withAccountMutationLockAsync } from "./src/lib/accounts/accountMutation";
          const registry = new AgentRegistry(statePath("parallel-admission.json"), undefined, undefined, { sqliteMode: "off" });
          const conversation = registry.ensureConversation("codex", "/fixture/parallel.jsonl", "default");
          try {
            await withAccountMutationLockAsync(() => registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Parallel spawn" } }), { waitMs: 100 });
            await withAccountMutationLockAsync(() => registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", purpose: "resume-successor", conversationId: conversation.id, origin: { kind: "successor" }, launchProfile: { title: "Parallel resume" } }), { waitMs: 100 });
            await withAccountMutationLockAsync(() => registry.holdDelivery(conversation.id, "Parallel send", crypto.randomUUID()), { waitMs: 100 });
          } finally { registry.close(); }
        `], { cwd: process.cwd(), env: process.env, stdout: "ignore", stderr: "pipe", timeout: 5_000 });
        admission = { exitCode: child.exitCode, stderr: child.stderr.toString() };
      }
    },
    check() {
      expect(observations.length).toBeGreaterThan(0);
      expect(observations).not.toContain(true);
      expect(admission).toEqual({ exitCode: 0, stderr: "" });
    },
  };
}

test("Claude creation discovers credentials and copies capabilities outside the account lease", () => {
  const file = path.join(claude.legacyClaudeHome(), "skills", "sample.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "a capability");
  const probe = unlockedProbe();
  const read = credentials.readClaudeCredentials;
  const copy = fs.copyFileSync;
  const credentialSpy = spyOn(credentials, "readClaudeCredentials").mockImplementation((...args) => { probe.visit(); return read(...args); });
  const copySpy = spyOn(fs, "copyFileSync").mockImplementation((...args) => { probe.visit(); return copy(...args); });
  const leases = trackAccountLeases();
  try {
    const account = claude.createManagedClaudeAccount("New account");
    expect(claude.claudeAccountListed(account.id)).toBe(true);
    probe.check();
  } finally {
    credentialSpy.mockRestore(); copySpy.mockRestore(); leases.stop();
    console.info(JSON.stringify({ measurement: "Claude creation", maxHoldMs: Math.max(0, ...leases.holds) }));
  }
});

for (const engine of ["claude", "codex"] as const) {
  const create = engine === "claude" ? claude.createManagedClaudeAccount : codex.createManagedCodexAccount;
  const remove = engine === "claude" ? claude.removeManagedClaudeAccount : codex.removeManagedCodexAccount;
  const cleanup = engine === "claude" ? claude.cleanupOrphanedClaudeHomes : codex.cleanupOrphanedCodexHomes;
  const recover = engine === "claude" ? claude.recoverInterruptedClaudeAccountRemovals : codex.recoverInterruptedCodexAccountRemovals;
  test.each(["direct", "manager"] as const)(`${engine} %s creation preserves the selection committed while preparing its home`, async entry => {
    const peer = create("Creation peer");
    if (engine === "claude") {
      const capability = path.join(claude.legacyClaudeHome(), "skills", "selection.md");
      fs.mkdirSync(path.dirname(capability), { recursive: true });
      fs.writeFileSync(capability, "selection fixture");
    }
    const setActive = engine === "claude" ? claude.setActiveClaudeAccount : codex.setActiveCodexAccount;
    const active = engine === "claude" ? claude.activeClaudeAccountId : codex.activeCodexAccountId;
    let raced = false;
    const admission = unlockedProbe();
    const race = () => {
      if (!raced) { raced = true; admission.visit(); setActive(peer.id); }
    };
    const copy = fs.copyFileSync;
    const link = fs.symlinkSync;
    const probe = engine === "claude"
      ? spyOn(fs, "copyFileSync").mockImplementation((...args) => { race(); return copy(...args); })
      : spyOn(fs, "symlinkSync").mockImplementation((...args) => { race(); return link(...args); });
    try {
      if (entry === "manager") await accountManager.add(engine, "Prepared account");
      else create("Prepared account");
      expect(raced).toBe(true);
      expect(active()).toBe(peer.id);
      expect(persistedAccountRegistry(engine).accounts).toHaveLength(2);
      admission.check();
    } finally { probe.mockRestore(); }
  });
  test(`${engine} preparation never steals a live engine guard when its work exceeds the stale age`, () => {
    const lock = statePath(`${engine}-accounts.json.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}\n`);
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => create("Guarded account")).toThrow();
    expect(fs.readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });
  for (const action of ["remove", "recover", "cleanup"] as const) {
    test(`${engine} ${action} scans outside the account lease and preserves a racing catalog mutation`, () => {
      const account = create("Archive target");
      const peer = create("Retained peer");
      const setActive = engine === "claude" ? claude.setActiveClaudeAccount : codex.setActiveCodexAccount;
      const active = engine === "claude" ? claude.activeClaudeAccountId : codex.activeCodexAccountId;
      const archive = retiredAccountArchive(engine, account.id);
      const history = path.join(account.home, engine === "claude" ? "projects" : "sessions", "saved.jsonl");
      fs.mkdirSync(path.dirname(history), { recursive: true }); fs.writeFileSync(history, "{}\n");
      if (action !== "remove") {
        const stored = persistedAccountRegistry(engine);
        seedAccountRegistry(engine, { ...stored,
          accounts: stored.accounts.filter((row: { id: string }) => row.id !== account.id),
          retired: [{ id: account.id, label: account.label, retiredAt: 1, ...(action === "recover" ? { archived: true } : {}) }],
          removals: action === "recover" ? [{ id: account.id, phase: "scrubbing", startedAt: 1 }] : [],
        });
        if (action === "recover") { fs.mkdirSync(path.dirname(archive), { recursive: true }); fs.renameSync(account.home, archive); }
      }
      const probe = unlockedProbe();
      const readdir = fs.readdirSync;
      let raced = false;
      const scan = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
        if (String(args[0]).startsWith(account.home) || String(args[0]).startsWith(archive)) {
          probe.visit();
          if (!raced) { raced = true; setActive(peer.id); }
        }
        return readdir(...args);
      }) as typeof fs.readdirSync);
      const leases = trackAccountLeases();
      try {
        if (action === "remove") remove(account.id); else if (action === "recover") recover(); else cleanup();
        expect(active()).toBe(peer.id);
        expect(fs.readFileSync(path.join(archive, path.relative(account.home, history)), "utf8")).toBe("{}\n");
        probe.check();
      } finally {
        scan.mockRestore(); leases.stop();
        console.info(JSON.stringify({ measurement: `${engine} ${action}`, maxHoldMs: Math.max(0, ...leases.holds) }));
      }
    });
  }
}

test("selection discovers credentials outside its commit and rejects a removed prepared account", async () => {
  const account = claude.createManagedClaudeAccount("Selection target");
  fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
  const probe = unlockedProbe();
  const read = credentials.readClaudeCredentials;
  let raced = false;
  const credentialSpy = spyOn(credentials, "readClaudeCredentials").mockImplementation((home, ...args) => {
    probe.visit();
    const result = read(home, ...args);
    if (home === account.home && !raced) { raced = true; claude.removeManagedClaudeAccount(account.id); }
    return result;
  });
  try {
    await expect(selectAccount("claude", account.id)).rejects.toThrow();
    expect(claude.activeClaudeAccountId()).toBe("default");
    expect(agentRegistry().engineRouting("claude").activeAccountId).not.toBe(account.id);
    probe.check();
  } finally { credentialSpy.mockRestore(); }
});

test.each(["claude", "codex"] as const)("%s manager creation waits for a competing account mutation before preparing", async engine => {
  const { withAccountMutationLockAsync } = await import("./accountMutation");
  let enter!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const blocker = withAccountMutationLockAsync(async () => { enter(); await held; });
  await ready;
  let settled = false;
  const adding = accountManager.add(engine, "Queued manager account").then(
    account => { settled = true; return { account, error: undefined }; },
    error => { settled = true; return { account: undefined, error }; },
  );
  try {
    await Bun.sleep(10);
    expect(settled).toBe(false);
    release();
    await blocker;
    const result = await adding;
    expect(result.error).toBeUndefined();
    expect(result.account).toBeDefined();
    expect(persistedAccountRegistry(engine).accounts).toHaveLength(1);
  } finally { release(); await blocker; await adding; }
});
