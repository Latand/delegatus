import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-accounts-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;

process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy-codex");

const { CorruptCodexAccountsError, LOGIN_STARTUP_GRACE_MS, activeCodexAccountId, cleanupOrphanedCodexHomes, codexAccountsRoot, codexLoginPaneStatus, codexSessionRoots, createManagedCodexAccount, listCodexAccounts, removeManagedCodexAccount, setActiveCodexAccount } = await import("./codex");
const { agentRegistry } = await import("@/lib/agent/registry");
const { pathAllowed } = await import("@/lib/scanner/roots");
const { recoverInterruptedCodexAccountRemovals } = await import("./codex");
const { retiredAccountArchive } = await import("./removal");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "accounts"), { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "shared"), { recursive: true, force: true });
});

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("a missing registry safely exposes the legacy account without reading credentials", () => {
  expect(activeCodexAccountId()).toBe("default");
  expect(listCodexAccounts()).toEqual([
    expect.objectContaining({
      id: "default",
      label: "Main",
      kind: "legacy",
      home: path.join(SANDBOX, "legacy-codex"),
      sessionsDir: path.join(SANDBOX, "legacy-codex", "sessions"),
      authPresent: false,
      loginPane: null,
      createdAt: 0,
    }),
  ]);
});

test("a managed overlay shares capabilities while identity and OAuth state stay private", () => {
  const account = createManagedCodexAccount("Work account");
  const shared = ["skills", "prompts", "config.toml", "AGENTS.md", "memories", "rules", path.join("plugins", "cache")];
  for (const relative of shared) {
    expect(fs.lstatSync(path.join(account.home, relative)).isSymbolicLink()).toBe(true);
  }
  for (const relative of ["auth.json", "sessions", "history.jsonl", path.join("plugins", "data"), "mcp-oauth"]) {
    expect(fs.existsSync(path.join(account.home, relative))).toBe(false);
  }
  expect(fs.statSync(account.home).mode & 0o777).toBe(0o700);
});

test("corrupt registry bytes survive rejected mutations", () => {
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  const corrupt = "{ broken registry remains intact";
  fs.writeFileSync(registry, corrupt);

  expect(() => createManagedCodexAccount("Alt")).toThrow(CorruptCodexAccountsError);
  expect(() => setActiveCodexAccount("default")).toThrow(CorruptCodexAccountsError);
  expect(fs.readFileSync(registry, "utf8")).toBe(corrupt);
  expect(listCodexAccounts().map((account) => account.id)).toEqual(["default"]);
});

test("a syntactically valid registry with an unsafe account is also read-only", () => {
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  const unsafe = JSON.stringify({ version: 1, active: "default", accounts: [{ id: "../escape", label: "Escape", kind: "managed", createdAt: 1 }] });
  fs.writeFileSync(registry, unsafe);

  expect(() => createManagedCodexAccount("Alt")).toThrow(CorruptCodexAccountsError);
  expect(() => setActiveCodexAccount("default")).toThrow(CorruptCodexAccountsError);
  expect(fs.readFileSync(registry, "utf8")).toBe(unsafe);
});

test("account creation preserves an occupied home and chooses a safe suffix", () => {
  const occupied = path.join(SANDBOX, "accounts", "codex", "work");
  const auth = path.join(occupied, "auth.json");
  const session = path.join(occupied, "sessions", "sentinel.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(auth, "credential sentinel");
  fs.writeFileSync(session, "session sentinel");

  const account = createManagedCodexAccount("Work");

  expect(account.id).toBe("work-1");
  expect(fs.readFileSync(auth, "utf8")).toBe("credential sentinel");
  expect(fs.readFileSync(session, "utf8")).toBe("session sentinel");
});

test("managed Codex account removal deletes its registry record and home, then cleans safe orphan homes", () => {
  const account = createManagedCodexAccount("Delete me");
  const orphan = path.join(codexAccountsRoot(), "probe-login");
  fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });

  removeManagedCodexAccount(account.id);
  const cleaned = cleanupOrphanedCodexHomes();

  expect(listCodexAccounts().map((item) => item.id)).not.toContain(account.id);
  expect(fs.existsSync(account.home)).toBe(false);
  expect(cleaned).toEqual({ removed: ["probe-login"], unresolved: [] });
  expect(fs.existsSync(orphan)).toBe(false);
});

test("orphan cleanup reports unsafe Codex children for manual recovery", () => {
  const unsafe = path.join(codexAccountsRoot(), "unsafe-orphan");
  const link = path.join(codexAccountsRoot(), "linked-orphan");
  fs.mkdirSync(unsafe, { recursive: true, mode: 0o777 });
  fs.chmodSync(unsafe, 0o777);
  fs.symlinkSync(unsafe, link);

  const result = cleanupOrphanedCodexHomes();

  expect(result.unresolved).toEqual(expect.arrayContaining(["unsafe-orphan", "linked-orphan"]));
  expect(fs.existsSync(unsafe)).toBe(true);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
});

test("orphan cleanup propagates a Codex accounts-root read failure", () => {
  const root = codexAccountsRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const originalRead = fs.readdirSync;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(root)) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return originalRead(target, options as never);
  }) as typeof fs.readdirSync;
  try {
    expect(() => cleanupOrphanedCodexHomes()).toThrow("unreadable");
  } finally {
    fs.readdirSync = originalRead;
  }
});

test("concurrent Codex removal and creation preserve both mutations", async () => {
  const removed = createManagedCodexAccount("Remove child");
  const modulePath = path.join(import.meta.dir, "codex.ts");
  const mutationPath = path.join(import.meta.dir, "accountMutation.ts");
  const remover = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const m = await import(${JSON.stringify(modulePath)});
      const { withAccountMutationLockAsync } = await import(${JSON.stringify(mutationPath)});
      await withAccountMutationLockAsync(async () => m.removeManagedCodexAccount(${JSON.stringify(removed.id)}));
    `],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CODEX_HOME: process.env.LLV_CODEX_HOME! },
    stdout: "ignore", stderr: "pipe",
  });
  const creator = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const m = await import(${JSON.stringify(modulePath)});
      const { withAccountMutationLockAsync } = await import(${JSON.stringify(mutationPath)});
      await withAccountMutationLockAsync(async () => m.createManagedCodexAccount("Created child"));
    `],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CODEX_HOME: process.env.LLV_CODEX_HOME! },
    stdout: "ignore", stderr: "pipe",
  });

  expect(await remover.exited).toBe(0);
  expect(await creator.exited).toBe(0);
  expect(listCodexAccounts().map((item) => item.id)).toContain("created-child");
  expect(listCodexAccounts().map((item) => item.id)).not.toContain(removed.id);
});

test("a shell during login startup grace remains pending", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, { windowName: "codex-login", command: "zsh" }, startedAt + LOGIN_STARTUP_GRACE_MS - 1)).toEqual({ state: "pending", clear: false });
});

test("a shell after login startup grace becomes idle", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, { windowName: "codex-login", command: "zsh" }, startedAt + LOGIN_STARTUP_GRACE_MS)).toEqual({ state: "idle", clear: true });
});

test("a transient missing pane during startup grace stays pending", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, null, startedAt + LOGIN_STARTUP_GRACE_MS - 1)).toEqual({ state: "pending", clear: false });
});

test("a missing pane at the grace deadline becomes idle and clears", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, null, startedAt + LOGIN_STARTUP_GRACE_MS)).toEqual({ state: "idle", clear: true });
});

test("a missing pane past the grace deadline becomes idle and clears", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, null, startedAt + LOGIN_STARTUP_GRACE_MS + 60_000)).toEqual({ state: "idle", clear: true });
});

test("a pane whose window no longer matches is a different pane and clears immediately", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, { windowName: "other", command: "codex" }, startedAt + 1)).toEqual({ state: "idle", clear: true });
});

test("legacy pane records without a timestamp remain readable", () => {
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ version: 1, active: "work", accounts: [{ id: "work", label: "Work", kind: "managed", createdAt: 1, loginPane: { paneId: "%4", windowName: "codex-login" } }] }));

  expect(listCodexAccounts().find((account) => account.id === "work")?.loginPane).toEqual({ paneId: "%4", windowName: "codex-login", startedAt: 0 });
});

/* ---- #1857: removal moves the whole home into the shared archive ---- */

const ROLLOUT_ID = ["019f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const STRAY_ID = ["019f4906", "3f67", "7b72", "9fbc", "000000000001"].join("-");
const DAY = path.join("sessions", "2026", "09", "01");
const CODEX_LEFTOVERS: Record<string, string> = {
  [path.join(DAY, `rollout-2026-09-01T00-00-00-${ROLLOUT_ID}.jsonl`)]: "{\"type\":\"session_meta\"}\n",
  [path.join(DAY, `rollout-2026-09-01T01-00-00-${STRAY_ID}.jsonl`)]: "{\"type\":\"session_meta\",\"stray\":true}\n",
  [path.join(DAY, `rollout-2026-09-01T00-00-00-${ROLLOUT_ID}.json`)]: "{}\n",
  "state_5.sqlite": "sqlite bytes",
  "state_5.sqlite-wal": "wal bytes",
  "state_5.sqlite-shm": "shm bytes",
  [path.join("log", "codex-tui.log")]: "tui log\n",
  "history.jsonl": "{\"text\":\"prompt\"}\n",
  "installation_id": "invented-installation\n",
  [path.join("plugins", ".remote-plugin-install-staging", "pkg", "manifest.json")]: "{}\n",
};
const GROUP_WRITABLE = path.join("plugins", ".remote-plugin-install-staging", "pkg", "manifest.json");

/** A home shaped like the operator's Codex D: registered and stray rollouts,
    provider SQLite with WAL/SHM, logs, and group-writable plugin staging. */
function usedCodexHome(label: string) {
  const account = createManagedCodexAccount(label);
  for (const [relative, contents] of Object.entries(CODEX_LEFTOVERS)) {
    fs.mkdirSync(path.dirname(path.join(account.home, relative)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(account.home, relative), contents, { mode: 0o600 });
  }
  fs.chmodSync(path.join(account.home, GROUP_WRITABLE), 0o664);
  fs.writeFileSync(path.join(account.home, "auth.json"), "{}", { mode: 0o600 });
  const rollout = path.join(account.home, DAY, `rollout-2026-09-01T00-00-00-${ROLLOUT_ID}.jsonl`);
  const conversation = agentRegistry().ensureConversation("codex", rollout, account.id);
  return { account, rollout, conversation, archive: retiredAccountArchive("codex", account.id) };
}

function codexRegistryJson(): { removals?: unknown[]; retired: Array<{ id: string; archived?: boolean }> } {
  return JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json"), "utf8"));
}

test("a used Codex home is removed and every rollout stays readable in the shared archive (#1857)", () => {
  const fixture = usedCodexHome("Invented Delta");

  const removal = removeManagedCodexAccount(fixture.account.id);

  const bytes = Object.values(CODEX_LEFTOVERS).reduce((sum, contents) => sum + Buffer.byteLength(contents), 0);
  expect(removal).toEqual({
    archive: fixture.archive,
    files: Object.keys(CODEX_LEFTOVERS).length,
    bytes,
    conversationsRewritten: 1,
    pinsCleared: 0,
    deliveriesDropped: 0,
    migrationsSettled: 0,
    cleanupPending: false,
  });
  expect(fs.existsSync(fixture.account.home)).toBe(false);
  for (const [relative, contents] of Object.entries(CODEX_LEFTOVERS)) {
    expect(fs.readFileSync(path.join(fixture.archive, relative), "utf8")).toBe(contents);
  }
  expect(fs.statSync(path.join(fixture.archive, GROUP_WRITABLE)).mode & 0o777).toBe(0o664);
  for (const name of ["auth.json", "skills", "prompts", "config.toml", "AGENTS.md", "memories", "rules", path.join("plugins", "cache")]) {
    expect(() => fs.lstatSync(path.join(fixture.archive, name))).toThrow();
  }
  const moved = path.join(fixture.archive, path.relative(fixture.account.home, fixture.rollout));
  expect(agentRegistry().readOnlySnapshot().conversations[fixture.conversation.id]!.generations[0]!.path).toBe(moved);
  // The scanner reads the archive, and /api/log admits both archived rollouts.
  expect(codexSessionRoots()).toContain(path.join(fixture.archive, "sessions"));
  expect(pathAllowed(moved)).toBe(true);
  expect(pathAllowed(path.join(fixture.archive, DAY, `rollout-2026-09-01T01-00-00-${STRAY_ID}.jsonl`))).toBe(true);
  expect(pathAllowed(path.join(fixture.archive, "history.jsonl"))).toBe(false);
  expect(listCodexAccounts().map((item) => item.id)).not.toContain(fixture.account.id);
  expect(codexRegistryJson().retired).toContainEqual(expect.objectContaining({ id: fixture.account.id, archived: true }));
  expect(codexRegistryJson().removals ?? []).toEqual([]);
});

test("an existing Codex archive destination refuses removal and leaves the home untouched", () => {
  const fixture = usedCodexHome("Invented Taken");
  fs.mkdirSync(fixture.archive, { recursive: true, mode: 0o700 });

  expect(() => removeManagedCodexAccount(fixture.account.id)).toThrow("archive destination already exists");

  expect(fs.readdirSync(fixture.archive)).toEqual([]);
  expect(fs.readFileSync(fixture.rollout, "utf8")).toBe("{\"type\":\"session_meta\"}\n");
  expect(fs.existsSync(path.join(fixture.account.home, "auth.json"))).toBe(true);
  expect(listCodexAccounts().map((item) => item.id)).toContain(fixture.account.id);
  expect(codexRegistryJson().removals ?? []).toEqual([]);
});

async function crashCodexRemovalAt(accountId: string, checkpoint: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "fixtures", "accountRemovalCrash.ts"), "codex", accountId, checkpoint],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CODEX_HOME: process.env.LLV_CODEX_HOME! },
    stdout: "ignore",
    stderr: "pipe",
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
}

for (const checkpoint of ["journaled", "renamed"] as const) {
  test(`a Codex removal killed after "${checkpoint}" puts the home and its registry paths back`, async () => {
    const fixture = usedCodexHome(`Invented Crash ${checkpoint}`);
    await crashCodexRemovalAt(fixture.account.id, checkpoint);
    expect(codexRegistryJson().removals).toHaveLength(1);

    expect(recoverInterruptedCodexAccountRemovals()).toEqual({ recovered: [fixture.account.id], unresolved: [] });

    expect(fs.readFileSync(fixture.rollout, "utf8")).toBe("{\"type\":\"session_meta\"}\n");
    expect(fs.existsSync(path.join(fixture.account.home, "auth.json"))).toBe(true);
    expect(fs.existsSync(fixture.archive)).toBe(false);
    expect(agentRegistry().readOnlySnapshot().conversations[fixture.conversation.id]!.generations[0]!.path).toBe(fixture.rollout);
    expect(listCodexAccounts().map((item) => item.id)).toContain(fixture.account.id);
    expect(codexRegistryJson().removals ?? []).toEqual([]);
  });
}

test("a Codex removal killed after the agent registry retired the account completes on recovery", async () => {
  const fixture = usedCodexHome("Invented Crash retired");
  const store = agentRegistry();
  store.setConversationMigration(fixture.conversation.id, {
    intentId: "intent-parked",
    phase: "failed-recoverable",
    targetId: "default",
    revision: 1,
    error: "successor never verified",
    updatedAt: new Date().toISOString(),
  });
  const delivery = store.holdDelivery(fixture.conversation.id, "owed on the removed account");
  store.setEngineRouting("codex", fixture.account.id);
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  raw.conversations[fixture.conversation.id].pinnedAccountId = fixture.account.id;
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  await crashCodexRemovalAt(fixture.account.id, "registry-retired");
  expect(codexRegistryJson().removals).toHaveLength(1);

  expect(recoverInterruptedCodexAccountRemovals()).toEqual({ recovered: [fixture.account.id], unresolved: [] });

  // The retirement the crash interrupted is finished, never half undone.
  expect(listCodexAccounts().map((item) => item.id)).not.toContain(fixture.account.id);
  expect(fs.existsSync(fixture.account.home)).toBe(false);
  expect(fs.existsSync(path.join(fixture.archive, "auth.json"))).toBe(false);
  const moved = path.join(fixture.archive, path.relative(fixture.account.home, fixture.rollout));
  expect(fs.readFileSync(moved, "utf8")).toBe("{\"type\":\"session_meta\"}\n");
  const snapshot = agentRegistry().readOnlySnapshot();
  const conversation = snapshot.conversations[fixture.conversation.id]!;
  expect(conversation.generations[0]!.path).toBe(moved);
  expect(conversation.pinnedAccountId ?? null).toBeNull();
  expect(conversation.migration).toBeNull();
  expect(snapshot.heldDeliveries[delivery.id]?.state).toBe("failed");
  expect(snapshot.engineRouting.codex.activeAccountId).toBe("default");
  expect(codexRegistryJson().retired).toEqual([expect.objectContaining({ id: fixture.account.id, archived: true })]);
  expect(codexRegistryJson().removals ?? []).toEqual([]);
});

test("a Codex removal killed after the accounts registry committed finishes on recovery", async () => {
  const fixture = usedCodexHome("Invented Crash committed");
  await crashCodexRemovalAt(fixture.account.id, "accounts-committed");
  expect(fs.existsSync(path.join(fixture.archive, "auth.json"))).toBe(true);

  expect(recoverInterruptedCodexAccountRemovals()).toEqual({ recovered: [fixture.account.id], unresolved: [] });

  expect(fs.existsSync(path.join(fixture.archive, "auth.json"))).toBe(false);
  expect(() => fs.lstatSync(path.join(fixture.archive, "skills"))).toThrow();
  const moved = path.join(fixture.archive, path.relative(fixture.account.home, fixture.rollout));
  expect(fs.readFileSync(moved, "utf8")).toBe("{\"type\":\"session_meta\"}\n");
  expect(listCodexAccounts().map((item) => item.id)).not.toContain(fixture.account.id);
  expect(codexRegistryJson().removals ?? []).toEqual([]);
});

test("the first account listing in a restarted Viewer recovers an interrupted removal", async () => {
  const fixture = usedCodexHome("Invented Restart");
  await crashCodexRemovalAt(fixture.account.id, "renamed");
  expect(fs.existsSync(fixture.account.home)).toBe(false);

  const restarted = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const m = await import(${JSON.stringify(path.join(import.meta.dir, "codex.ts"))});
      console.log(JSON.stringify(m.listCodexAccounts().map((account) => account.id)));
    `],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CODEX_HOME: process.env.LLV_CODEX_HOME! },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await restarted.exited).toBe(0);

  expect(JSON.parse(await new Response(restarted.stdout).text())).toContain(fixture.account.id);
  expect(fs.readFileSync(fixture.rollout, "utf8")).toBe("{\"type\":\"session_meta\"}\n");
  expect(agentRegistry().readOnlySnapshot().conversations[fixture.conversation.id]!.generations[0]!.path).toBe(fixture.rollout);
  expect(codexRegistryJson().removals ?? []).toEqual([]);
});
